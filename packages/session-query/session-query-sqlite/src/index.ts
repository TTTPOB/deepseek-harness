/**
 * Concrete session-query service with SQLite FTS5 over the live-preferred corpus.
 *
 * @module @deepseek-ai/dsh-session-query-sqlite
 */

import { randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import {
  type JournalMode,
  openSearchDatabase,
} from './schema.ts'
import {
  type NormalizedEventRequest,
  type NormalizedSessionRequest,
  FTS_HIGHLIGHT_END,
  FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount,
  assertPortableBindingCount,
  buildEventWhere,
  buildSessionWhere,
  makeSnippet,
  normalizeEventRequest,
  normalizeSessionRequest,
  quoteFtsData,
  requestFingerprint,
  sanitizeFtsText,
  SQLITE_MAX_PAGE_LIMIT,
} from './query.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

/** Boot-context slot for a launcher-owned absolute path to this process's derived query index. */
export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

/** Default result page size. */
export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20
/** Maximum accepted result page size. */
export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100
/** Default maximum snippet length in Unicode code points. */
export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240
/** Default largest persisted log artifact, in bytes, that one index build reads. */
export const SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES = 32 * 1024 * 1024

// One transient source replacement gets a retry; a flapping service fails rather than monopolizing the queue.
const SOURCE_REPLACEMENT_ATTEMPTS = 2

/** SQLite module/handle opening phase; `never` disables full-text search entirely. */
export type OpenAt = 'startup' | 'first-search' | 'never'

/** Combined session-query configuration backed by SQLite full-text search. */
export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log reads in one inherited batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /** Maximum cold prepared-Session observations the inherited reader retains for reuse. Defaults to 5. */
  preparedSessionCacheSize?: number
  /**
   * Largest persisted log artifact, in bytes, this index reads into memory.
   * Sessions above it stay out of full-text search and are reported once
   * through `ctx.logger.warn`; a backend that omits
   * `SessionPersistenceSnapshot.sizeBytes` is indexed without this bound.
   * Defaults to 32 MiB.
   */
  maxIndexedSessionBytes?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
  maxIndexedSessionBytes: number
}

interface ObservedSession {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  documents: SessionEventSearchDocument[]
}

interface ObservedLiveSession extends ObservedSession {
  fingerprint: string
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  /** Physical artifact size the persistence snapshot reported, when the backend provides it. */
  sizeBytes?: number
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  /** Stored snapshots observed this round; also the header source for live/durable checks. */
  persisted: Map<SessionId, ObservedPersistedSession>
  /** Stored sessions the index may serve after this round. */
  members: Set<SessionId>
  /** Persisted rows this round proved gone from storage or excluded by the size bound. */
  removed: Set<SessionId>
  /** Live projections applied this round. */
  live: Map<SessionId, ObservedLiveSession>
  /** Session ids that must keep a live row after this round. */
  livePresent: Set<SessionId>
  /** Dirty epochs captured when this observation started. */
  liveEpochs: Map<SessionId, number>
  storedEpochs: Map<SessionId, number>
  /** Closing sessions whose live rows this round retires. */
  closed: Set<SessionId>
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

/**
 * SQLite owner of `ctx.sessionQuery`, refreshed by local session lifecycle notifications.
 * External persisted-file edits are discovered on the first search after service restart or source replacement.
 */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedReadConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
    preparedSessionCacheSize: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    maxIndexedSessionBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _optionalPersistenceFiber: Fiber
  private readonly _warnedSkips = new Set<string>()
  /** Live sessions whose projection may be stale: every lifecycle notification bumps its epoch. */
  private readonly _dirtyLive = new Map<SessionId, number>()
  /** Stored sessions needing re-observation: their own handoff or a related child's change. */
  private readonly _dirtyStored = new Map<SessionId, number>()
  /** Final in-memory projections of disposed sessions whose stored handoff is still pending. */
  private readonly _closing = new Map<SessionId, ObservedLiveSession>()
  /** Whether routed session events may still be draining into storage behind us. */
  private _writesPending = false
  private _lifecycleEpoch = 0

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    // Dirty tracking observes the session lifecycle in place of per-search
    // corpus enumeration; `never` deployments observe nothing at all.
    if (this.config.openAt !== 'never') {
      ctx.on('session/created', (session: Session) => {
        this._noteLifecycle(session, false)
      }, { global: true })
      ctx.on('session/event', (session: Session) => {
        this._noteLifecycle(session, true)
      }, { global: true })
      ctx.on('session/flush', (session: Session) => {
        this._noteLifecycle(session, true)
      }, { global: true })
      ctx.on('session/disposed', (session: Session) => {
        this._noteSessionDisposed(session)
      }, { global: true })
    }
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this._ensureReady(undefined)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const generation = String(this._globalGeneration)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _close(): Promise<void> {
    this._closed = true
    await this._tail
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    this._db = await openSearchDatabase(this.config.path, this.config.journalMode)
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._open()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
    const liveRows = db.prepare(
      'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedLiveRow[]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))

    const baseGeneration = this._mainGeneration()
    // The commit callback runs inside observation, so the state it advances
    // is held on one mutable object the caller can still read afterwards.
    const staged: { generation: number; commits: number; wrote: boolean } = {
      generation: baseGeneration,
      commits: 0,
      wrote: false,
    }
    let durableGeneration = 0
    // Every changed persisted session commits in its own transaction, so a first
    // build over a large history never retains every extracted document at once.
    // All of them carry the same advanced generation, so a build that stops early
    // still invalidates cursors taken over the older corpus.
    const committed = new Set<SessionId>()
    const commitPersisted = (entry: ObservedPersistedSession, observed: ObservedSession): void => {
      if (staged.commits === 0) staged.generation = baseGeneration + 1
      this._commitPersistedSession(observed, entry.revision, staged.generation)
      staged.commits += 1
      staged.wrote = true
      committed.add(entry.header.id)
    }
    let observation: Observation
    try {
      observation = await this._observeDirty(persistedById, signal, commitPersisted)
    } catch (error: unknown) {
      if (staged.wrote) this._retireGeneration(staged.generation)
      throw error
    }
    assertNotAborted(signal)
    // Removed and oversized sessions cannot retain stale searchable rows.
    const indexedIds = new Set<SessionId>(persistedRows.map(row => row.id as SessionId))
    for (const id of committed) indexedIds.add(id)
    const persistentDeletes = observation.persistenceBinding.service === undefined
      ? []
      : [...indexedIds].filter(id => observation.removed.has(id))
    if (staged.commits > 0) durableGeneration = staged.generation
    if (persistentDeletes.length > 0) {
      staged.generation = Math.max(staged.generation, baseGeneration + 1)
      durableGeneration = Math.max(durableGeneration, staged.generation)
      staged.wrote = true
    }
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.members.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.livePresent.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== observation.persistenceBinding.identity

    let nextLocalGeneration = this._localGeneration
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, staged.generation) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.members.has(entry.header.id),
      }
    })

    const hasWrites = persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0
    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const id of persistentDeletes) this._deleteSession('persisted', id)
        if (persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(staged.generation)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
        db.exec('COMMIT')
        durableGeneration = Math.max(durableGeneration, staged.generation)
        staged.wrote = true
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        if (staged.wrote) this._retireGeneration(durableGeneration)
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (staged.wrote || pointerChanged) this._retireGeneration(durableGeneration)
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = observation.persistenceBinding.identity
    // Dirty entries survive unless this accepted round saw them unchanged: a
    // notification during observation re-dirties the id for the next search.
    for (const [id, epoch] of observation.liveEpochs) {
      if (this._dirtyLive.get(id) === epoch) this._dirtyLive.delete(id)
    }
    for (const [id, epoch] of observation.storedEpochs) {
      if (this._dirtyStored.get(id) === epoch) this._dirtyStored.delete(id)
    }
    for (const id of observation.closed) {
      if (!this._dirtyLive.has(id)) this._closing.delete(id)
    }
    return observation.persistenceBinding
  }

  private _bumpDirty(target: Map<SessionId, number>, id: SessionId): void {
    target.set(id, ++this._lifecycleEpoch)
  }

  private _noteLifecycle(session: Session, writes: boolean): void {
    this._bumpDirty(this._dirtyLive, session.id)
    this._bumpDirty(this._dirtyStored, session.id)
    if (session.header.origin === 'subagent' && session.header.parentSession !== undefined) {
      this._bumpDirty(this._dirtyStored, session.header.parentSession)
    }
    this._writesPending ||= writes
  }

  private _noteSessionDisposed(session: Session): void {
    this._noteLifecycle(session, true)
    if (this._persistenceBinding.service !== undefined) {
      this._closing.set(session.id, observeLive(session, this._lifecycleEpoch))
    }
  }

  /** Observe startup membership once, then only lifecycle-dirty sessions. */
  private async _observeDirty(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
    commit: (entry: ObservedPersistedSession, observed: ObservedSession) => void,
  ): Promise<Observation> {
    for (let attempt = 0; attempt < SOURCE_REPLACEMENT_ATTEMPTS; attempt += 1) {
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const full = this._lastPersistenceIdentity !== persistenceBinding.identity
      const liveEpochs = new Map(this._dirtyLive)
      const storedEpochs = new Map(this._dirtyStored)
      const members = new Set(indexed.keys())
      const removed = new Set<SessionId>()
      const closed = new Set<SessionId>()
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      try {
        if (persistence !== undefined) {
          if (this._writesPending) {
            this._writesPending = false
            try { await persistence.flush() } catch (error) {
              this._writesPending = true
              throw error
            }
          }
          const options = signal === undefined ? undefined : { signal }
          if (full) {
            persisted = materializePersistenceSnapshots(await persistence.list(options))
            for (const id of indexed.keys()) {
              if (!persisted.has(id)) { members.delete(id); removed.add(id) }
            }
          } else {
            for (const id of storedEpochs.keys()) {
              assertNotAborted(signal)
              const snapshot = await persistence.stat(id, options)
              if (snapshot === undefined) { members.delete(id); removed.add(id) }
              else {
                for (const [key, entry] of materializePersistenceSnapshots([snapshot])) persisted.set(key, entry)
              }
            }
          }
          for (const entry of persisted.values()) {
            assertNotAborted(signal)
            const id = entry.header.id
            members.add(id)
            if (this.ctx.sessions.get(id) !== undefined) continue
            if (entry.sizeBytes !== undefined && entry.sizeBytes > this.config.maxIndexedSessionBytes) {
              this._noteSkippedSession(entry, entry.sizeBytes)
              members.delete(id)
              removed.add(id)
              closed.add(id)
              continue
            }
            const reuse = (this._lastPersistenceIdentity === undefined && attempt === 0)
              || this._lastPersistenceIdentity === persistenceBinding.identity
            if (!reuse || indexed.get(id)?.revision !== entry.revision) {
              const loaded = await readColdSessionLog(persistence, id, signal)
              assertNotAborted(signal)
              assertSessionHeadersCompatible(entry.header, loaded.header)
              commit(entry, observeSession(loaded.header, loaded.inheritedEventCount, loaded.events))
            }
            closed.add(id)
          }
        }
        assertNotAborted(signal)
        if (this._persistenceBinding !== persistenceBinding) continue
        const live = new Map<SessionId, ObservedLiveSession>()
        const livePresent = new Set<SessionId>()
        for (const session of this.ctx.sessions.list()) {
          livePresent.add(session.id)
          if (full || liveEpochs.has(session.id)) {
            const observed = observeLive(session, liveEpochs.get(session.id) ?? 0)
            const durable = persisted.get(session.id)
            if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
            live.set(session.id, observed)
          }
        }
        for (const [id, observed] of this._closing) {
          if (livePresent.has(id)) continue
          if (closed.has(id) || removed.has(id)) { closed.add(id); continue }
          livePresent.add(id)
          live.set(id, observed)
        }
        if (this._persistenceBinding !== persistenceBinding) continue
        return { persistenceBinding, persisted, members, removed, live, livePresent,
          liveEpochs, storedEpochs, closed }
      } catch (error: unknown) {
        if (isAbort(error) || signal?.aborted) throw new SessionQueryError(
          'session-search aborted', 'SESSION_QUERY_ABORTED', { cause: error })
        if (this._persistenceBinding !== persistenceBinding) continue
        if (error instanceof SessionQueryError) throw error
        throw new SessionQueryError(
          `session-search persistence observation failed: ${errorMessage(error)}`, 'SESSION_QUERY_PERSISTENCE_FAILED', { cause: error })
      }
    }
    throw new SessionQueryError('session-search persistence source changed after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED')
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version, created_at=excluded.created_at,
        cwd=excluded.cwd, parent_session=excluded.parent_session, seed_length=excluded.seed_length,
        delegation_depth=excluded.delegation_depth, agent_preset=excluded.agent_preset,
        revision=excluded.revision, generation=excluded.generation
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      revision,
      generation,
    )
    this._upsertDocuments('persisted', entry)
  }

  private _replaceLiveSession(entry: ObservedLiveSession, generation: number, persisted: boolean): void {
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version, created_at=excluded.created_at,
        cwd=excluded.cwd, parent_session=excluded.parent_session, seed_length=excluded.seed_length,
        delegation_depth=excluded.delegation_depth, agent_preset=excluded.agent_preset,
        fingerprint=excluded.fingerprint, persisted=excluded.persisted, generation=excluded.generation
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      entry.fingerprint,
      persisted ? 1 : 0,
      generation,
    )
    this._upsertDocuments('live', entry)
  }

  private _upsertDocuments(source: 'persisted' | 'live', entry: ObservedSession): void {
    const db = this._requireDb()
    const table = source === 'live' ? 'temp.live_docs' : 'persisted_docs'
    const rows = db.prepare('SELECT rowid, seq, text, type, time, surface FROM ' + table
      + ' WHERE session_id = ?').all(entry.header.id) as Array<{
      rowid: number
      seq: number
      text: string
      type: string
      time: number
      surface: string
    }>
    const existing = new Map(rows.map(row => [row.seq, row]))
    const insert = db.prepare('INSERT INTO ' + table
      + ' (text, session_id, seq, type, time, surface, codepoint_length) VALUES (?, ?, ?, ?, ?, ?, ?)')
    const update = db.prepare('UPDATE ' + table
      + ' SET text=?, type=?, time=?, surface=?, codepoint_length=? WHERE rowid=?')
    const remove = db.prepare('DELETE FROM ' + table + ' WHERE rowid=?')
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      const row = existing.get(document.seq)
      existing.delete(document.seq)
      if (row === undefined) {
        insert.run(text, document.sessionId, document.seq, document.type,
          document.time, document.surface, Array.from(text).length)
      } else if (row.text !== text || row.type !== document.type
        || row.time !== document.time || row.surface !== document.surface) {
        update.run(text, document.type, document.time, document.surface, Array.from(text).length, row.rowid)
      }
    }
    for (const row of existing.values()) remove.run(row.rowid)
  }

  /**
   * Commit one changed persisted session together with the main generation it
   * advanced to, so a large first build keeps durable progress instead of one
   * all-or-nothing transaction.
   * @param entry - the observed session to index.
   * @param revision - the persistence revision the observation came from.
   * @param generation - the main generation the committed corpus claims.
   */
  private _commitPersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    const db = this._requireDb()
    let began = false
    try {
      db.exec('BEGIN IMMEDIATE')
      began = true
      this._replacePersistedSession(entry, revision, generation)
      db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(generation)
      db.exec('COMMIT')
    } catch (error: unknown) {
      /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
      if (began) {
        /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
        try {
          db.exec('ROLLBACK')
        } catch {
          // The original SQLite failure remains the actionable cause.
        }
      }
      throw new SessionQueryError(
        `session-search reconciliation failed: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  /** Advance the in-memory cursor generation past a durable write, even when reconciliation then fails. */
  private _retireGeneration(generation: number): void {
    this._globalGeneration = Math.max(this._globalGeneration + 1, generation)
  }

  /** Report and remember one oversized session, so it is never held out of search silently. */
  private _noteSkippedSession(entry: ObservedPersistedSession, sizeBytes: number): void {
    const observed = `${entry.header.id}:${entry.revision}`
    if (this._warnedSkips.has(observed)) return
    this._warnedSkips.add(observed)
    this.ctx.logger.warn(
      `session search: session "${entry.header.id}" stores ${String(sizeBytes)} bytes, above maxIndexedSessionBytes (${String(this.config.maxIndexedSessionBytes)}); its history stays out of full-text search until the limit is raised`,
    )
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (persistenceBinding.service !== undefined) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: SessionSeq(row.seq),
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

/**
 * The header columns both session upserts bind, in the order their INSERT
 * lists them. The two statements differ only in what they append after these.
 * @param header - the session header being written.
 * @returns one bound value per header column.
 */
function headerBindings(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.isSeeded ? inheritedEventCount : null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function selectedDocumentsSql(): { sql: string } {
  return {
    sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`,
  }
}

function selectedDocumentsParams(query: string, persistenceVisible: boolean): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    FTS_HIGHLIGHT_START,
    Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8'),
  ]
}

function observeLive(session: Session, epoch: number): ObservedLiveSession {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const observed = observeSession(session.header, session.inheritedEventCount, session.snapshotEvents())
  return { ...observed, fingerprint: String(epoch) }
}

/**
 * Project one complete event log into a detached header and its searchable
 * documents. Event values are read here and never retained, so the caller's
 * array needs no defensive copy; the header is cloned because callers keep it
 * past the read handle that produced it.
 * @param header - the session header to detach.
 * @param inheritedEventCount - exact fork-inherited event count paired with `header`.
 * @param events - complete contiguous event log.
 * @returns the observation shared by live and persisted sources.
 */
function observeSession(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffset,
  events: readonly SessionEvent[],
): ObservedSession {
  const detachedHeader = structuredClone(header)
  return {
    header: detachedHeader,
    inheritedEventCount,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, events),
  }
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, snapshot.sizeBytes === undefined
      ? { header, revision: snapshot.revision }
      : { header, revision: snapshot.revision, sizeBytes: snapshot.sizeBytes })
  }
  return result
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    isSeeded: row.seed_length !== null,
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function decodeCursor(
  cursor: SessionSearchCursorValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
    maxIndexedSessionBytes: config.maxIndexedSessionBytes
      ?? SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedReadConcurrency)
    || resolved.persistedReadConcurrency < 1
  ) {
    throw invalidConfig('persistedReadConcurrency must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.preparedSessionCacheSize)
    || resolved.preparedSessionCacheSize < 1
  ) {
    throw invalidConfig('preparedSessionCacheSize must be a positive safe integer')
  }
  if (
    !Number.isSafeInteger(resolved.maxIndexedSessionBytes)
    || resolved.maxIndexedSessionBytes < 1
  ) {
    throw invalidConfig('maxIndexedSessionBytes must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine

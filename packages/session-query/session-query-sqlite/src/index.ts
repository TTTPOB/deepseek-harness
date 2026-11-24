/** SQLite-backed session search with service-owned, resumable worker warmup. */

import { resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { Config as JsonlConfig } from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocumentsBatched,
  readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type {
  Config as SessionQueryConfig,
  SessionEventSearchPage, SessionEventSearchRequest, SessionSearchExecContext,
  SessionSearchHit, SessionSearchPage, SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import type { JournalMode, Synchronous } from './schema.ts'
import { normalizeEventRequest, normalizeSessionRequest, SQLITE_MAX_PAGE_LIMIT } from './query.ts'
import { SearchWorker } from './worker-client.ts'

export {
  SESSION_QUERY_SQLITE_APPLICATION_ID,
  SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID,
  SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
  type Synchronous,
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
   * Dedicated document-key sidecar path, attached to the index connection so
   * per-session document lookups use an ordinary B-tree index while the
   * main index file keeps the upstream schema. `:memory:` is supported.
   * Defaults to `<path>.keys.db`, or `:memory:` when `path` is `:memory:`.
   * The sidecar is derived from the main index and rebuilt when stale.
   */
  keysPath?: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** Cross-session warmup wait in milliseconds, from 0 (no wait) to 2,147,483,647. Defaults to 3000. */
  warmupWaitMs?: number
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** SQLite synchronous mode; NORMAL is honored only with WAL. Defaults to FULL. */
  synchronous?: Synchronous
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
  keysPath: string
  openAt: OpenAt
  warmupWaitMs: number
  journalMode: JournalMode
  synchronous: Synchronous
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedReadConcurrency: number
  preparedSessionCacheSize: number
  metadataCacheTtlMs: number
  sessionPageSnapshotTtlMs: number
  sessionPageSnapshotCapacity: number
  maxIndexedSessionBytes: number
}

const SCAN_BATCH_SIZE = 32
const DEFAULT_WARMUP_WAIT_MS = 3000
const MAX_WARMUP_WAIT_MS = 2_147_483_647

interface Binding {
  readonly epoch: number
  readonly source?: SessionPersistence
  readonly jsonl?: JsonlConfig
  readonly reuseDisk: boolean
  readonly controller: AbortController
  readonly jobs: Map<SessionId, Promise<void>>
  readonly points: Set<SessionId>
  bound?: Promise<undefined>
  warm?: Promise<SessionQueryError | undefined>
  ready: boolean
  failure?: SessionQueryError
}

/** Host service for point and global search over live and persisted sessions. */
export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    keysPath: z.string(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    warmupWaitMs: z.number().step(1).min(0).max(MAX_WARMUP_WAIT_MS).default(DEFAULT_WARMUP_WAIT_MS),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    synchronous: z.union(['full', 'normal'] as const).default('full'),
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
    metadataCacheTtlMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(5000),
    sessionPageSnapshotTtlMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(60000),
    sessionPageSnapshotCapacity: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(8),
    maxIndexedSessionBytes: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private binding: Binding = newBinding(0, true)
  private seenSource = false
  private worker?: SearchWorker
  private opening?: Promise<void>
  private keyBuild?: Promise<void>
  private keysReady = false
  private closed = false
  private closing?: Promise<void>
  private readonly optionalPersistenceFiber: Fiber
  private readonly dirty = new Map<SessionId, number>()

  private readonly warnedSkips = new Set<string>()
  private lifecycleEpoch = 0
  private writesPending = false
  private flushing?: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this.optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const accepted = this.replaceSource(childCtx.sessionPersistence)
      childCtx.effect(() => () => {
        if (this.binding === accepted && !this.closed) this.replaceSource()
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => async () => {
      await this.close()
      await this.optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.close')
    if (this.config.openAt === 'never') return
    ctx.on('session/created', session => this.noteLifecycle(session, false), { global: true })
    ctx.on('session/event', session => this.noteLifecycle(session, true), { global: true })
    ctx.on('session/flush', session => this.noteLifecycle(session, true), { global: true })
    ctx.on('session/disposed', session => this.noteLifecycle(session, true), { global: true })
    for (const session of ctx.sessions.list()) this.noteLifecycle(session, false)
  }

  /** Startup waits for the handle to open, not for historical warmup to finish. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt !== 'startup') return
    this.start()
    await this.opening
  }

  override async searchSessions(
    request: SessionSearchRequest, exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this.assertEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    assertNotAborted(signal)
    const binding = this.start()
    if (!binding.ready) {
      const { warmupWaitMs } = this.config
      const failure = binding.failure ?? (binding.warm !== undefined && warmupWaitMs > 0
        ? await waitForWarmup(binding.warm, warmupWaitMs, signal)
        : undefined)
      assertNotAborted(signal)
      this.assertBinding(binding)
      if (failure !== undefined) {
        delete binding.failure
        throw failure
      }
      if (!binding.ready) throw warming()
    }
    for (const id of [...this.dirty.keys()]) {
      await waitWithAbort(this.refresh(binding, id), signal)
    }
    assertNotAborted(signal)
    this.assertBinding(binding)
    return waitWithAbort(this.requireWorker().call({
      kind: 'sessions', epoch: binding.epoch, request: normalized, persisted: binding.source !== undefined,
    }), signal)
  }

  override async searchEvents(
    request: SessionEventSearchRequest, exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this.assertEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    assertNotAborted(signal)
    const binding = this.start()
    await waitWithAbort(this.opening ?? Promise.resolve(), signal)
    if (!this.keysReady) throw warming()
    await waitWithAbort(this.bind(binding), signal)
    this.assertBinding(binding)
    const id = normalized.sessionId
    if (!binding.ready || this.dirty.has(id)) {
      if (!binding.ready) binding.points.add(id)
      await waitWithAbort(this.refresh(binding, id), signal)
    }
    assertNotAborted(signal)
    this.assertBinding(binding)
    return waitWithAbort(this.requireWorker().call({
      kind: 'events', epoch: binding.epoch, request: normalized, persisted: binding.source !== undefined,
    }), signal)
  }

  /** Stop accepted work and release the worker connection. */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.closed = true
    this.binding.controller.abort()

    this.closing = this.worker?.close() ?? Promise.resolve()
    return this.closing
  }

  private assertEnabled(): void {
    if (this.closed) throw indexClosed()
    if (this.config.openAt === 'never') throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private requireWorker(): SearchWorker {
    if (this.closed || this.worker === undefined) throw indexClosed()
    return this.worker
  }

  private start(): Binding {
    if (this.worker === undefined) {
      this.worker = new SearchWorker(this.config)
      const worker = this.worker
      this.opening = worker.call({ kind: 'open' }).then(async () => {
        this.keysReady = await worker.call({ kind: 'keys' })
      })
    }
    this.warm(this.binding)
    return this.binding
  }

  private replaceSource(source?: SessionPersistence): Binding {
    this.binding.controller.abort()
    const accepted = newBinding(this.binding.epoch + 1, !this.seenSource, source)
    this.binding = accepted
    if (source !== undefined) this.seenSource = true
    if (this.config.openAt === 'never') return accepted
    for (const session of this.ctx.sessions.list()) this.noteLifecycle(session, false)

    if (this.worker !== undefined) this.warm(accepted)
    return accepted
  }

  private assertBinding(binding: Binding): void {
    if (this.closed) throw indexClosed()
    if (this.binding !== binding) throw warming()
  }

  private bind(binding: Binding): Promise<undefined> {
    this.assertBinding(binding)
    return binding.bound ??= this.requireWorker().call({
      kind: 'bind', epoch: binding.epoch, ...(binding.jsonl === undefined ? {} : { jsonl: binding.jsonl }),
    })
  }

  private warm(binding: Binding): void {
    if (binding.ready || binding.warm !== undefined || binding.failure !== undefined) return
    binding.warm = this.scan(binding).then(() => {
      binding.ready = true
      binding.points.clear()
      return undefined
    }, (error: unknown) => {
      if (binding.controller.signal.aborted) return
      binding.failure = persistenceError(error)
      this.ctx.logger.warn('session-search warmup failed: ' + binding.failure.message)
      return binding.failure
    }).finally(() => { delete binding.warm })
  }

  private async rebuildKeys(): Promise<void> {
    await this.opening
    while (!this.keysReady) {
      this.keysReady = await this.requireWorker().call({ kind: 'keys' })
    }
  }

  private async scan(binding: Binding): Promise<void> {
    const worker = this.requireWorker()
    await (this.keyBuild ??= this.rebuildKeys())
    await this.bind(binding)
    const { epoch, source, jsonl, controller } = binding
    const signal = controller.signal
    if (source === undefined) return
    await this.flush(source)
    const snapshots = jsonl === undefined ? await source.list({ signal }) : undefined
    if (jsonl === undefined && !Array.isArray(snapshots)) throw new Error('persistence snapshots must be an array')
    const count = snapshots?.length ?? await worker.call({ kind: 'list', epoch })
    const seen = new Set<SessionId>()
    for (let from = 0; from < count; from += SCAN_BATCH_SIZE) {
      this.assertBinding(binding)
      const batch = snapshots?.slice(from, from + SCAN_BATCH_SIZE)
        ?? await worker.call({ kind: 'snapshots', epoch, from, limit: SCAN_BATCH_SIZE })
      for (const snapshot of batch) {
        this.assertBinding(binding)
        const id = snapshot.header.id
        if (seen.has(id)) throw new Error('persistence listed duplicate session "' + id + '"')
        seen.add(id)
        await this.refresh(binding, id, binding.points.has(id) || this.dirty.has(id) ? undefined : snapshot)
      }
      this.ctx.logger.debug('session-search warmup: ' + Math.min(from + batch.length, count) + '/' + count)
      await setImmediate(undefined, { signal })
    }
    let after = ''
    for (;;) {
      this.assertBinding(binding)
      const ids = await worker.call({ kind: 'indexed', epoch, after, limit: SCAN_BATCH_SIZE })
      const last = ids.at(-1)
      if (last === undefined) break
      after = last
      const removed = ids.filter(id => !seen.has(id) && !binding.points.has(id) && !this.dirty.has(id))
      if (removed.length !== 0) await worker.call({ kind: 'remove', epoch, ids: removed })
    }
  }

  private noteLifecycle(session: Session, writes: boolean): void {
    this.dirty.set(session.id, ++this.lifecycleEpoch)
    if (session.header.origin === 'subagent' && session.header.parentSession !== undefined) {
      this.dirty.set(session.header.parentSession, ++this.lifecycleEpoch)
    }
    this.writesPending ||= writes
  }

  private flush(source: SessionPersistence): Promise<void> | undefined {
    if (!this.writesPending) return this.flushing
    if (this.flushing !== undefined) return this.flushing.then(() => this.flush(source))
    this.writesPending = false
    this.flushing = source.flush().catch((error: unknown) => {
      this.writesPending = true
      throw error
    }).finally(() => { delete this.flushing })
    return this.flushing
  }

  private refresh(binding: Binding, id: SessionId, listed?: SessionPersistenceSnapshot): Promise<void> {
    const active = binding.jobs.get(id)
    if (active !== undefined) return active
    const work = this.refreshSession(binding, id, listed).catch((error: unknown) => {
      this.assertBinding(binding)
      throw persistenceError(error)
    }).finally(() => binding.jobs.delete(id))
    binding.jobs.set(id, work)
    return work
  }

  private async refreshSession(binding: Binding, id: SessionId, listed?: SessionPersistenceSnapshot): Promise<void> {
    this.assertBinding(binding)
    const worker = this.requireWorker()
    const { epoch, source, jsonl, reuseDisk, controller } = binding
    const { signal } = controller
    const observedEpoch = this.dirty.get(id)
    if (source !== undefined) await this.flush(source)
    const stat = () => jsonl === undefined ? source?.stat(id, { signal }) : worker.call({ kind: 'stat', epoch, id })
    let snapshot = listed ?? await stat()
    let session = this.ctx.sessions.get(id)
    if (source !== undefined) {
      for (let attempt = 0; session === undefined && attempt < 2; attempt++) {
        this.assertBinding(binding)
        if (snapshot === undefined || this.skip(snapshot)) {
          await worker.call({ kind: 'remove', epoch, ids: [id] })
          break
        }
        if (typeof snapshot.revision !== 'string') throw new Error('persistence snapshot revision must be a string')
        const command = { kind: 'stored', epoch, snapshot, reuseDisk } as const
        let result = await worker.call(command)
        if (result === 'needs-log') {
          const log = await readColdSessionLog(source, id, signal)
          this.assertBinding(binding)
          result = await worker.call({ ...command, log })
        }
        session = this.ctx.sessions.get(id)
        if (result !== 'changed') break
        if (attempt === 1) throw warming()
        snapshot = await stat()
      }
    }
    if (session !== undefined) {
      // A created-but-unmaterialized JSONL session exists only in the Host writer catalog.
      if (snapshot === undefined && jsonl !== undefined) snapshot = await source?.stat(id, { signal })
      if (snapshot !== undefined) assertSessionHeadersCompatible(session.header, snapshot.header)
      // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
      const events = session.snapshotEvents()
      const header = session.header
      const documents = await buildSessionEventSearchDocumentsBatched(id, events, signal)
      this.assertBinding(binding)
      await worker.call({ kind: 'live', epoch, id, persisted: snapshot !== undefined,
        entry: { header, inheritedEventCount: session.inheritedEventCount, documents, fingerprint: String(observedEpoch ?? 0) } })
    } else {
      await worker.call({ kind: 'live', epoch, id, persisted: false })
    }
    if (this.dirty.get(id) === observedEpoch) {
      this.dirty.delete(id)

    }
  }

  private skip(snapshot: SessionPersistenceSnapshot): boolean {
    const size = snapshot.sizeBytes
    if (size === undefined || size <= this.config.maxIndexedSessionBytes) return false
    const key = snapshot.header.id + ':' + snapshot.revision
    if (!this.warnedSkips.has(key)) {
      this.warnedSkips.add(key)
      this.ctx.logger.warn('session search: session "' + snapshot.header.id + '" exceeds maxIndexedSessionBytes ('
        + this.config.maxIndexedSessionBytes + '); its stored history stays out of full-text search')
    }
    return true
  }
}

function newBinding(epoch: number, reuseDisk: boolean, source?: SessionPersistence): Binding {
  const jsonl = jsonlConfig(source)
  return {
    epoch, reuseDisk, ...(source === undefined ? {} : { source }), ...(jsonl === undefined ? {} : { jsonl }),
    controller: new AbortController(), jobs: new Map(), points: new Set(), ready: false,
  }
}

function jsonlConfig(source?: SessionPersistence): JsonlConfig | undefined {
  if (source?.name !== 'session-persistence-jsonl') return undefined
  const config = Reflect.get(source, 'config') as JsonlConfig
  return { ...config, root: resolve(config.root) }
}

function warming(): SessionQueryError {
  return new SessionQueryError('session search index is warming; retry shortly', 'SESSION_QUERY_INDEX_WARMING')
}

function persistenceError(error: unknown): SessionQueryError {
  return error instanceof SessionQueryError ? error : new SessionQueryError(
    'session-search persistence observation failed: ' + (error instanceof Error ? error.message : String(error)),
    'SESSION_QUERY_PERSISTENCE_FAILED', { cause: error },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    keysPath: config.keysPath ?? (config.path === ':memory:' ? ':memory:' : `${config.path}.keys.db`),
    openAt: config.openAt ?? 'startup',
    warmupWaitMs: config.warmupWaitMs ?? DEFAULT_WARMUP_WAIT_MS,
    journalMode: config.journalMode ?? 'wal',
    synchronous: config.synchronous ?? 'full',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedReadConcurrency: config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
    preparedSessionCacheSize: config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
    metadataCacheTtlMs: config.metadataCacheTtlMs ?? 5000,
    sessionPageSnapshotTtlMs: config.sessionPageSnapshotTtlMs ?? 60000,
    sessionPageSnapshotCapacity: config.sessionPageSnapshotCapacity ?? 8,
    maxIndexedSessionBytes: config.maxIndexedSessionBytes
      ?? SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  if (typeof resolved.keysPath !== 'string' || resolved.keysPath.trim().length === 0) {
    throw invalidConfig('keysPath must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  if (!Number.isInteger(resolved.warmupWaitMs) || resolved.warmupWaitMs < 0 || resolved.warmupWaitMs > MAX_WARMUP_WAIT_MS) {
    throw invalidConfig(`warmupWaitMs must be an integer between 0 and ${MAX_WARMUP_WAIT_MS}`)
  }
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
  if (resolved.synchronous !== 'full' && resolved.synchronous !== 'normal') throw invalidConfig('synchronous is not supported')
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

async function waitForWarmup<T>(warm: Promise<T>, waitMs: number, signal: AbortSignal | undefined): Promise<T | undefined> {
  const timeout = Promise.withResolvers<undefined>()
  const timer = setTimeout(timeout.resolve, waitMs, undefined)
  try {
    return await waitWithAbort(Promise.race([warm, timeout.promise]), signal)
  } finally {
    clearTimeout(timer)
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

export default SqliteSessionQueryEngine

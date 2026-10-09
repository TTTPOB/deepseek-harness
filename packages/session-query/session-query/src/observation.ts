/** Shared live/prepared observations for Session page and lifecycle consumers. */

import type { Context } from '@deepseek-ai/cordis'
import { Session, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId , SessionLogOffset as SessionLogOffsetType , SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import { SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE, SessionQueryError } from './config.ts'
import { readColdSessionLog, type ColdSessionLog } from './cold-read.ts'
import { assertSessionHeadersCompatible } from './sources.ts'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { EventLogAnalysis, requireEvent } from './tracing.ts'
import type { SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'

type PreparationMode = 'store' | 'canonical'

/** One exact immutable Session cut retained for the caller's read lifetime. */
export interface SessionObservation extends Disposable {
  /** Whether the cut came from an attached Session or a retained preparation. */
  readonly source: 'live' | 'prepared'
  /** Immutable Session identity metadata. */
  readonly header: SessionHeader
  /** Exact fork-inherited event count paired with {@link header}. */
  readonly inheritedEventCount: SessionLogOffsetType
  /**
   * Immutable contiguous events at {@link cursor}. A live observation
   * materializes this array on first read, so a consumer that reads only the
   * header, cursor, or projections never copies the log.
   */
  readonly events: readonly SessionEvent[]
  /**
   * Borrow immutable events within this cut without materializing the complete live log.
   * @param from - inclusive sequence offset.
   * @param to - exclusive sequence offset, clamped to this observation's cut.
   * @returns immutable events from the selected half-open range.
   */
  readEvents(from: SessionLogOffsetType, to: SessionLogOffsetType): readonly SessionEvent[]
  /** Last observed event seq, or -1 for an empty log. */
  readonly cursor: SessionSeqCursor
  /** Durable source revision for a cold prepared observation. */
  readonly revision?: SessionPersistenceRevision
  /** Exact projection baseline at {@link cursor}, when the registry is mounted. */
  readonly projections?: ProjectionSnapshot
  /**
   * Retain the same immutable cut for another Host owner.
   * @returns an independently disposable lease over this observation.
   */
  retain(): SessionObservation
}

/** Projection work and cancellation requested for one exact observation. */
export interface SessionObservationOptions {
  /** Optional cancellation while resolving a cold source. */
  readonly signal?: AbortSignal
  /** Whether to compute every projection or leave projection state untouched. */
  readonly projectionMode?: 'all' | 'none'
}

/**
 * One reusable cold observation: an unpublished restored Session plus the
 * exact balanced log it represents, valid while the producing persistence
 * instance still reports the same revision.
 */
interface PreparedEntry {
  /** Public observations use store definitions; query projections use the canonical catalog. */
  readonly mode: PreparationMode
  /** Canonical analysis shares this entry's revision and eviction lifetime. */
  readonly analysis?: EventLogAnalysis
  /** Stable service identity whose `stat` produced this revision; proxy references are not instance identities. */
  readonly persistenceIdentity: symbol
  /** Durable revision observed by `stat` immediately before the log read. */
  readonly revision: SessionPersistenceRevision
  /** Unpublished Session restored from the balanced log; never entered into the store. */
  readonly session: Session
  /** Immutable balanced log (stored events plus in-memory interrupted-turn closers). */
  readonly events: readonly SessionEvent[]
  /** Active observation leases; a pinned entry (`refs > 0`) is never evicted. */
  refs: number
}

/**
 * Builds point observations without a corpus listing preflight.
 *
 * Cold reads are cached per session id, keyed by the persistence instance and
 * the `stat` revision observed before the log read: an unchanged revision
 * reuses the restored Session without re-reading the log. The cache is bounded
 * (least-recently-used unpinned entries are evicted past the capacity), and
 * entries pinned by active leases survive eviction and replacement — a lease's
 * cut stays valid for the lease lifetime even after a newer revision lands.
 */
export class SessionObservationReader {
  private readonly cache = new Map<SessionId, PreparedEntry>()
  private liveAnalyses = new WeakMap<Session, EventLogAnalysis>()
  private disposed = false

  /**
   * @param ctx - context carrying Session and optional persistence/projection services.
   * @param cacheCapacity - maximum unpinned cold observations retained for reuse.
   */
  constructor(
    private readonly ctx: Context,
    private readonly cacheCapacity: number = SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  ) {
    ctx.on('session/disposed', (session) => { this.liveAnalyses.delete(session) })
  }

  /** Clear owned caches and prevent in-flight source resolution from repopulating them. */
  dispose(): void {
    this.disposed = true
    this.cache.clear()
    this.liveAnalyses = new WeakMap()
  }

  /**
   * Resolve, capture, advance, and project a canonical cut without yielding after capture.
   * The callback must return owned output; its lease is always released before resolution.
   * @param sessionId - live-preferred source.
   * @param project - synchronous final-output projector.
   * @param signal - original corpus cancellation signal.
   * @param targetSeq - optional trace target checked before canonical preparation.
   * @returns detached projected output.
   */
  project<Value>(
    sessionId: SessionId,
    project: (observation: SessionObservation, analysis: EventLogAnalysis) => Value,
    signal?: AbortSignal,
    targetSeq?: SessionSeqType,
  ): Promise<Value> {
    return this.resolve(sessionId, { ...signal === undefined ? {} : { signal }, projectionMode: 'none' },
      'canonical', (observation, analysis) => {
        const ready = analyzeObservation(observation, analysis ?? new EventLogAnalysis(sessionId))
        return project(observation, ready)
      }, targetSeq)
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('session observation reader is disposed')
  }

  /**
   * Observe one live-preferred Session and retain a cold preparation until disposal.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and all-or-none projection computation for this read.
   * @returns one exact immutable observation.
   * @throws {@link SessionQueryError} with code `SESSION_QUERY_CORRUPT_SESSION` when live or prepared projection computation fails.
   */
  read(sessionId: SessionId, options: SessionObservationOptions = {}): Promise<SessionObservation> {
    return this.resolve(sessionId, options, 'store', observation => observation)
  }

  private async resolve<Value>(
    sessionId: SessionId,
    options: SessionObservationOptions,
    mode: PreparationMode,
    consume: (observation: SessionObservation, analysis?: EventLogAnalysis) => Value,
    targetSeq?: SessionSeqType,
  ): Promise<Value> {
    const { signal, projectionMode = 'all' } = options
    for (;;) {
      this.assertActive()
      throwIfAborted(signal, mode)
      const live = this.ctx.sessions.get(sessionId)
      if (live !== undefined) return this.consumeLive(live, projectionMode, mode, consume, targetSeq)
      const persistence = this.ctx.get('sessionPersistence')
      if (persistence === undefined) throw notFound(sessionId)

      const snapshot = await this.statSource(persistence, sessionId, signal, mode)
      this.assertActive()
      const attachedDuringStat = this.ctx.sessions.get(sessionId)
      if (mode === 'store' && attachedDuringStat !== undefined) {
        return this.consumeLive(attachedDuringStat, projectionMode, mode, consume, targetSeq)
      }
      let entry = this.cachedEntry(persistence.identity, sessionId, snapshot.revision, mode)
      if (entry !== undefined && attachedDuringStat !== undefined) {
        return this.consumeLive(attachedDuringStat, projectionMode, mode, consume, targetSeq)
      }
      if (entry === undefined) {
        const loaded = await this.loadSource(persistence, sessionId, signal, mode)
        this.assertActive()
        throwIfAborted(signal, mode)
        const attached = this.ctx.sessions.get(sessionId)
        if (attached !== undefined) return this.consumeLive(attached, projectionMode, mode, consume, targetSeq)
        assertSessionHeadersCompatible(snapshot.header, loaded.header)
        // Canonical errors precede restore validation; a missing trace target
        // precedes both. Restore still validates envelopes, data, and headers.
        const seed = loaded.events
        let analysis: EventLogAnalysis | undefined
        if (mode === 'canonical') {
          if (targetSeq !== undefined) requireEvent(sessionId, seed, targetSeq)
          analysis = new EventLogAnalysis(sessionId)
          analysis.append(seed)
        }
        let session: Session
        try {
          session = mode === 'canonical'
            ? Session.fromRestore(sessionId, seed, structuredClone(loaded.header),
              loaded.inheritedEventCount, loaded.eventState, currentSessionMessageProjections)
            : this.ctx.sessions.prepare(sessionId, {
              seed, meta: structuredClone(loaded.header),
              inheritedEventCount: loaded.inheritedEventCount, eventState: loaded.eventState,
            })
        } catch (error: unknown) {
          if (mode === 'store' && this.ctx.sessions.get(sessionId) !== undefined) continue
          throw new SessionQueryError(
            'stored session "' + sessionId + '" is corrupt: ' + errorMessage(error),
            'SESSION_QUERY_CORRUPT_SESSION', { cause: error },
          )
        }
        entry = {
          mode, persistenceIdentity: persistence.identity, revision: snapshot.revision,
          session, events: Object.freeze(seed), refs: 0,
          ...analysis === undefined ? {} : { analysis },
        }
        this.store(sessionId, entry)
      }
      if (mode === 'canonical' && targetSeq !== undefined) requireEvent(sessionId, entry.events, targetSeq)
      let projections: ProjectionSnapshot | undefined
      try {
        projections = projectionMode === 'none' ? undefined : this.preparedProjections(entry)
      } catch (error: unknown) {
        throw new SessionQueryError(
          'failed to project session "' + sessionId + '": ' + errorMessage(error),
          'SESSION_QUERY_CORRUPT_SESSION', { cause: error },
        )
      }
      const observation = this.preparedLease(sessionId, entry, projections)
      if (mode === 'store') return consume(observation)
      try {
        return consume(observation, entry.analysis)
      } finally {
        observation[Symbol.dispose]()
      }
    }
  }

  private consumeLive<Value>(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
    mode: PreparationMode,
    consume: (observation: SessionObservation, analysis?: EventLogAnalysis) => Value,
    targetSeq: SessionSeqType | undefined,
  ): Value {
    const observation = this.live(session, projectionMode)
    if (mode === 'store') return consume(observation)
    try {
      if (targetSeq !== undefined) {
        const target = observation.readEvents(SessionLogOffset(targetSeq), SessionLogOffset(targetSeq + 1))[0]
        if (target === undefined || target.seq !== targetSeq) {
          throw new SessionQueryError(
            'session "' + session.id + '" has no event at seq ' + targetSeq,
            'SESSION_QUERY_EVENT_NOT_FOUND',
          )
        }
      }
      let analysis = this.liveAnalyses.get(session)
      if (analysis === undefined) {
        analysis = new EventLogAnalysis(session.id)
        this.liveAnalyses.set(session, analysis)
      }
      return consume(observation, analysis)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  /** Observe the stored snapshot, mapping absence and backend failures to the query taxonomy. */
  private async statSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
    mode: PreparationMode,
  ): Promise<SessionPersistenceSnapshot> {
    let snapshot: SessionPersistenceSnapshot | undefined
    try {
      snapshot = await persistence.stat(sessionId, signal === undefined ? undefined : { signal })
    } catch (error: unknown) {
      throwIfAborted(signal, mode)
      throw mode === 'store' ? mapPersistenceFailure(sessionId, error) : mapCorpusFailure(sessionId, error, 'stat')
    }
    throwIfAborted(signal, mode)
    if (snapshot === undefined) throw notFound(sessionId)
    if (mode === 'store' && snapshot.header.id !== sessionId) {
      throw new SessionQueryError(
        `session persistence returned "${snapshot.header.id}" for "${sessionId}"`,
        'SESSION_QUERY_SOURCE_CONFLICT',
      )
    }
    return snapshot
  }

  /** Read the complete balanced cold log, mapping backend failures to the query taxonomy. */
  private async loadSource(
    persistence: SessionPersistence,
    sessionId: SessionId,
    signal: AbortSignal | undefined,
    mode: PreparationMode,
  ): Promise<ColdSessionLog> {
    try {
      return await readColdSessionLog(persistence, sessionId, signal)
    } catch (error: unknown) {
      throwIfAborted(signal, mode)
      throw mode === 'store' ? mapPersistenceFailure(sessionId, error) : mapCorpusFailure(sessionId, error, 'read')
    }
  }

  /** Return a still-valid cached entry and mark it most recently used. */
  private cachedEntry(
    persistenceIdentity: symbol,
    sessionId: SessionId,
    revision: SessionPersistenceRevision,
    mode: PreparationMode,
  ): PreparedEntry | undefined {
    const cached = this.cache.get(sessionId)
    if (cached === undefined || cached.persistenceIdentity !== persistenceIdentity
      || cached.revision !== revision || cached.mode !== mode) {
      return undefined
    }
    this.cache.delete(sessionId)
    this.cache.set(sessionId, cached)
    return cached
  }

  /** Insert or replace the entry for one id, then evict past the capacity. */
  private store(sessionId: SessionId, entry: PreparedEntry): void {
    // Replacing a stale revision only drops the map's reference; live leases
    // keep the old entry alive through their own references.
    this.cache.delete(sessionId)
    this.cache.set(sessionId, entry)
    this.evictPastCapacity(entry)
  }

  /**
   * Evict oldest unpinned entries until the cache fits its capacity again.
   * Runs on store and whenever a lease release unpins an entry, so leases
   * that pinned every candidate cannot leave the cache over budget for good.
   * @param keep - the entry being stored, about to be leased; never evicted.
   */
  private evictPastCapacity(keep?: PreparedEntry): void {
    if (this.cache.size <= this.cacheCapacity) return
    for (const [id, candidate] of this.cache) {
      if (candidate === keep || candidate.refs > 0) continue
      this.cache.delete(id)
      if (this.cache.size <= this.cacheCapacity) return
    }
  }

  /** Build one disposable lease over a cached entry, pinning it until every lease releases. */
  private preparedLease(
    sessionId: SessionId,
    entry: PreparedEntry,
    projections: ProjectionSnapshot | undefined,
  ): SessionObservation {
    entry.refs += 1
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'prepared',
        header: entry.session.header,
        inheritedEventCount: entry.session.inheritedEventCount,
        events: entry.events,
        readEvents: (from, to) => Object.freeze(entry.events.slice(from, to)),
        cursor: entry.events.at(-1)?.seq ?? -1,
        revision: entry.revision,
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${sessionId}" is disposed`)
          entry.refs += 1
          return lease()
        },
        [Symbol.dispose]: () => {
          if (disposed) return
          disposed = true
          entry.refs -= 1
          if (entry.refs === 0) this.evictPastCapacity()
        },
      }
    }
    return lease()
  }

  private live(
    session: Session,
    projectionMode: NonNullable<SessionObservationOptions['projectionMode']>,
  ): SessionObservation {
    // The cut is the log length now. The log only appends, so the prefix
    // below `seq` is the same array whenever a consumer first reads `events`.
    const seq = session.seq
    let materialized: readonly SessionEvent[] | undefined
    let projections: ProjectionSnapshot | undefined
    try {
      projections = projectionMode === 'none'
        ? undefined
        : this.ctx.get('sessionProjections')?.snapshot(session)
    } catch (error: unknown) {
      throw new SessionQueryError(
        `failed to project session "${session.id}": ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    const readEvents = (from: SessionLogOffsetType, to: SessionLogOffsetType): readonly SessionEvent[] => {
      // oxlint-disable-next-line typescript/no-deprecated -- Observation range adapter owns the existing synchronous Session read.
      return session.snapshotEvents(from, SessionLogOffset(Math.min(to, seq)))
    }
    const lease = (): SessionObservation => {
      let disposed = false
      return {
        source: 'live',
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        get events() {
          materialized ??= readEvents(SessionLogOffset(0), seq)
          return materialized
        },
        readEvents,
        cursor: seq === 0 ? -1 : SessionSeq(seq - 1),
        ...projections === undefined ? {} : { projections },
        retain: () => {
          if (disposed) throw new Error(`session observation "${session.id}" is disposed`)
          return lease()
        },
        [Symbol.dispose]: () => { disposed = true },
      }
    }
    return lease()
  }

  private preparedProjections(entry: PreparedEntry): ProjectionSnapshot | undefined {
    const registry = this.ctx.get('sessionProjections')
    if (registry === undefined) return undefined
    const cache = this.ctx.get('sessionProjectionCache')
    return cache === undefined
      ? registry.hydrate(entry.session, {}, entry.events, SessionLogOffset(0))
      : cache.hydratePrepared(entry.session, entry.events)
  }
}

/**
 * Advance shared analysis to a lease cut, rebuilding an older prefix temporarily.
 * @param observation - retained exact prefix; events are borrowed without payload copies.
 * @param analysis - analysis owned by the source, possibly newer than this lease.
 * @returns analysis of exactly this cut; an older rebuild is not retained by the owner.
 */
export function analyzeObservation(observation: SessionObservation, analysis: EventLogAnalysis): EventLogAnalysis {
  const cut = observation.cursor + 1
  const selected = analysis.processed > cut ? new EventLogAnalysis(observation.header.id) : analysis
  selected.append(observation.readEvents(SessionLogOffset(selected.processed), SessionLogOffset(cut)))
  return selected
}

function throwIfAborted(signal: AbortSignal | undefined, mode: PreparationMode): void {
  if (mode === 'canonical') {
    signal?.throwIfAborted()
    return
  }
  if (signal?.aborted !== true) return
  throw new SessionQueryError(
    'session observation was aborted',
    'SESSION_QUERY_ABORTED',
    { cause: signal.reason },
  )
}

function mapCorpusFailure(sessionId: SessionId, error: unknown, operation: 'stat' | 'read'): SessionQueryError {
  if (operation === 'read' && hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      'stored session "' + sessionId + '" is corrupt: ' + errorMessage(error),
      'SESSION_QUERY_CORRUPT_SESSION', { cause: error },
    )
  }
  return new SessionQueryError(
    'failed to ' + operation + ' stored session "' + sessionId + '": ' + errorMessage(error),
    'SESSION_QUERY_PERSISTENCE_FAILED', { cause: error },
  )
}

function mapPersistenceFailure(sessionId: SessionId, error: unknown): SessionQueryError {
  if (hasErrorName(error, 'SessionPersistenceNotFoundError')) return notFound(sessionId, error)
  if (hasErrorName(error, 'SessionPersistenceCorruptionError')) {
    return new SessionQueryError(
      `stored session "${sessionId}" is corrupt: ${error.message}`,
      'SESSION_QUERY_CORRUPT_SESSION',
      { cause: error },
    )
  }
  return new SessionQueryError(
    `failed to observe session "${sessionId}": ${errorMessage(error)}`,
    'SESSION_QUERY_PERSISTENCE_FAILED',
    { cause: error },
  )
}

function notFound(sessionId: SessionId, cause?: unknown): SessionQueryError {
  return new SessionQueryError(
    `session "${sessionId}" not found`,
    'SESSION_QUERY_SESSION_NOT_FOUND',
    cause === undefined ? undefined : { cause },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function hasErrorName(error: unknown, name: string): error is Error {
  return error instanceof Error && error.name === name
}

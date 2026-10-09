/**
 * Service Definition for combined session-history reads, traces, filters, and full-text search.
 *
 * @module @deepseek-ai/dsh-session-query
 */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  Session,
  SessionSeq,
  SessionLogOffset,
  snapshotSessionEvent,
  type SessionId,
  type SessionSeq as SessionSeqType,
} from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleSnapshot } from '@deepseek-ai/dsh-session-title'
import type {
  SessionEventResultFilter,
  SessionMetadataPageRequest,
  SessionEventPageRequest,
  SessionEventPage,
  SessionEventPageItem,
  SessionEventSearchPage,
  SessionEventReadRequest,
  SessionEventRecord,
  SessionEventSearchDocument,
  SessionEventSearchRequest,
  SessionEventTraceObservation,
  SessionEventTraceRequest,
  SessionEventWindow,
  SessionLineageTrace,
  SessionLogSnapshot,
  SessionRecord,
  SessionResultFilter,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
  SessionSurfaceSnapshot,
  SessionTitleObservation,
  SessionTitleObservationResult,
} from './types.ts'
import {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  type Config,
} from './config.ts'
import { SessionCorpus } from './corpus.ts'
import {
  SessionObservationReader,
  type SessionObservation,
  type SessionObservationOptions,
} from './observation.ts'
import { buildSessionEventSearchDocuments } from './documents.ts'
import {
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
import * as tracing from './tracing.ts'
import { SessionPages, assertReadPageLimit } from './paging.ts'
import { extractSessionEventText } from './extraction.ts'

export type * from './types.ts'
export { SessionSearchCursor } from './cursor.ts'
export type { Config, SessionQueryErrorCode } from './config.ts'
export {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
} from './config.ts'
export { readColdSessionLog } from './cold-read.ts'
export type { ColdSessionLog } from './cold-read.ts'
export { extractSessionEventText } from './extraction.ts'
export { buildSessionEventRecords, buildSessionEventSearchDocuments } from './documents.ts'
export {
  compileSessionTextFilter,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from './filters.ts'
export { assertSessionHeadersCompatible } from './sources.ts'
export type { SessionObservation, SessionObservationOptions } from './observation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionQuery: SessionQueryEngine
  }
}

/**
 * Unified live-preferred session query service.
 *
 * Exact reads, filters, and traces are backend-independent concrete behavior.
 * A backend implements full-text observation, reconciliation, ranking, cursor
 * generations, and query execution on the same `ctx.sessionQuery` service.
 */
export abstract class SessionQueryEngine extends Service {
  static inject = ['sessions']

  private readonly _readWindowMax: number
  private readonly _corpus: SessionCorpus
  private readonly _observations: SessionObservationReader
  private readonly _pages: SessionPages

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionQuery')
    this._readWindowMax = config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX
    if (!Number.isInteger(this._readWindowMax) || this._readWindowMax < 0) {
      throw new SessionQueryError(
        'session-query: readWindowMax must be a non-negative integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const persistedReadConcurrency = config.persistedReadConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY
    if (!Number.isSafeInteger(persistedReadConcurrency) || persistedReadConcurrency < 1) {
      throw new SessionQueryError(
        'session-query: persistedReadConcurrency must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const preparedSessionCacheSize = config.preparedSessionCacheSize
      ?? SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE
    if (!Number.isSafeInteger(preparedSessionCacheSize) || preparedSessionCacheSize < 1) {
      throw new SessionQueryError(
        'session-query: preparedSessionCacheSize must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const metadataCacheTtlMs = config.metadataCacheTtlMs ?? 5000
    const snapshotTtlMs = config.sessionPageSnapshotTtlMs ?? 60000
    const snapshotCapacity = config.sessionPageSnapshotCapacity ?? 8
    for (const [name, value, minimum] of [
      ['metadataCacheTtlMs', metadataCacheTtlMs, 0],
      ['sessionPageSnapshotTtlMs', snapshotTtlMs, 1],
      ['sessionPageSnapshotCapacity', snapshotCapacity, 1],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new SessionQueryError(
          'session-query: ' + name + ' must be a safe integer >= ' + String(minimum),
          'SESSION_QUERY_INVALID_CONFIG',
        )
      }
    }
    this._pages = new SessionPages(snapshotTtlMs, snapshotCapacity)
    ctx.effect(() => () => { this._pages.clear() }, 'sessionQuery.pages')
    this._corpus = new SessionCorpus(ctx, persistedReadConcurrency, metadataCacheTtlMs)
    this._observations = new SessionObservationReader(ctx, preparedSessionCacheSize)
    ctx.effect(() => () => { this._observations.dispose() }, 'sessionQuery.observations')
  }

  /**
   * Observe one exact live or prepared Session without a persistence listing preflight.
   * @param sessionId - logical Session identity.
   * @param options - cancellation and projection selection for this read.
   * @returns a caller-owned observation lease.
   */
  observeSession(
    sessionId: SessionId,
    options: SessionObservationOptions = {},
  ): Promise<SessionObservation> {
    return this._observations.read(sessionId, options)
  }

  /**
   * Search the live-preferred logical corpus and group by session.
   * @param request - query text, metadata filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns session hits ranked by their strongest matching event.
   */
  abstract searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>

  /**
   * Search events within one live-preferred logical session.
   * @param request - target session, query text, filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns matching event hits and their target header from one indexed generation.
   */
  abstract searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage>

  /**
   * List the complete logical corpus using live-preferred records.
   * @param signal - optional cancellation for persistence listing.
   * @returns deterministic newest-first cloned session records.
   */
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    return this._corpus.listSessions(signal)
  }

  /**
   * Page newest-first metadata from an immutable snapshot; continuation never re-lists persistence.
   * @param request - metadata filters, positive page size, and optional snapshot cursor.
   * @param signal - cancellation for metadata observation and waiting.
   * @returns detached records; expired, evicted, or unloaded snapshots reject with STALE_CURSOR.
   */
  async pageSessions(request: SessionMetadataPageRequest, signal?: AbortSignal): Promise<SessionSearchPage<SessionRecord>> {
    assertReadPageLimit(request.limit)
    signal?.throwIfAborted()
    const filters = materializeSessionResultFilters(request.filters ?? [])
    const fingerprint = JSON.stringify(filters)
    if (request.cursor !== undefined) return this._pages.next(request.cursor, fingerprint, request.limit, this.ctx.get('sessionPersistence')?.identity)
    const records = await this._filterSessions(filters, signal)
    signal?.throwIfAborted()
    return this._pages.first(records, fingerprint, request.limit, this.ctx.get('sessionPersistence')?.identity)
  }

  /**
   * Project only one ascending raw-event page from one live or prepared observation.
   * @param request - target, exclusive seq bound, optional types and text, and positive page size.
   * @param signal - cancellation during cold resolution and page scanning.
   * @returns page metadata, exact source header and observed upper seq, and optional continuation.
   */
  async pageEvents(request: SessionEventPageRequest, signal?: AbortSignal): Promise<SessionEventPage> {
    assertReadPageLimit(request.limit)
    const after = request.afterSeq ?? -1
    if (!Number.isSafeInteger(after) || after < -1) {
      throw new SessionQueryError('afterSeq must be a safe integer >= -1', 'SESSION_QUERY_INVALID_FILTER')
    }
    const types = request.types === undefined ? undefined : new Set(request.types)
    const observation = await this.observeSession(request.sessionId, { ...signal === undefined ? {} : { signal }, projectionMode: 'none' })
    try {
      const items: SessionEventPageItem[] = []
      let hasMore = false
      for (let from = after + 1; from <= observation.cursor && !hasMore;) {
        signal?.throwIfAborted()
        const to = Math.min(observation.cursor + 1, from + 256)
        const events = observation.readEvents(SessionLogOffset(from), SessionLogOffset(to))
        for (const event of events) {
          if (types !== undefined && !types.has(event.type)) continue
          if (items.length === request.limit) { hasMore = true; break }
          items.push({
            sessionId: request.sessionId, seq: event.seq, type: event.type, time: event.time,
            ...request.includeText === true ? { text: extractSessionEventText(event) } : {},
          })
        }
        from = to
        // Yield between bounded scan batches so caller cancellation can be delivered.
        if (from <= observation.cursor && !hasMore) await new Promise<void>(resolve => setImmediate(resolve))
      }
      signal?.throwIfAborted()
      const last = items.at(-1)
      return {
        session: structuredClone(observation.header), items,
        capturedThroughSeq: observation.cursor,
        ...hasMore && last !== undefined ? { nextAfterSeq: last.seq } : {},
      }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  /**
   * Read and replay-validate one complete logical session log without making it live.
   * @param sessionId - live or persisted session id to read.
   * @returns cloned header and complete raw event log from one observation.
   * @throws when persistence, header compatibility, or replay validation fails.
   */
  async readSession(sessionId: SessionId): Promise<SessionLogSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    Session.create(
      sessionId,
      loaded.events,
      loaded.header,
      loaded.inheritedEventCount,
      currentSessionMessageProjections,
    )
    return {
      session: structuredClone(loaded.header),
      inheritedEventCount: loaded.inheritedEventCount,
      events: loaded.events.map(snapshotSessionEvent),
    }
  }

  /**
   * Filter logical sessions; exact id clauses avoid a complete persistence listing.
   * @param filters - ANDed session metadata and availability clauses.
   * @param signal - optional cancellation for persistence observations.
   * @returns matching cloned records in deterministic newest-first order.
   */
  async filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    const ownedFilters = materializeSessionResultFilters(filters)
    return this._filterSessions(ownedFilters, signal)
  }

  /**
   * Fold the latest log-backed title from one live-preferred logical session.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns latest title snapshot, or `undefined` when the log has no title event.
   */
  async readTitle(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleSnapshot | undefined> {
    return (await this.readTitleSnapshot(sessionId, signal)).title
  }

  /**
   * Fold the latest title and return its source header from one corpus observation.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns cloned source header and optional latest title snapshot.
   */
  async readTitleSnapshot(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleObservation> {
    const result = (await this.readTitleSnapshots([sessionId], signal))[0] as SessionTitleObservationResult
    if (result.status === 'rejected') throw result.reason
    return result.value
  }

  /**
   * Fold titles for unique sessions from one cancellable corpus observation.
   *
   * Results preserve first-occurrence input order. Operational failures stay
   * isolated per session, while cancellation rejects the complete operation.
   * @param sessionIds - live or persisted session ids to observe.
   * @param signal - optional cancellation shared by all source reads.
   * @returns one fulfilled or rejected result per unique requested id.
   */
  async readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    return this._corpus.projectMany(sessionIds, (source): SessionTitleObservation => {
      const title = foldSessionTitle(source.events)
      return {
        session: structuredClone(source.header),
        ...title === undefined ? {} : { title },
      }
    }, signal)
  }

  /**
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
    return tracing.eventRecords(sessionId, loaded.events)
  }

  /**
   * Scan first-party semantic event documents with provider-independent filters.
   * @param sessionId - live-preferred session id to scan.
   * @param filters - ANDed metadata and literal-text predicates.
   * @returns matching semantic documents in ascending seq order.
   */
  async filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const ownedFilters = materializeSessionEventResultFilters(filters)
    return this._filterEvents(sessionId, ownedFilters)
  }

  private async _filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    const idFilters = filters.filter(filter => filter.kind === 'id')
    const first = idFilters[0]
    const records = first === undefined
      ? await this._corpus.listSessions(signal)
      : await this._corpus.selectSessions(
        first.values.filter(id => idFilters.every(filter => filter.values.includes(id))), signal,
      )
    return filterSessionResults(records, filters)
  }

  private async _filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const loaded = await this._corpus.load(sessionId)
    const documents = buildSessionEventSearchDocuments(sessionId, loaded.events)
    return filterSessionEventDocuments(documents, filters)
  }

  /**
   * Read original current surface events from an exact cut, reusing owner-held analysis.
   * @param sessionId - live-preferred session id to read.
   * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
   * @throws when source resolution fails or the session surface is invalid.
   */
  async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot> {
    return this._observations.project(sessionId, (observation, analysis) => ({
      session: structuredClone(observation.header),
      inheritedEventCount: observation.inheritedEventCount,
      capturedThroughSeq: observation.cursor === -1 ? null : observation.cursor,
      events: analysis.surfaceEvents(),
    }))
  }

  /**
   * Trace known ancestry and descendants from one corpus observation.
   * @param sessionId - logical session id to trace.
   * @param signal - optional cancellation for persistence listing.
   * @returns a complete lineage or the first parent that could not be resolved.
   * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
   */
  async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace> {
    const records = await this._corpus.listSessions(signal)
    signal?.throwIfAborted()
    return tracing.traceSession(records, sessionId)
  }

  /**
   * Trace direct replacements and citations at an exact cut, advancing only unseen events.
   * @param request - target session id and event seq.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns source header, direct links, and the target's positional replacement chain.
   * @throws when source resolution fails, the target is absent, or surface/source-event validation fails.
   */
  async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation> {
    return this._observations.project(request.sessionId, (observation, analysis) => ({
      session: structuredClone(observation.header),
      ...analysis.trace(request.seq),
    }), signal, request.seq)
  }

  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns cloned target and neighboring events.
   */
  async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const sessionId = request.sessionId
    const seq = request.seq
    return this._readEvent(sessionId, seq, before, after, signal)
  }

  private async _readEvent(
    sessionId: SessionId,
    seq: SessionSeqType,
    before: number,
    after: number,
    signal?: AbortSignal,
  ): Promise<SessionEventWindow> {
    signal?.throwIfAborted()
    const observation = await this.observeSession(sessionId, { ...signal === undefined ? {} : { signal }, projectionMode: 'none' }).catch((error: unknown) => {
      signal?.throwIfAborted()
      throw error
    })
    try {
      signal?.throwIfAborted()
      const startSeq = SessionSeq(Math.max(0, seq - before))
      const endSeq = SessionSeq(Math.min(observation.cursor, seq + after))
      const selected = observation.readEvents(SessionLogOffset(startSeq), SessionLogOffset(Math.max(startSeq, endSeq + 1)))
      const target = selected[seq - startSeq]
      if (target === undefined || target.seq !== seq) {
        throw new SessionQueryError(
          `session "${sessionId}" has no event at seq ${seq}`,
          'SESSION_QUERY_EVENT_NOT_FOUND',
        )
      }
      const targetSnapshot = snapshotSessionEvent(target)
      const events = selected
        .map(event => event === target
          ? targetSnapshot
          : snapshotSessionEvent(event))
      return {
        session: structuredClone(observation.header),
        inheritedEventCount: observation.inheritedEventCount,
        target: targetSnapshot,
        events,
        startSeq,
        endSeq,
      }
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private _readWindow(name: 'before' | 'after', value: number | undefined): number {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > this._readWindowMax) {
      throw new SessionQueryError(
        `${name} must be an integer between 0 and ${this._readWindowMax}`,
        'SESSION_QUERY_INVALID_WINDOW',
      )
    }
    return value
  }
}

export default SessionQueryEngine

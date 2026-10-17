/** Canonical incremental event analysis and one-shot session-lineage tracing. */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { SurfaceFoldAccumulator, isSurfaceEvent, snapshotSessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionEvent,
  SessionId,
  SessionMessageProjection,
  SessionSeq,
  SurfaceEvent,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError } from './config.ts'
import type {
  SessionEventRecord,
  SessionEventTrace,
  SessionLineageNode,
  SessionLineageTrace,
  SessionRecord,
} from './types.ts'

/**
 * Analysis owned by one Session object or prepared revision. Event payloads are
 * borrowed from that owner; retained state consists of event references, sequences,
 * and interpreted messages, with no payload copies.
 * Results own their metadata and arrays and survive subsequent appends.
 */
export class EventLogAnalysis {
  private readonly events: SessionEvent[] = []
  private readonly fold: SurfaceFoldAccumulator
  private readonly current = new Set<SessionSeq>()
  private readonly replacedBy = new Map<SessionSeq, SessionSeq>()
  private readonly replacedEventSeqs = new Map<SessionSeq, readonly SessionSeq[]>()
  private readonly derived = new Map<SessionSeq, SessionSeq[]>()

  /**
   * @param sessionId - owner used in records and diagnostics.
   * @param projections - borrowed canonical message interpreters.
   */
  constructor(
    private readonly sessionId: SessionId,
    projections: readonly SessionMessageProjection[] = currentSessionMessageProjections,
  ) {
    this.fold = new SurfaceFoldAccumulator(projections)
  }

  /** Number of successfully processed events, including ordinary source citations. */
  get processed(): number { return this.fold.nextSeq }

  /**
   * Process only the next contiguous range of borrowed immutable events.
   * @param events - events starting at processed, from the same owner and revision.
   * @throws when canonical surface interpretation fails.
   */
  append(events: readonly SessionEvent[]): void {
    try {
      for (const event of events) {
        const replacement = this.fold.append(event, this.events)
        this.events.push(event)
        if (replacement !== undefined) {
          this.replacedEventSeqs.set(event.seq, replacement.shadowedSeqs)
          for (const removed of replacement.shadowedSeqs) {
            this.current.delete(removed)
            this.replacedBy.set(removed, event.seq)
          }
        }
        if (isSurfaceEvent(event)) this.current.add(event.seq)
        for (const source of eventSources(event)) {
          // Unknown ignorable metadata may cite non-earlier events; traces only
          // report later direct citations, just like the complete-log reader.
          if (source >= event.seq) continue
          const derived = this.derived.get(source) ?? []
          if (derived.at(-1) !== event.seq) derived.push(event.seq)
          this.derived.set(source, derived)
        }
      }
      void this.fold.nodes
    } catch (error: unknown) {
      throw invalidSurface(error)
    }
  }

  /**
   * Copy only current original surface events, including empty messages.
   * @returns detached events in canonical node-position order, not interpreted messages.
   */
  surfaceEvents(): SurfaceEvent[] {
    return this.nodes().map(seq => snapshotSessionEvent(this.events[seq] as SurfaceEvent))
  }

  /**
   * Materialize the complete record list for consumers that need every event.
   * @returns detached metadata in ascending log order.
   */
  records(): SessionEventRecord[] {
    this.nodes()
    return this.events.map(event => this.record(event))
  }

  /**
   * Trace one target without materializing records for the rest of the log.
   * @param seq - target sequence in the processed prefix.
   * @returns detached direct sources, later citations, and actual replacement chain.
   */
  trace(seq: SessionSeq): SessionEventTrace {
    const target = requireEvent(this.sessionId, this.events, seq)
    this.nodes()
    const replacementChain: SessionSeq[] = []
    let replacement = this.replacedBy.get(seq)
    while (replacement !== undefined) {
      replacementChain.push(replacement)
      replacement = this.replacedBy.get(replacement)
    }
    const replacedBy = this.replacedBy.get(seq)
    return {
      target: this.record(target),
      ...replacedBy === undefined ? {} : { replacedBy },
      replacementChain,
      replacedEventSeqs: [...this.replacedEventSeqs.get(seq) ?? []],
      sourceEventSeqs: [...eventSources(target)],
      derivedEventSeqs: [...this.derived.get(seq) ?? []],
    }
  }

  private nodes(): readonly SessionSeq[] {
    try { return this.fold.nodes } catch (error: unknown) { throw invalidSurface(error) }
  }

  private record(event: SessionEvent): SessionEventRecord {
    return {
      sessionId: this.sessionId, seq: event.seq, type: event.type, time: event.time,
      surface: this.current.has(event.seq)
        ? 'current' : this.replacedBy.has(event.seq) ? 'shadowed' : 'log-only',
    }
  }
}

/**
 * Classify a complete raw event log with the canonical surface interpreter.
 * @param sessionId - owner of the event log.
 * @param events - borrowed complete raw event log.
 * @returns lightweight records in ascending log order.
 */
export function eventRecords(sessionId: SessionId, events: readonly SessionEvent[]): SessionEventRecord[] {
  return analyzeEventLog(sessionId, events).records()
}

/**
 * Fold and copy only current original surface events.
 * @param sessionId - owner used in query diagnostics.
 * @param events - borrowed complete raw event log.
 * @returns detached surface events in folded order.
 */
export function currentSurfaceEvents(sessionId: SessionId, events: readonly SessionEvent[]): SurfaceEvent[] {
  return analyzeEventLog(sessionId, events).surfaceEvents()
}

/**
 * Trace one target after checking existence and validating the canonical fold.
 * @param sessionId - owner of the event log.
 * @param events - borrowed complete raw event log.
 * @param seq - target event seq.
 * @returns detached direct replacements and cited-source relationships.
 */
export function traceEvent(sessionId: SessionId, events: readonly SessionEvent[], seq: SessionSeq): SessionEventTrace {
  requireEvent(sessionId, events, seq)
  return analyzeEventLog(sessionId, events).trace(seq)
}

/**
 * Check target existence before canonical folding or Session preparation.
 * @param sessionId - owner used in diagnostics.
 * @param events - selected raw prefix.
 * @param seq - requested target.
 * @returns the borrowed target event.
 */
export function requireEvent(sessionId: SessionId, events: readonly SessionEvent[], seq: SessionSeq): SessionEvent {
  const target = events[seq]
  if (target === undefined || target.seq !== seq) {
    throw new SessionQueryError(
      'session "' + sessionId + '" has no event at seq ' + seq,
      'SESSION_QUERY_EVENT_NOT_FOUND',
    )
  }
  return target
}

/**
 * Trace one target's known ancestry and recursively known descendants.
 * @param records - complete logical corpus from one observation.
 * @param sessionId - target session id.
 * @returns complete or explicitly partial lineage.
 */
export function traceSession(
  records: readonly SessionRecord[],
  sessionId: SessionId,
): SessionLineageTrace {
  const byId = new Map(records.map(record => [record.header.id, record]))
  const target = byId.get(sessionId)
  if (target === undefined) {
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  const ancestors: SessionRecord[] = []
  const ancestrySeen = new Set<SessionId>([sessionId])
  let unresolvedParentId: SessionId | undefined
  let parentId = target.header.parentSession
  while (parentId !== undefined) {
    if (ancestrySeen.has(parentId)) {
      throw new SessionQueryError(
        `session lineage contains a cycle at "${parentId}"`,
        'SESSION_QUERY_INVALID_LINEAGE',
      )
    }
    ancestrySeen.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) {
      unresolvedParentId = parentId
      break
    }
    ancestors.push(parent)
    parentId = parent.header.parentSession
  }

  const childrenByParent = new Map<SessionId, SessionRecord[]>()
  for (const record of records) {
    const parent = record.header.parentSession
    if (parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(record)
    childrenByParent.set(parent, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id))
  }

  const descendants = buildDescendants(childrenByParent, sessionId)
  const common = {
    target: cloneRecord(target),
    ancestors: ancestors.map(cloneRecord),
    descendants,
  }
  if (unresolvedParentId !== undefined) {
    return { ...common, complete: false, unresolvedParentId }
  }
  return {
    ...common,
    complete: true,
    root: cloneRecord(ancestors.at(-1) ?? target),
  }
}

function analyzeEventLog(sessionId: SessionId, events: readonly SessionEvent[]): EventLogAnalysis {
  const analysis = new EventLogAnalysis(sessionId)
  analysis.append(events)
  return analysis
}

function invalidSurface(error: unknown): SessionQueryError {
  return new SessionQueryError(
    'invalid session surface: ' + (error instanceof Error ? error.message : 'unknown error'),
    'SESSION_QUERY_INVALID_SURFACE',
    { cause: error },
  )
}

function eventSources(event: SessionEvent): readonly SessionSeq[] {
  return event.sourceEventSeqs ?? []
}

function buildDescendants(
  childrenByParent: ReadonlyMap<SessionId, readonly SessionRecord[]>,
  sessionId: SessionId,
): SessionLineageNode[] {
  const descendants: SessionLineageNode[] = []
  const stack = [{ sessionId, descendants }]
  while (stack.length > 0) {
    // The length guard proves a frame exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const frame = stack.pop()!
    const nodes: SessionLineageNode[] = []
    for (const child of childrenByParent.get(frame.sessionId) ?? []) {
      const node = { session: cloneRecord(child), descendants: [] }
      nodes.push(node)
      frame.descendants.push(node)
    }
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      // The loop bounds prove this indexed node exists.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const node = nodes[index]!
      stack.push({ sessionId: node.session.header.id, descendants: node.descendants })
    }
  }
  return descendants
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}

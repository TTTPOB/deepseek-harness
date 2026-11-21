/** Shared event metadata and semantic-document projection. */

import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'
import { setImmediate } from 'node:timers/promises'
import { foldSurface, SurfaceFoldAccumulator } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord, SessionEventSearchDocument, SessionEventSurface } from './types.ts'
import { SessionQueryError } from './config.ts'
import { extractSessionEventText } from './extraction.ts'

/**
 * Project a raw log into lightweight surface-aware event records.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns one record per event in ascending seq order.
 */
export function buildSessionEventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  const surfaceBySeq = classifySurface(events)
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: surfaceBySeq.get(event.seq) ?? 'log-only',
  }))
}

/**
 * Build first-party semantic documents for one complete raw event log.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @returns searchable documents in ascending seq order; structural events are omitted.
 */
export function buildSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  const surfaceBySeq = classifySurface(events)
  const documents: SessionEventSearchDocument[] = []
  for (const event of events) {
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    documents.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: surfaceBySeq.get(event.seq) ?? 'log-only',
      text,
    })
  }
  return documents
}

/**
 * Project an immutable live log cut without monopolizing the Host event loop.
 * @param sessionId - session that owns the log.
 * @param events - complete contiguous raw event log.
 * @param signal - service lifecycle cancellation.
 * @returns the same documents as the synchronous projection.
 */
export async function buildSessionEventSearchDocumentsBatched(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  signal: AbortSignal,
): Promise<SessionEventSearchDocument[]> {
  const fold = new SurfaceFoldAccumulator(currentSessionMessageProjections)
  const surfaceBySeq = new Map<SessionSeq, SessionEventSurface>()
  const batch = 128
  try {
    for (let offset = 0; offset < events.length; offset += batch) {
      for (const event of events.slice(offset, offset + batch)) {
        const replaced = fold.append(event, events)
        if (replaced !== undefined) {
          for (const seq of replaced.shadowedSeqs) surfaceBySeq.set(seq, 'shadowed')
        }
      }
      if (offset + batch < events.length) await setImmediate(undefined, { signal })
    }
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw invalidSurface(error)
  }
  const nodes = fold.nodes
  for (let offset = 0; offset < nodes.length; offset += batch) {
    for (const seq of nodes.slice(offset, offset + batch)) surfaceBySeq.set(seq, 'current')
    if (offset + batch < nodes.length) await setImmediate(undefined, { signal })
  }
  const documents: SessionEventSearchDocument[] = []
  for (let offset = 0; offset < events.length; offset += batch) {
    for (const event of events.slice(offset, offset + batch)) {
      const text = extractSessionEventText(event)
      if (text.length !== 0) documents.push({
        sessionId, seq: event.seq, type: event.type, time: event.time,
        surface: surfaceBySeq.get(event.seq) ?? 'log-only', text,
      })
    }
    if (offset + batch < events.length) await setImmediate(undefined, { signal })
  }
  return documents
}

function invalidSurface(error: unknown): SessionQueryError {
  return new SessionQueryError(
    `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
    'SESSION_QUERY_INVALID_SURFACE', { cause: error },
  )
}

function classifySurface(events: readonly SessionEvent[]): Map<SessionSeq, SessionEventSurface> {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events, currentSessionMessageProjections)
  } catch (error: unknown) {
    throw invalidSurface(error)
  }
  const result = new Map<SessionSeq, SessionEventSurface>()
  for (const seq of folded.nodes) result.set(seq, 'current')
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) result.set(seq, 'shadowed')
  }
  return result
}

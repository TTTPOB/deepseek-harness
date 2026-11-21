/** Structured-clone messages between the SQLite search service and its worker. */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { Config as JsonlConfig } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEventSearchDocument, SessionEventSearchPage, SessionQueryErrorCode, SessionSearchHit, SessionSearchPage } from '@deepseek-ai/dsh-session-query'
import type { NormalizedEventRequest, NormalizedSessionRequest } from './query.ts'
import type { JournalMode, Synchronous } from './schema.ts'

/** A logical log ready for worker-side projection. */
export interface SearchLog {
  header: SessionHeader
  inheritedEventCount: SessionLogOffset
  events: readonly SessionEvent[]
}

/** An exact projection of one logical log. */
export interface ObservedSession extends Omit<SearchLog, 'events'> {
  documents: SessionEventSearchDocument[]
}

/** A live projection tagged with the Host's lifecycle epoch. */
export interface ObservedLiveSession extends ObservedSession {
  fingerprint: string
}

/** Validated cloneable subset of the plugin configuration. */
export interface WorkerConfig {
  path: string
  keysPath: string
  journalMode: JournalMode
  synchronous: Synchronous
  snippetChars: number
  maxIndexedSessionBytes: number
}

/** Worker-side scan and write commands. A binding change invalidates old work. */
export type Command =
  | { kind: 'open' }
  | { kind: 'keys' }
  | { kind: 'bind'; epoch: number; jsonl?: JsonlConfig }
  | { kind: 'list'; epoch: number }
  | { kind: 'snapshots'; epoch: number; from: number; limit: number }
  | { kind: 'stat'; epoch: number; id: SessionId }
  | { kind: 'stored'; epoch: number; snapshot: SessionPersistenceSnapshot; reuseDisk: boolean; log?: SearchLog }
  | { kind: 'live'; epoch: number; id: SessionId; entry?: ObservedLiveSession; persisted: boolean }
  | { kind: 'indexed'; epoch: number; after: string; limit: number }
  | { kind: 'remove'; epoch: number; ids: readonly SessionId[] }
  | { kind: 'sessions'; epoch: number; request: NormalizedSessionRequest; persisted: boolean }
  | { kind: 'events'; epoch: number; request: NormalizedEventRequest; persisted: boolean }

/** Result type paired with each command kind. */
export interface Result {
  open: undefined
  keys: boolean
  bind: undefined
  list: number
  snapshots: readonly SessionPersistenceSnapshot[]
  stat: SessionPersistenceSnapshot | undefined
  stored: 'current' | 'needs-log' | 'changed' | 'written'
  live: undefined
  indexed: readonly SessionId[]
  remove: undefined
  sessions: SessionSearchPage<SessionSearchHit>
  events: SessionEventSearchPage
}

/** An in-flight command tagged with a locally unique response id. */
export interface WorkerRequest {
  readonly id: number
  readonly command: Command
}

/** A typed failure or successful result from the single SQLite owner. */
export type WorkerResponse = { id: number } & (
  | { ok: true; result: Result[keyof Result] }
  | { ok: false; code: SessionQueryErrorCode; message: string }
)

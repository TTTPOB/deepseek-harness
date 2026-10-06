/** Bounded immutable snapshots for metadata-list continuations. */

import { randomUUID } from 'node:crypto'
import { SessionSearchCursor } from './cursor.ts'
import { SessionQueryError } from './config.ts'
import type { SessionRecord, SessionSearchPage } from './types.ts'

interface Snapshot {
  records: readonly SessionRecord[]
  filters: string
  expiresAt: number
  persistenceIdentity: symbol | undefined
}

/** Retains one immutable metadata array per active listing, never a plugin database. */
export class SessionPages {
  private readonly snapshots = new Map<string, Snapshot>()

  /**
   * @param ttlMs - fixed lifetime of a listing snapshot.
   * @param capacity - maximum concurrent retained snapshots.
   */
  constructor(private readonly ttlMs: number, private readonly capacity: number) {}

  /** Release all retained metadata on service disposal. */
  clear(): void { this.snapshots.clear() }

  /**
   * Begin a listing snapshot, retaining it only when continuation is needed.
   * @param records - detached filtered records in newest-first order.
   * @param filters - normalized filter fingerprint.
   * @param limit - requested positive page size.
   * @param persistenceIdentity - current persistence source, or undefined without persistence.
   * @returns detached first page and optional continuation.
   */
  first(
    records: readonly SessionRecord[],
    filters: string,
    limit: number,
    persistenceIdentity: symbol | undefined,
  ): SessionSearchPage<SessionRecord> {
    this.prune()
    const id = randomUUID()
    const snapshot = { records, filters, expiresAt: Date.now() + this.ttlMs, persistenceIdentity }
    if (records.length > limit) {
      while (this.snapshots.size >= this.capacity) {
        const oldest = this.snapshots.keys().next().value
        if (oldest !== undefined) this.snapshots.delete(oldest)
      }
      this.snapshots.set(id, snapshot)
    }
    return this.page(id, snapshot, 0, limit)
  }

  /**
   * Continue an existing listing without observing newer insertions or deletions.
   * @param cursor - opaque snapshot and position.
   * @param filters - fingerprint identical to the first request.
   * @param limit - requested positive page size; may change between pages.
   * @param persistenceIdentity - current persistence source; replacement invalidates the snapshot.
   * @returns detached next page.
   */
  next(
    cursor: SessionSearchCursor,
    filters: string,
    limit: number,
    persistenceIdentity: symbol | undefined,
  ): SessionSearchPage<SessionRecord> {
    this.prune()
    const match = /^session-page:([\w-]+):(\d+)$/.exec(cursor)
    if (match === null) throw new SessionQueryError('invalid session page cursor', 'SESSION_QUERY_INVALID_CURSOR')
    const id = match[1] as string
    const offset = Number(match[2])
    const snapshot = this.snapshots.get(id)
    if (snapshot === undefined || snapshot.persistenceIdentity !== persistenceIdentity) throw new SessionQueryError('session page snapshot expired, was evicted, or belongs to another persistence source', 'SESSION_QUERY_STALE_CURSOR')
    if (snapshot.filters !== filters || !Number.isSafeInteger(offset) || offset < 1 || offset >= snapshot.records.length) {
      throw new SessionQueryError('session page cursor does not match this request', 'SESSION_QUERY_INVALID_CURSOR')
    }
    return this.page(id, snapshot, offset, limit)
  }

  private page(id: string, snapshot: Snapshot, offset: number, limit: number): SessionSearchPage<SessionRecord> {
    const end = Math.min(snapshot.records.length, offset + limit)
    return {
      items: structuredClone(snapshot.records.slice(offset, end)),
      ...end < snapshot.records.length ? { nextCursor: SessionSearchCursor(`session-page:${id}:${end}`) } : {},
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.snapshots.delete(id)
    }
  }
}

/**
 * Reject unbounded or non-integral page sizes before observing a source.
 * @param limit - caller-requested maximum page size.
 */
export function assertReadPageLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new SessionQueryError('limit must be a positive safe integer', 'SESSION_QUERY_INVALID_LIMIT')
  }
}

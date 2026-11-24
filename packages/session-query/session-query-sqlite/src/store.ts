/** Worker-owned FTS, live overlays, document keys and search cursors. */

import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, SessionSearchCursor } from '@deepseek-ai/dsh-session-query'
import type {
  SessionEventSearchHit, SessionEventSearchPage, SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue, SessionSearchPage,
} from '@deepseek-ai/dsh-session-query'
import { SharedBm25 } from './bm25.ts'
import type { ObservedLiveSession, ObservedSession } from './protocol.ts'
import {
  type NormalizedEventRequest, type NormalizedSessionRequest, FTS_HIGHLIGHT_END, FTS_HIGHLIGHT_START,
  assertFts5OuterPredicateCount, assertPortableBindingCount, buildEventWhere, buildSessionWhere,
  makeSnippet, quoteFtsData, requestFingerprint, sanitizeFtsText,
} from './query.ts'

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
  score: number
}

/** Search read model. Only the worker may access its connection. */
export class SearchStore {
  private readonly _bm25: SharedBm25
  private mainGeneration: number
  private readonly observedRevisions = new Map<SessionId, SessionPersistenceRevision>()

  /** @param db - connection with complete keys and connection-local schemas.
   * @param snippetChars - maximum snippet code points.
   */
  constructor(private readonly db: DatabaseSync, private readonly snippetChars: number) {
    this._bm25 = new SharedBm25(db)
    const { global_generation } = db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1')
      .get() as { global_generation: number }
    this.mainGeneration = global_generation
  }

  /** Discard revision observations from the previous persistence source. */
  resetObservedRevisions(): void {
    this.observedRevisions.clear()
  }

  /**
   * @param id - stored session identity.
   * @param revision - revision reported by the mounted backend.
   * @param reuseDisk - whether revisions from previous process runs can be reused.
   * @returns whether the index already contains this exact revision.
   */
  hasRevision(id: SessionId, revision: SessionPersistenceRevision, reuseDisk: boolean): boolean {
    if (!reuseDisk) return this.observedRevisions.get(id) === revision
    const row = this.db.prepare('SELECT revision FROM persisted_sessions WHERE id = ?').get(id)
    return row?.revision === revision
  }

  /**
   * @param after - exclusive id checkpoint, or the initial empty lower bound.
   * @param limit - maximum number of indexed ids to return.
   * @returns indexed identities in ascending id order.
   */
  listIds(after: string, limit: number): SessionId[] {
    return (this.db.prepare('SELECT id FROM persisted_sessions WHERE id > ? ORDER BY id LIMIT ?')
      .all(after, limit) as Array<{ id: SessionId }>).map(row => row.id)
  }

  /**
   * Replace one stored revision and its documents in one transaction.
   * @param entry - validated projection of the matching log.
   * @param revision - exact backend revision.
   */
  writeStored(entry: ObservedSession, revision: SessionPersistenceRevision): void {
    this.durableTransaction(generation => this._replacePersistedSession(entry, revision, generation))
    this.observedRevisions.set(entry.header.id, revision)
  }

  /**
   * Remove absent or oversized stored sessions in one transaction.
   * @param ids - identities absent from the source.
   */
  removeStored(ids: readonly SessionId[]): void {
    const exists = this.db.prepare('SELECT 1 FROM persisted_sessions WHERE id = ?')
    const present = ids.filter(id => exists.get(id) !== undefined)
    if (present.length === 0) return
    this.durableTransaction(() => {
      for (const id of present) this._deleteSession('persisted', id)
    })
    for (const id of present) this.observedRevisions.delete(id)
  }

  /**
   * Replace or retire one live overlay, leaving durable rows untouched.
   * @param id - identity of the overlay.
   * @param entry - exact live projection, absent when retired.
   * @param persisted - whether the identity is visible to persistence.
   */
  writeLive(id: SessionId, entry: ObservedLiveSession | undefined, persisted: boolean): void {
    const row = this.db.prepare('SELECT fingerprint, persisted FROM temp.live_sessions WHERE id = ?').get(id)
    if (entry === undefined ? row === undefined : row?.fingerprint === entry.fingerprint && row.persisted === Number(persisted)) return
    this.transaction(() => {
      if (entry === undefined) this._deleteSession('live', id)
      else this._replaceLiveSession(entry, persisted)
    })
  }

  /**
   * @param request - normalized across-session search request.
   * @param persisted - whether to include stored history.
   * @returns one ranked page and a request-bound continuation over the current corpus.
   */
  searchSessions(request: NormalizedSessionRequest, persisted: boolean): SessionSearchPage<SessionSearchHit> {
    const digest = requestDigest(request)
    const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor, digest)
    const rows = this._querySessions(request, offset, persisted)
    return page(rows, request.limit, row => this._sessionHit(row), digest, offset)
  }

  /**
   * @param request - normalized single-session search request.
   * @param persisted - whether to include stored history.
   * @returns the target's header and one ranked event page over the current corpus.
   */
  searchEvents(request: NormalizedEventRequest, persisted: boolean): SessionEventSearchPage {
    const digest = requestDigest(request)
    const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor, digest)
    return {
      session: this._targetHeader(request.sessionId, persisted),
      ...page(this._queryEvents(request, offset, persisted), request.limit, row => this._eventHit(row), digest, offset),
    }
  }

  private durableTransaction(write: (generation: number) => void): void {
    const generation = this.mainGeneration + 1
    this.transaction(() => {
      write(generation)
      this.db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(generation)
      this.db.prepare('UPDATE keys.key_state SET main_generation = ? WHERE singleton = 1').run(generation)
    })
    this.mainGeneration = generation
    this._bm25.invalidate()
  }

  private transaction(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      write()
      this.db.exec('COMMIT')
    } catch (error: unknown) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this.db
    const { docs, keys } = documentTables(source)
    const rows = db.prepare(`SELECT doc_rowid FROM ${keys} WHERE session_id = ?`).all(id) as Array<{ doc_rowid: number }>
    const removeDocument = db.prepare(`DELETE FROM ${docs} WHERE rowid = ?`)
    const removeLength = source === 'live' ? db.prepare('DELETE FROM temp.live_token_lengths WHERE rowid = ?') : undefined
    for (const { doc_rowid: rowid } of rows) {
      removeDocument.run(rowid)
      removeLength?.run(rowid)
    }
    db.prepare(`DELETE FROM ${keys} WHERE session_id = ?`).run(id)
    db.prepare(`DELETE FROM ${source === 'live' ? 'temp.live_sessions' : 'persisted_sessions'} WHERE id = ?`).run(id)
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    const db = this.db
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

  private _replaceLiveSession(entry: ObservedLiveSession, persisted: boolean): void {
    const db = this.db
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version, created_at=excluded.created_at,
        cwd=excluded.cwd, parent_session=excluded.parent_session, seed_length=excluded.seed_length,
        delegation_depth=excluded.delegation_depth, agent_preset=excluded.agent_preset,
        fingerprint=excluded.fingerprint, persisted=excluded.persisted
    `).run(
      ...headerBindings(entry.header, entry.inheritedEventCount),
      entry.fingerprint,
      persisted ? 1 : 0,
    )
    this._upsertDocuments('live', entry)
  }

  private _upsertDocuments(source: 'persisted' | 'live', entry: ObservedSession): void {
    const db = this.db
    const { docs: table, keys } = documentTables(source)
    // CROSS JOIN pins the indexed key table as the outer loop; FTS rows are then fetched by rowid.
    const rows = db.prepare(`SELECT d.rowid AS rowid, d.seq AS seq, d.text AS text, d.type AS type,
      d.time AS time, d.surface AS surface
      FROM ${keys} k CROSS JOIN ${table} d ON d.rowid = k.doc_rowid
      WHERE k.session_id = ?`).all(entry.header.id) as Array<{
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
    const insertKey = db.prepare(`INSERT INTO ${keys} (doc_rowid, session_id, seq) VALUES (?, ?, ?)`)
    const removeKey = db.prepare(`DELETE FROM ${keys} WHERE doc_rowid = ?`)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      const row = existing.get(document.seq)
      existing.delete(document.seq)
      let rowid: number
      if (row === undefined) {
        const inserted = insert.run(text, document.sessionId, document.seq, document.type,
          document.time, document.surface, Array.from(text).length)
        rowid = Number(inserted.lastInsertRowid)
        insertKey.run(rowid, document.sessionId, document.seq)
      } else {
        rowid = row.rowid
        if (row.text !== text || row.type !== document.type
          || row.time !== document.time || row.surface !== document.surface) {
          update.run(text, document.type, document.time, document.surface, Array.from(text).length, rowid)
        }
      }
      if (source === 'live' && (row === undefined || row.text !== text)) {
        db.prepare('INSERT OR REPLACE INTO temp.live_token_lengths VALUES (?,?)')
          .run(rowid, this._bm25.tokenCount(text))
      }
    }
    for (const row of existing.values()) {
      remove.run(row.rowid)
      removeKey.run(row.rowid)
      if (source === 'live') db.prepare('DELETE FROM temp.live_token_lengths WHERE rowid=?').run(row.rowid)
    }
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persisted: boolean,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persisted, this._bm25.parameters(request.query)),
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
      ...pageHighlightParams(request.query),
    ]
    assertPortableBindingCount(bindings.length)
    return this.db.prepare(`
      ${selected.sql},
      filtered AS MATERIALIZED (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY score ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      ),
      page AS (
        SELECT * FROM ranked
        WHERE event_rank = 1
        ORDER BY score ASC, time DESC, session_id ASC, seq DESC
        LIMIT ? OFFSET ?
      )
      SELECT page.*, ${pageHighlightSql()} AS marked_text FROM page
      ORDER BY score ASC, time DESC, session_id ASC, seq DESC
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persisted: boolean,
  ): SearchRow[] {
    const selected = selectedDocumentsSql(true)
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(
        request.query, persisted, this._bm25.parameters(request.query), request.sessionId,
      ),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
      ...pageHighlightParams(request.query),
    ]
    assertPortableBindingCount(bindings.length)
    return this.db.prepare(`
      ${selected.sql},
      filtered AS MATERIALIZED (SELECT * FROM matched WHERE ${where}),
      page AS (
        SELECT * FROM filtered
        ORDER BY score ASC, time DESC, seq DESC
        LIMIT ? OFFSET ?
      )
      SELECT page.*, ${pageHighlightSql()} AS marked_text FROM page
      ORDER BY score ASC, time DESC, seq DESC
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetHeader(sessionId: SessionId, persisted: boolean): SessionHeader {
    const db = this.db
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as SessionHeaderRow | undefined
    if (live !== undefined) return rowHeader(live)
    if (persisted) {
      const stored = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as SessionHeaderRow | undefined
      if (stored !== undefined) return rowHeader(stored)
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
      snippet: makeSnippet(row.marked_text, this.snippetChars),
    }
  }

}

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

/** FTS document table and its session-indexed rowid key table for one source. */
function documentTables(source: 'persisted' | 'live'): { docs: string; keys: string } {
  return source === 'live'
    ? { docs: 'temp.live_docs', keys: 'temp.live_doc_keys' }
    : { docs: 'persisted_docs', keys: 'keys.persisted_doc_keys' }
}

function selectedDocumentsSql(target = false): { sql: string } {
  const metadata = (d: string, s: string) => `${d}.rowid AS document_rowid, ${d}.session_id,
    ${s}.version, ${s}.created_at, ${s}.cwd, ${s}.parent_session,
    ${s}.seed_length, ${s}.delegation_depth, ${s}.agent_preset`
  const event = (d: string) => `CAST(${d}.seq AS INTEGER) seq, ${d}.type,
    CAST(${d}.time AS INTEGER) time, ${d}.surface`
  // FTS auxiliary functions run in their MATCH SELECT, before outer arithmetic/window sorting.
  // Common IDF cancels for a single phrase. Round normalized scores to preserve cross-source metadata ties.
  const tf = '(1.2*(0.25+0.75*l.token_count/b.avg_live)*(-native_score)/(2.2*b.idf_live+native_score))'
  return { sql: `WITH background(avg_live,avg_history,idf_history,idf_live) AS (VALUES(?,?,?,?)),
    hraw AS MATERIALIZED (
      SELECT ${metadata('pd', 'ps')}, 0 live, 1 persisted, ${event('pd')},
        bm25(persisted_docs) native_score
      FROM persisted_docs pd JOIN persisted_sessions ps ON ps.id=pd.session_id
      WHERE persisted_docs MATCH ? AND ?=1${target ? ' AND pd.session_id=?' : ''}
        AND NOT EXISTS(SELECT 1 FROM temp.live_sessions ls WHERE ls.id=pd.session_id)
    ),
    lraw AS MATERIALIZED (
      SELECT ${metadata('ld', 'ls')}, 1 live, CASE WHEN ?=1 THEN ls.persisted ELSE 0 END persisted,
        ${event('ld')}, bm25(live_docs) native_score
      FROM temp.live_docs ld JOIN temp.live_sessions ls ON ls.id=ld.session_id
      WHERE live_docs MATCH ?${target ? ' AND ld.session_id=?' : ''}
    ),
    matched AS (
      SELECT hraw.*,round(native_score/b.idf_history,12) score FROM hraw CROSS JOIN background b
      UNION ALL
      SELECT lraw.*,round(-2.2*${tf}/(${tf}+1.2*(0.25+0.75*l.token_count/b.avg_history)),12) score
      FROM lraw JOIN temp.live_token_lengths l ON l.rowid=lraw.document_rowid CROSS JOIN background b
    )` }
}

function selectedDocumentsParams(
  query: string, persistenceVisible: boolean, background: number[], sessionId?: SessionId,
): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  const target = sessionId === undefined ? [] : [sessionId]
  return [...background, expression, visible, ...target, visible, expression, ...target]
}

// Full highlighted text is produced only for the bounded result page, not window-sort rows.
function pageHighlightSql(): string {
  return `CASE WHEN page.live = 1 THEN (
    SELECT highlight(live_docs, 0, ?, ?) FROM temp.live_docs
    WHERE live_docs MATCH ? AND rowid = page.document_rowid
  ) ELSE (
    SELECT highlight(persisted_docs, 0, ?, ?) FROM persisted_docs
    WHERE persisted_docs MATCH ? AND rowid = page.document_rowid
  ) END`
}

function pageHighlightParams(query: string): Array<string | number> {
  const expression = quoteFtsData(query)
  return [FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, expression,
    FTS_HIGHLIGHT_START, FTS_HIGHLIGHT_END, expression]
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
  digest: string,
  offset: number,
): SessionSearchPage<Item> {
  return {
    items: rows.slice(0, limit).map(convert),
    ...rows.length > limit ? { nextCursor: SessionSearchCursor(`v2.${digest}.${offset + limit}`) } : {},
  }
}

function requestDigest(request: NormalizedSessionRequest | NormalizedEventRequest): string {
  return createHash('sha256').update(requestFingerprint(request)).digest().subarray(0, 12).toString('base64url')
}

function decodeCursor(cursor: SessionSearchCursorValue, digest: string): number {
  const match = /^v2\.([A-Za-z0-9_-]{16})\.(0|[1-9][0-9]*)$/u.exec(cursor)
  const offset = Number(match?.[2])
  if (match?.[1] !== digest || !Number.isSafeInteger(offset)) {
    throw new SessionQueryError('session-search cursor is invalid for this request', 'SESSION_QUERY_INVALID_CURSOR')
  }
  return offset
}

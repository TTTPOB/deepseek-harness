/** SQLite schema for the disposable session full-text read model. */

import type { DatabaseSync } from 'node:sqlite'
import { mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

/** Current derived-index schema version. Incompatible versions reset in place. */
export const SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8

/** SQLite application id protecting unrelated databases from derived resets. */
export const SESSION_QUERY_SQLITE_APPLICATION_ID = 0x44534851

/** Current document-key sidecar schema version. Incompatible versions rebuild in place. */
export const SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION = 1

/** SQLite application id of the document-key sidecar, distinct from the main index. */
export const SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID = 0x4453484b

const DOCUMENT_KEY_TABLES = new Set(['persisted_doc_keys', 'key_state'])

/** Supported SQLite journal modes. */
export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

const DERIVED_USER_TABLES = new Set([
  'search_state',
  'persisted_sessions',
  'persisted_docs',
  'persisted_docs_data',
  'persisted_docs_idx',
  'persisted_docs_content',
  'persisted_docs_docsize',
  'persisted_docs_config',
])

/**
 * Exclusively create a missing database file with owner-only permissions.
 * Existing files retain their modes, and errors other than `EEXIST` propagate.
 */
async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Open, validate, and initialize persistent and connection-local schemas.
 * The document-key sidecar is attached as schema `keys` and resynchronized
 * from the main index whenever its recorded generation differs, so the main
 * file keeps the upstream schema unchanged.
 * @param path - dedicated derived-index path or `:memory:`; missing filesystem paths are created owner-only.
 * @param journalMode - validated SQLite journal mode.
 * @param keysPath - dedicated document-key sidecar path or `:memory:`; must differ from `path`.
 * @returns initialized database handle owned by the search service.
 */
export async function openSearchDatabase(path: string, journalMode: JournalMode, keysPath: string): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  const keys = keysPath === ':memory:' ? keysPath : resolve(keysPath)
  if (actual !== ':memory:' && keys === actual) {
    throw new Error(`session-search keysPath must differ from path "${actual}"`)
  }
  for (const file of [actual, keys]) {
    if (file === ':memory:') continue
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await createDatabaseFile(file)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const userTables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== SESSION_QUERY_SQLITE_APPLICATION_ID) {
      throw new Error(`session-search database at "${actual}" belongs to another application`)
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new Error(`session-search database at "${actual}" is not an empty or recognized derived index`)
    }
    let reset = false
    if (applicationId === SESSION_QUERY_SQLITE_APPLICATION_ID) {
      assertDerivedUserTables(actual, userTables)
      if (version !== SESSION_QUERY_SQLITE_SCHEMA_VERSION) {
        resetDerivedSchema(db, userTables)
        reset = true
      }
    }
    db.prepare('ATTACH DATABASE ? AS keys').run(keys)
    const keyTables = listUserTables(db, 'keys')
    const { application_id: keysApplicationId } = db.prepare('PRAGMA keys.application_id').get() as { application_id: number }
    const { user_version: keysVersion } = db.prepare('PRAGMA keys.user_version').get() as { user_version: number }
    if (keysApplicationId !== 0 && keysApplicationId !== SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID) {
      throw new Error(`session-search document-key database at "${keys}" belongs to another application`)
    }
    if (keysApplicationId === 0 && keyTables.length > 0) {
      throw new Error(`session-search document-key database at "${keys}" is not an empty or recognized derived index`)
    }
    if (keysApplicationId === SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID) {
      const unknownTables = keyTables.filter(name => !DOCUMENT_KEY_TABLES.has(name))
      if (unknownTables.length > 0) {
        throw new Error(`session-search document-key database at "${keys}" has unrecognized user tables: ${unknownTables.join(', ')}`)
      }
      if (keysVersion !== SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION) resetDerivedSchema(db, keyTables, 'keys')
    }
    // Apply mutating pragmas only after refusing foreign or canonical files.
    // journalMode is a validated closed union, not caller-controlled SQL.
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    db.exec(`PRAGMA keys.journal_mode = ${journalMode.toUpperCase()}`)
    ensurePersistentSchema(db)
    ensureDocumentKeySchema(db)
    syncDocumentKeys(db, reset)
    ensureTemporarySchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function listUserTables(db: DatabaseSync, schema: 'main' | 'keys' = 'main'): string[] {
  const rows = db.prepare(
    `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name`,
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function assertDerivedUserTables(path: string, userTables: readonly string[]): void {
  const unknownTables = userTables.filter(name => !DERIVED_USER_TABLES.has(name))
  if (unknownTables.length > 0) {
    throw new Error(
      `session-search database at "${path}" has unrecognized user tables: ${unknownTables.join(', ')}`,
    )
  }
}

function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[], schema: 'main' | 'keys' = 'main'): void {
  for (const name of userTables) {
    db.exec(`DROP TABLE IF EXISTS ${schema}.${quoteIdentifier(name)}`)
  }
  db.exec(`PRAGMA ${schema}.user_version = 0`)
}

function ensurePersistentSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_state (
      singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `)
  db.exec('INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS persisted_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      revision       TEXT NOT NULL,
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
  db.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION}`)
}

function ensureDocumentKeySchema(db: DatabaseSync): void {
  db.exec(`PRAGMA keys.application_id = ${SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS keys.persisted_doc_keys (
      doc_rowid  INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL
    ) STRICT
  `)
  db.exec('CREATE INDEX IF NOT EXISTS keys.persisted_doc_keys_session ON persisted_doc_keys(session_id)')
  // A NULL generation means the sidecar has never matched the main index.
  db.exec(`
    CREATE TABLE IF NOT EXISTS keys.key_state (
      singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
      main_generation INTEGER
    ) STRICT
  `)
  db.exec('INSERT OR IGNORE INTO keys.key_state (singleton, main_generation) VALUES (1, NULL)')
  db.exec(`PRAGMA keys.user_version = ${SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION}`)
}

/**
 * Rebuild the sidecar from the main FTS table when it does not record the
 * main generation. Writers that update both files can be interrupted between
 * the two commits, and other index owners write only the main file; both
 * leave a generation mismatch that this single scan repairs.
 */
function syncDocumentKeys(db: DatabaseSync, force: boolean): void {
  const { global_generation: main } = db.prepare(
    'SELECT global_generation FROM main.search_state WHERE singleton = 1',
  ).get() as { global_generation: number }
  const { main_generation: recorded } = db.prepare(
    'SELECT main_generation FROM keys.key_state WHERE singleton = 1',
  ).get() as { main_generation: number | null }
  if (!force && recorded === main) return
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM keys.persisted_doc_keys')
    db.exec(`INSERT INTO keys.persisted_doc_keys (doc_rowid, session_id, seq)
      SELECT rowid, session_id, CAST(seq AS INTEGER) FROM main.persisted_docs`)
    db.prepare('UPDATE keys.key_state SET main_generation = ? WHERE singleton = 1').run(main)
    db.exec('COMMIT')
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

function ensureTemporarySchema(db: DatabaseSync): void {
  db.exec(`CREATE TEMP TABLE live_token_lengths(rowid INTEGER PRIMARY KEY, token_count INTEGER NOT NULL);
    CREATE VIRTUAL TABLE temp.token_probe USING fts5(text, tokenize='unicode61');
    CREATE VIRTUAL TABLE temp.token_vocab USING fts5vocab(temp,token_probe,instance);
    CREATE TEMP TABLE live_doc_keys(doc_rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL);
    CREATE INDEX temp.live_doc_keys_session ON live_doc_keys(session_id)`)
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS live_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      fingerprint    TEXT NOT NULL,
      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.live_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

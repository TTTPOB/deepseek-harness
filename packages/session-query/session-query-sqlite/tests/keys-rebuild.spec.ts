import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { openSearchDatabase, rebuildDocumentKeysBatch } from '../src/schema.ts'

it('resumes copying sidecar rows after close, and never marks a partial copy ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-key-resume-'))
  const path = join(directory, 'derived.db')
  const keys = path + '.keys.db'
  try {
    let checkpoint: number
    {
      using db = await openSearchDatabase(path, 'wal', keys, 'normal')
      db.exec(`WITH RECURSIVE offsets(seq) AS (
        VALUES (0) UNION ALL SELECT seq + 1 FROM offsets WHERE seq < 3999
      ) INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
        SELECT 'needle', 'session', seq, 'user/message', seq, 'current', 6 FROM offsets`)
      expect(rebuildDocumentKeysBatch(db)).toBe(false)
      expect(rebuildDocumentKeysBatch(db)).toBe(false)
      const state = db.prepare('SELECT main_generation, rebuild_cursor FROM keys.key_state').get()!
      expect(state.main_generation).toBeNull()
      checkpoint = Number(state.rebuild_cursor)
      expect(checkpoint).toBeGreaterThan(0)
      expect(db.prepare('SELECT max(doc_rowid) AS cursor FROM keys.persisted_doc_keys').get()?.cursor).toBe(checkpoint)
    }
    {
      using db = await openSearchDatabase(path, 'wal', keys, 'normal')
      expect(rebuildDocumentKeysBatch(db)).toBe(false)
      expect(db.prepare('SELECT rebuild_cursor FROM keys.key_state').get()?.rebuild_cursor).toBeGreaterThan(checkpoint)
      let finished = false
      for (let i = 0; i < 10 && !finished; i++) finished = rebuildDocumentKeysBatch(db)
      expect(finished).toBe(true)
      const indexed = db.prepare('SELECT doc_rowid, session_id, seq FROM keys.persisted_doc_keys ORDER BY doc_rowid').all()
      const expected = db.prepare('SELECT rowid AS doc_rowid, session_id, seq FROM persisted_docs ORDER BY rowid').all()
      expect(indexed).toEqual(expected)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('uses NORMAL only in WAL and applies the policy to both attached files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-sync-policy-'))
  const path = join(directory, 'derived.db')
  const keys = path + '.keys.db'
  try {
    const sync = new Map<string, unknown[]>()
    for (const [label, journal, synchronous] of [
      ['default', 'wal', undefined], ['wal-normal', 'wal', 'normal'], ['rollback-normal', 'delete', 'normal'],
    ] as const) {
      using db = await openSearchDatabase(path, journal, keys, synchronous)
      sync.set(label, ['main', 'keys'].map(schema => db.prepare(`PRAGMA ${schema}.synchronous`).get()?.synchronous))
    }
    expect(sync.get('rollback-normal')).toEqual(sync.get('default'))
    expect(sync.get('wal-normal')?.[0]).toBe(sync.get('wal-normal')?.[1])
    expect(sync.get('wal-normal')).not.toEqual(sync.get('default'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

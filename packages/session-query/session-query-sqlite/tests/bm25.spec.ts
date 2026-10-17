import { describe, expect, it } from 'vitest'
import { openSearchDatabase } from '../src/schema.ts'
import { SharedBm25 } from '../src/bm25.ts'
import { quoteFtsData } from '../src/query.ts'

function idf(s1: number, s2: number): number {
  return 1 / (2.2 * (2 / -s2 - 1 / -s1))
}

function sharedScore(native: number, dl: number, parameters: number[]): number {
  const [liveAverage, historyAverage, historicalIdf, liveIdf] = parameters as [number, number, number, number]
  const tf = 1.2 * (0.25 + 0.75 * dl / liveAverage) * -native / (2.2 * liveIdf + native)
  return -2.2 * historicalIdf * tf / (tf + 1.2 * (0.25 + 0.75 * dl / historyAverage))
}

describe('public FTS5 BM25 calibration', () => {
  it('calibrates arbitrary Unicode bodies, counts tokenless documents, and reproduces overlapping-phrase scores', async () => {
    const db = await openSearchDatabase(':memory:', 'wal')
    try {
      const scorer = new SharedBm25(db)
      const bodies = ['😀 !!!', 'café alpha alpha alpha', 'alpha alpha gap alpha alpha', '世界 新词', 'other '.repeat(31)]
      const insert = db.prepare('INSERT INTO persisted_docs(text) VALUES(?)')
      for (const text of bodies) insert.run(text)
      const lengths = bodies.map(text => scorer.tokenCount(text))
      for (const [index, text] of bodies.entries()) {
        db.prepare('INSERT INTO temp.live_docs(rowid,text) VALUES(?,?)').run(index + 1, text)
        db.prepare('INSERT INTO temp.live_token_lengths VALUES(?,?)').run(index + 1, lengths[index]!)
      }
      // Change only live corpus statistics, not the historical background or the matching bodies.
      db.prepare('INSERT INTO temp.live_docs(rowid,text) VALUES(100,?)').run('unrelated '.repeat(1000))
      db.prepare('INSERT INTO temp.live_token_lengths VALUES(100,1000)').run()
      for (const query of ['alpha', 'alpha alpha', 'CAFE', '新词']) {
        const parameters = scorer.parameters(query)
        expect(parameters[1]).toBeCloseTo(lengths.reduce((sum, dl) => sum + dl, 0) / bodies.length, 9)
        const expression = quoteFtsData(query)
        const native = db.prepare('SELECT rowid,bm25(persisted_docs) score FROM persisted_docs WHERE persisted_docs MATCH ?').all(expression)
        const live = db.prepare('SELECT rowid,bm25(live_docs) score FROM temp.live_docs WHERE live_docs MATCH ?').all(expression)
        expect(live.map(row => row['rowid'])).toEqual(native.map(row => row['rowid']))
        for (const [i, row] of live.entries()) {
          const dl = lengths[Number(row['rowid']) - 1]!
          expect(sharedScore(Number(row['score']), dl, parameters)).toBeCloseTo(Number(native[i]!['score']), 10)
        }
      }
      db.exec('DELETE FROM persisted_docs')
      scorer.invalidate()
      expect(scorer.usesLiveBackground()).toBe(true)
      db.prepare('INSERT INTO persisted_docs(text) VALUES(?)').run('😀 !!!')
      scorer.invalidate()
      expect(scorer.usesLiveBackground()).toBe(true)
      db.prepare('INSERT INTO persisted_docs(text) VALUES(?)').run('new background '.repeat(100))
      scorer.invalidate()
      expect(scorer.parameters('new')[1]).toBeCloseTo(100, 9)
    } finally { db.close() }
  })

  it('keeps scores finite for repeated terms near BM25 saturation and a live-only phrase', async () => {
    const db = await openSearchDatabase(':memory:', 'wal')
    try {
      const scorer = new SharedBm25(db)
      db.prepare('INSERT INTO persisted_docs(text) VALUES(?)').run('background '.repeat(1000))
      const body = 'alpha '.repeat(100_000)
      const dl = scorer.tokenCount(body)
      db.prepare('INSERT INTO temp.live_docs(rowid,text) VALUES(1,?)').run(body)
      db.prepare('INSERT INTO temp.live_token_lengths VALUES(1,?)').run(dl)
      const parameters = scorer.parameters('alpha alpha')
      const scores = db.prepare('SELECT bm25(live_docs) s1,bm25(live_docs,2.0) s2 FROM temp.live_docs WHERE live_docs MATCH ?').get('"alpha alpha"')!
      expect(idf(Number(scores['s1']), Number(scores['s2']))).toBeCloseTo(0.000001, 10)
      const actual = sharedScore(Number(scores['s1']), dl, parameters)
      const expected = -2.2 * 99_999 / (99_999 + 1.2 * (0.25 + 0.75 * dl / 1000))
      expect(Number.isFinite(actual)).toBe(true)
      expect(actual).toBeCloseTo(expected, 8)
    } finally { db.close() }
  })
})

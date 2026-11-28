import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { normalizeEventRequest } from '../src/query.ts'
import { openSearchDatabase } from '../src/schema.ts'
import { SearchStore } from '../src/store.ts'

async function scoreTwins(text: string, before: string[], after: string[]) {
  using db = await openSearchDatabase(':memory:', 'wal', ':memory:')
  const stored = SessionId('stored')
  const live = SessionId('live')
  db.exec(`INSERT INTO persisted_sessions(id,version,created_at,revision,generation)
    VALUES('stored',1,0,'test',0),('background',1,0,'test',0)`)
  const history = db.prepare(`INSERT INTO persisted_docs(text,session_id,seq,type,time,surface)
    VALUES(?,?,0,'user/message',0,'current')`)
  for (const body of before) history.run(body, 'background')
  history.run(text, stored)
  for (const body of after) history.run(body, 'background')
  db.exec("INSERT INTO temp.live_sessions(id,version,created_at,fingerprint,persisted) VALUES('live',1,0,'test',0)")
  db.prepare('INSERT INTO temp.live_token_lengths VALUES(1,?)').run(text.trim().split(' ').length)
  db.prepare(`INSERT INTO temp.live_docs(rowid,text,session_id,seq,type,time,surface)
    VALUES(1,?,?,0,'user/message',1,'current')`).run(text, live)

  const store = new SearchStore(db, 80)
  const request = normalizeEventRequest({ query: 'alpha beta' }, { defaultLimit: 10, maxLimit: 10 })
  return store['_queryPage'](request, 0, true)
}

it('breaks compound score ties by time when term counts and average length are asymmetric', async () => {
  const text = 'alpha ' + 'beta '.repeat(10) + 'filler '.repeat(14)
  const rows = await scoreTwins(text, ['background'], Array<string>(5).fill('background'))
  expect(rows.map(row => row.session_id)).toEqual([SessionId('live'), SessionId('stored')])
  expect(rows[0]!.score).toBe(rows[1]!.score)
})

it('keeps compound scores close across sources at an IDF rounding boundary', async () => {
  const text = 'alpha '.repeat(407) + 'beta ' + 'filler '.repeat(134)
  const background = Array.from({ length: 485 }, (_, i) => (i < 14 ? 'alpha ' : 'background ') + 'filler '.repeat(19))
  const rows = await scoreTwins(text, [], background)
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map(row => row.session_id))).toEqual(new Set([SessionId('live'), SessionId('stored')]))
  // A one-ULP error in the recovered historical IDF can cross the decimal rounding boundary.
  expect(Math.abs(rows[0]!.score - rows[1]!.score)).toBeLessThan(1e-9)
})

it('adds historical-IDF phrase scores and gives identical live and stored documents identical scores', async () => {
  using db = await openSearchDatabase(':memory:', 'wal', ':memory:')
  const text = 'alpha bridge alpha beta'
  const stored = SessionId('stored-twin')
  const live = SessionId('live-twin')
  const background = SessionId('background')
  const onlyAlpha = SessionId('only-alpha')
  const addHistoricalHeader = db.prepare('INSERT INTO persisted_sessions(id,version,created_at,revision,generation) VALUES(?,1,0,\'test\',0)')
  for (const id of [stored, background, onlyAlpha]) addHistoricalHeader.run(id)
  const history = db.prepare(`INSERT INTO persisted_docs(text,session_id,seq,type,time,surface)
    VALUES(?,?,0,'user/message',0,'current')`)
  history.run(text, stored)
  for (let i = 0; i < 10; i++) history.run('alpha common', background)
  history.run('alpha', onlyAlpha)
  db.prepare("INSERT INTO temp.live_sessions(id,version,created_at,fingerprint,persisted) VALUES(?,1,0,'test',0)").run(live)
  db.prepare('INSERT INTO live_docs(rowid,text,session_id,seq,type,time,surface) VALUES(1,?,?,0,\'user/message\',1,\'current\')')
    .run(text, live)
  db.exec('INSERT INTO temp.live_token_lengths VALUES(1,4)')
  const store = new SearchStore(db, 80)
  const scoreRows = (query: string) => store['_queryPage'](normalizeEventRequest({
    query, sessionFilters: [{ kind: 'id', values: [stored, live, onlyAlpha] }],
  }, { defaultLimit: 10, maxLimit: 10 }), 0, true)
  const nativeScores = (id: string, phrase: string) => Number(db.prepare(
    'SELECT bm25(persisted_docs) score FROM persisted_docs WHERE persisted_docs MATCH ? AND session_id = ?',
  ).get(phrase, id)?.score)

  const and = scoreRows('alpha beta')
  expect(and.map(row => row.session_id)).toEqual([live, stored])
  expect(and[0]!.score).toBe(and[1]!.score)
  expect(and[0]!.score).toBeCloseTo(nativeScores(stored, 'alpha') + nativeScores(stored, 'beta'), 10)
  const or = scoreRows('alpha OR beta')
  expect(or.map(row => row.session_id)).toEqual([live, stored, onlyAlpha])
  expect(or[2]!.score).toBeCloseTo(nativeScores(onlyAlpha, 'alpha'), 10)
  expect(scoreRows('alpha OR ALPHA OR beta').map(row => row.score)).toEqual(or.map(row => row.score))
})

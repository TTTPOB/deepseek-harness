import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { normalizeEventRequest } from '../src/query.ts'
import { openSearchDatabase } from '../src/schema.ts'
import { SearchStore } from '../src/store.ts'

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

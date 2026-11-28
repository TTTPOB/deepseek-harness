import { describe, expect, it } from 'vitest'
import { SharedBm25 } from '../src/bm25.ts'
import { parseSearchQuery } from '../src/query-syntax.ts'
import { openSearchDatabase } from '../src/schema.ts'

async function fixture(documents: readonly string[] = []) {
  const db = await openSearchDatabase(':memory:', 'wal', ':memory:')
  const scorer = new SharedBm25(db)
  const compile = (query: string) => parseSearchQuery(query, text => scorer.tokenKey(text))
  const insert = db.prepare('INSERT INTO persisted_docs(text) VALUES(?)')
  for (const document of documents) insert.run(document)
  const match = (query: string) => db.prepare('SELECT text FROM persisted_docs WHERE persisted_docs MATCH ? ORDER BY rowid')
    .all(compile(query).expression).map(row => row.text)
  return { compile, match, [Symbol.dispose]: () => db.close() }
}

describe('query syntax on the unicode61 index', () => {
  it('binds uppercase OR tighter than implicit or explicit AND, unless grouped', async () => {
    using f = await fixture(['beta gap alpha', 'gamma alpha', 'gamma alone', 'alpha alone'])
    const intersection = ['beta gap alpha', 'gamma alpha']
    expect(f.match('alpha beta OR gamma')).toEqual(intersection)
    expect(f.match('alpha AND beta OR gamma')).toEqual(intersection)
    expect(f.match('(alpha beta) OR gamma')).toEqual([...intersection, 'gamma alone'])
  })

  it('quotes punctuation and lowercase operators, and applies prefixes only to bare terms', async () => {
    using f = await fixture([
      'reveal js academic source tmp docs beta and or not',
      'reveal spaced js academic source tmp docs beta and or not',
      'reveal json academic source tmp docs better and or not',
      'alpha quote OR NEAR beta',
    ])
    expect(f.match('reveal.js academic-source /tmp/docs bet* and or not')).toEqual([
      'reveal js academic source tmp docs beta and or not',
    ])
    expect(f.match('reveal.js* bet*')).toEqual([
      'reveal js academic source tmp docs beta and or not',
      'reveal json academic source tmp docs better and or not',
    ])
    expect(f.match('"bet*"')).toEqual([])
    expect(f.match('"quote ""OR"" NEAR"')).toEqual(['alpha quote OR NEAR beta'])
    expect(f.match('text:beta')).toEqual([])
  })

  it('excludes attached words, phrases and groups, but leaves a standalone dash inert', async () => {
    using f = await fixture(['alpha red blue', 'alpha blue red', 'alpha blue green', 'alpha green', 'alpha clear'])
    expect(f.match('alpha -blue')).toEqual(['alpha green', 'alpha clear'])
    expect(f.match('alpha -"red blue"')).toEqual(['alpha blue red', 'alpha blue green', 'alpha green', 'alpha clear'])
    expect(f.match('alpha -(blue green)')).toEqual(['alpha red blue', 'alpha blue red', 'alpha green', 'alpha clear'])
    expect(f.match('alpha -(blue -green)')).toEqual(['alpha blue green', 'alpha green', 'alpha clear'])
    expect(f.match('alpha -blue -green')).toEqual(['alpha clear'])
    expect(f.match('alpha - blue')).toEqual(['alpha red blue', 'alpha blue red', 'alpha blue green'])
  })

  it('ignores tokenless items and deduplicates positive token sequences only for scoring', async () => {
    using f = await fixture(['café clear', 'café food'])
    expect(f.match('café OR 🚀 - !!!')).toEqual(['café clear', 'café food'])
    expect(f.match('café OR (🚀)')).toEqual(['café clear', 'café food'])
    const parsed = f.compile('café OR CAFE caf* -food')
    expect(parsed.positivePhrases).toHaveLength(2)
    expect(f.match('café OR CAFE caf* -food')).toEqual(['café clear'])
    expect(() => f.compile('🚀 ... - "!!!" (*)')).toThrow(expect.objectContaining({ code: 'SESSION_QUERY_INVALID_QUERY' }))
  })

  it('rejects empty groups instead of dropping them from a query', async () => {
    using f = await fixture()
    for (const query of ['alpha OR ()', '() OR alpha', 'alpha OR (AND)', 'alpha OR (())', 'alpha ()', '()']) {
      expect(() => f.compile(query)).toThrow(expect.objectContaining({
        code: 'SESSION_QUERY_INVALID_QUERY', message: expect.stringMatching(/empty parenthesized group/u),
      }))
    }
  })

  it('compiles nested conjunctions and disjunctions like their flat equivalents', async () => {
    using f = await fixture()
    expect(f.compile('a (b AND (c d))')).toEqual(f.compile('a b c d'))
    expect(f.compile('a OR (b OR (c OR d))')).toEqual(f.compile('a OR b OR c OR d'))
  })

  it('reports unbalanced syntax, missing OR operands and negative-only scopes', async () => {
    using f = await fixture()
    for (const [query, message] of [
      ['a "b', /quote/u], ['a (b', /parenthesis/u], ['a b)', /parenthesis/u],
      ['a OR', /operand/u], ['OR b', /operand/u], ['a OR OR b', /operand/u], ['(a OR) b', /operand/u],
      ['a OR -b', /positive term/u], ['a (-b)', /positive term/u],
    ] as const) {
      expect(() => f.compile(query)).toThrow(expect.objectContaining({ code: 'SESSION_QUERY_INVALID_QUERY', message: expect.stringMatching(message) }))
    }
    for (const query of ['-a -b', '-"a b"', '-(a OR b)', '(-a)', '-a OR -b']) {
      expect(() => f.compile(query)).toThrow(expect.objectContaining({ code: 'SESSION_QUERY_EXCLUSION_ONLY' }))
    }
  })
})

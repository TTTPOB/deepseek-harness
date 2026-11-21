/** Exercise packed SQLite and its JSONL peer from an isolated pnpm installation. */

import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const prefix = process.argv[2]
assert(prefix, 'Usage: node tests/pack-smoke.mjs <isolated-installation-directory>')
const consumer = createRequire(resolve(prefix, 'package.json'))
const anchor = createRequire(consumer.resolve('@deepseek-ai/dsh-session-query-sqlite/package.json'))
const jsonl = '@deepseek-ai/dsh-session-persistence-jsonl'
assert.equal(await realpath(anchor.resolve(jsonl)), await realpath(consumer.resolve(jsonl)))
assert.match(await realpath(anchor.resolve('@deepseek-ai/dsh-session-query-sqlite/package.json')), /file\+/)
const load = (resolver, name) => import(pathToFileURL(resolver.resolve(name)).href)
const { Context } = await load(anchor, '@deepseek-ai/cordis')
const { default: Sqlite } = await load(consumer, '@deepseek-ai/dsh-session-query-sqlite')
const { default: SessionStore, SessionId, SessionSeq, SESSION_FORMAT_VERSION } = await load(anchor, '@deepseek-ai/dsh-session')
const { createUserMessage } = await load(consumer, '@deepseek-ai/dsh-llm')
const persistencePlugin = await load(consumer, jsonl)
const root = await mkdtemp(join(tmpdir(), 'dsh-search-packed-worker-'))
const ctx = new Context()
try {
  await ctx.plugin(SessionStore)
  await ctx.plugin(persistencePlugin, { root: join(root, 'sessions'), compression: 'zstd' })
  const id = SessionId('packed-worker')
  const writer = await ctx.sessionPersistence.create({ id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false })
  try {
    await writer.append([{
      type: 'user/message', seq: SessionSeq(0), time: 1, surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: 'packed search needle' }], source: { kind: 'user' } }),
    }])
  } finally { await writer.close() }
  await ctx.plugin(Sqlite, { path: join(root, 'search.db'), openAt: 'first-search', synchronous: 'normal' })
  const request = { query: 'packed search needle' }
  await assert.rejects(ctx.sessionQuery.searchSessions(request), { code: 'SESSION_QUERY_INDEX_WARMING' })
  const deadline = performance.now() + 15_000
  for (;;) {
    try {
      const page = await ctx.sessionQuery.searchSessions(request)
      assert.deepEqual(page.items.map(hit => [hit.header.id, hit.persisted, hit.live]), [[id, true, false]])
      break
    } catch (error) {
      if (error.code !== 'SESSION_QUERY_INDEX_WARMING' || performance.now() >= deadline) throw error
      await delay(20)
    }
  }
  console.log('Packed worker resolved its JSONL peer and indexed a cold zstd log.')
} finally {
  try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
}

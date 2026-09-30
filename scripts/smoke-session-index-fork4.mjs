/** Isolated fork4 tarball resolution and in-process session handoff smoke; never launches a Host. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const packages = [
  ['@deepseek-ai/dsh-session-persistence-jsonl', '0.1.7-rc.2-fork1'],
  ['@deepseek-ai/dsh-session-query-sqlite', '0.1.7-rc.2-fork2'],
]
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, 2,
  'Usage: node scripts/smoke-session-index-fork4.mjs <persistence-jsonl.tgz> <session-query-sqlite.tgz>')
const runtime = await mkdtemp(join(tmpdir(), 'dsh-session-index-fork4-'))
try {
  for (const tarball of tarballs) await copyFile(tarball, join(runtime, basename(tarball)))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: 'session-index-fork4-smoke', private: true, type: 'module', packageManager: 'pnpm@11.24.0',
    dependencies: { '@deepseek-ai/dsh': '0.1.7-rc.2' },
  }, null, 2) + '\n')
  const overrides = packages.map(([name], index) =>
    `  '${name}': 'file:./${basename(tarballs[index])}'`).join('\n')
  await writeFile(join(runtime, 'pnpm-workspace.yaml'),
    `packages:\n  - .\nblockExoticSubdeps: false\noverrides:\n${overrides}\n`)
  // Preserve the caller's user-level store rather than pnpm's temporary-filesystem fallback.
  const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], {
    encoding: 'utf8', timeout: 60_000,
  }).trim()
  execFileSync('pnpm', ['--store-dir', dirname(store), 'install', '--ignore-scripts'], {
    cwd: runtime, stdio: 'inherit', timeout: 600_000,
  })
  const runtimeRequire = createRequire(join(runtime, 'package.json'))
  const cliManifest = runtimeRequire.resolve('@deepseek-ai/dsh/package.json')
  assert.equal(JSON.parse(await readFile(cliManifest, 'utf8')).version, '0.1.7-rc.2')
  const cli = createRequire(cliManifest)
  const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
  const loaded = []
  const anchors = []
  for (const [name, version] of packages) {
    const manifest = await realpath(base.resolve(`${name}/package.json`))
    assert.match(manifest, /file\+/)
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, version)
    anchors.push(createRequire(manifest))
    loaded.push(await import(pathToFileURL(base.resolve(name)).href))
    console.log(`Resolved ${name}@${version}: ${manifest}`)
  }
  const [persistenceAnchor, queryAnchor] = anchors
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/cordis']) {
    assert.equal(await realpath(persistenceAnchor.resolve(name)), await realpath(queryAnchor.resolve(name)), name)
  }
  for (const [anchor, name] of [
    [persistenceAnchor, '@deepseek-ai/dsh-session'],
    [persistenceAnchor, '@deepseek-ai/dsh-session-persistence'],
    [queryAnchor, '@deepseek-ai/dsh-session-query'],
  ]) assert.equal(JSON.parse(await readFile(anchor.resolve(`${name}/package.json`), 'utf8')).version, '0.1.7-rc.2')
  const load = async (anchor, name) => import(pathToFileURL(anchor.resolve(name)).href)
  const { Context, Service } = await load(queryAnchor, '@deepseek-ai/cordis')
  const sessionModule = await load(persistenceAnchor, '@deepseek-ai/dsh-session')
  const persistenceModule = await load(persistenceAnchor, '@deepseek-ai/dsh-session-persistence')
  const queryModule = await load(queryAnchor, '@deepseek-ai/dsh-session-query')
  const projectionModule = await load(base, '@deepseek-ai/dsh-session-projection')
  const { createUserMessage } = await load(base, '@deepseek-ai/dsh-llm')
  const [persistenceFork, queryFork] = loaded
  assert(persistenceFork.default.prototype instanceof persistenceModule.default)
  assert(queryFork.default.prototype instanceof queryModule.default)
  assert(persistenceModule.default.prototype instanceof Service)
  assert.equal(queryFork.SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES, 33554432)
  assert.throws(() => new queryFork.default.Config({ path: ':memory:', maxIndexedSessionBytes: 0 }))
  const ctx = new Context()
  try {
    await ctx.plugin(sessionModule.default)
    await ctx.plugin(projectionModule.default)
    await ctx.plugin(persistenceFork.default, { root: join(runtime, 'sessions'), compression: 'none' })
    await ctx.plugin(queryFork.default, { path: join(runtime, 'search.db') })
    const counters = { list: 0, stat: 0, open: 0 }
    for (const name of Object.keys(counters)) {
      const original = ctx.sessionPersistence[name].bind(ctx.sessionPersistence)
      ctx.sessionPersistence[name] = (...args) => { counters[name] += 1; return original(...args) }
    }
    const session = ctx.sessions.prepare(sessionModule.SessionId('fork4-smoke'), { meta: { createdAt: 10 } })
    const writer = await ctx.sessionPersistence.create(session.header)
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    const append = text => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    append('initial needle')
    assert.equal((await ctx.sessionQuery.searchSessions({ query: 'initial needle' })).items.length, 1)
    const before = { ...counters }
    assert.equal((await ctx.sessionQuery.searchSessions({ query: 'initial needle' })).items.length, 1)
    assert.deepEqual(counters, before, 'Unchanged search observes no stored source')
    append('final tail needle')
    detach()
    const page = await ctx.sessionQuery.searchSessions({ query: 'final tail' })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].live, false)
    assert.equal(page.items[0].persisted, true)
    await writer.close()
    console.log('fork4 smoke: shared official Session/Cordis identity, built imports, unchanged search, and durable closing tail passed')
  } finally {
    await ctx.fiber.dispose()
  }
} finally {
  await rm(runtime, { recursive: true, force: true })
}

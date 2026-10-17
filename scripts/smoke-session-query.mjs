/** Isolated session-query artifacts, cold official Web Loader, and targeted read smoke. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'
const packages = plan('session-query').packages.map(pkg => [pkg.name, pkg.version])
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, 4,
  'Usage: node scripts/smoke-session-query.mjs <session-query.tgz> <persistence-jsonl.tgz> <session-query-sqlite.tgz> <session.tgz>')
const runtime = await mkdtemp(join(tmpdir(), 'dsh-session-index-artifact-'))
try {
  for (const tarball of tarballs) await copyFile(tarball, join(runtime, basename(tarball)))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: 'session-index-artifact-smoke', private: true, type: 'module', packageManager: packageManager,
    dependencies: { '@deepseek-ai/dsh': officialVersion },
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
  assert.equal(JSON.parse(await readFile(cliManifest, 'utf8')).version, officialVersion)
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
  const [definitionAnchor, persistenceAnchor, queryAnchor] = anchors
  for (const name of ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/cordis']) {
    assert.equal(await realpath(persistenceAnchor.resolve(name)), await realpath(queryAnchor.resolve(name)), name)
  }
  for (const [anchor, name] of [
    [persistenceAnchor, '@deepseek-ai/dsh-session'],
    [persistenceAnchor, '@deepseek-ai/dsh-session-persistence'],
    [queryAnchor, '@deepseek-ai/dsh-session-query'],
  ]) assert.equal(JSON.parse(await readFile(anchor.resolve(`${name}/package.json`), 'utf8')).version,
    name === '@deepseek-ai/dsh-session-query' ? packages[0][1]
      : name === '@deepseek-ai/dsh-session' ? packages[3][1] : officialVersion)
  assert.equal(await realpath(definitionAnchor.resolve('@deepseek-ai/dsh-session')),
    await realpath(queryAnchor.resolve('@deepseek-ai/dsh-session')))
  for (const [index, peers] of [[0, [3]], [2, [0, 3]]]) {
    const metadata = JSON.parse(await readFile(anchors[index].resolve(`${packages[index][0]}/package.json`), 'utf8'))
    for (const peer of peers) assert.equal(metadata.peerDependencies[packages[peer][0]], packages[peer][1])
  }
  const boot = await import(pathToFileURL(cli.resolve('@deepseek-ai/dsh-app-boot')).href)
  const home = join(runtime, 'home')
  const profile = join(home, 'profiles/web')
  const bin = join(dirname(cliManifest), 'lib/bin.js')
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(runtime, 'agents'), DSH_TELEMETRY_DISABLED: '1' }
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'session-query-web-smoke', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }) + '\n')
  for (const [name, version] of packages) {
    const manifest = JSON.parse(await readFile(base.resolve(`${name}/package.json`), 'utf8'))
    const issue = boot.evaluatePluginCompatibility(manifest)
    if (issue === undefined) continue
    assert(!issue.exempted)
    execFileSync(process.execPath, [bin, 'plugin', '--profile', 'web', 'allow-version',
      `${name}@${version}`, '--dsh-version', officialVersion, '--accept-risk'],
    { cwd: runtime, env, stdio: 'pipe', timeout: 60_000 })
    const exemptions = JSON.parse(await readFile(join(profile, 'compatibility.json'), 'utf8'))
    assert(boot.evaluatePluginCompatibility(manifest, exemptions).exempted)
  }
  const child = spawn(process.execPath, [bin, '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
    { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const completion = new Promise(resolveExit => child.once('close', resolveExit))
  try {
    const launchUrl = await new Promise((resolveReady, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('Official Web Loader did not become ready within 90s')), 90_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); reject(new Error(`Official Web Loader exited before readiness: ${code}`)) })
      const collect = chunk => {
        // Keep launch credentials only in memory; never print startup output.
        output = (output + chunk.toString()).slice(-64 * 1024)
        const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/.exec(output)
        if (match) { clearTimeout(timer); resolveReady(new URL(match[1])); output = '' }
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
    })
    const login = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert(cookie, 'Cold Web Loader supplies the localhost login cookie')
    const page = await fetch(launchUrl.origin, { headers: { cookie }, signal: AbortSignal.timeout(15_000) })
    assert.equal(page.status, 200)
    const html = await page.text()
    const rawBoot = /globalThis\["__DSH_BOOT__"\] = ([\s\S]*?)<\/script>/u.exec(html)?.[1]
    assert(rawBoot, 'Official Web serves its authenticated boot graph')
    assert(JSON.parse(rawBoot).entries.some(entry => entry.id === '@deepseek-ai/dsh-api-session-controller'),
      'Session controller activates with the paired query service')
    console.log('Cold official Web Loader and saved exact-version exemption passed')
  } finally {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    try { await completion } finally { clearTimeout(timer) }
  }
  const load = async (anchor, name) => import(pathToFileURL(anchor.resolve(name)).href)
  const { Context, Service } = await load(queryAnchor, '@deepseek-ai/cordis')
  const sessionModule = await load(persistenceAnchor, '@deepseek-ai/dsh-session')
  const persistenceModule = await load(persistenceAnchor, '@deepseek-ai/dsh-session-persistence')
  const queryModule = await load(queryAnchor, '@deepseek-ai/dsh-session-query')
  const projectionModule = await load(base, '@deepseek-ai/dsh-session-projection')
  const { createUserMessage } = await load(base, '@deepseek-ai/dsh-llm')
  const [queryDefinition, persistenceFork, queryFork, sessionFork] = loaded
  assert.equal(sessionFork, sessionModule)
  assert.equal(queryDefinition.default, queryModule.default)
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
    const session = ctx.sessions.prepare(sessionModule.SessionId('artifact-smoke'), { meta: { createdAt: 10 } })
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
    const prototype = sessionModule.SurfaceFoldAccumulator.prototype
    const originalAppend = prototype.append
    let folds = 0
    prototype.append = function (...args) { folds += 1; return originalAppend.apply(this, args) }
    try {
      const surface = await ctx.sessionQuery.readSurface(session.id)
      assert.deepEqual(surface.events.map(event => event.seq), [0])
      assert.equal(folds, 1, 'First canonical read folds the captured prefix')
      const trace = await ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: sessionModule.SessionSeq(0) })
      assert.equal(trace.target.surface, 'current')
      await ctx.sessionQuery.readSurface(session.id)
      assert.equal(folds, 1, 'Unchanged surface and trace share canonical analysis')
      append('final tail needle')
      const beforeTail = folds
      const updated = await ctx.sessionQuery.readSurface(session.id)
      assert.deepEqual(updated.events.map(event => event.seq), [0, 1])
      await ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: sessionModule.SessionSeq(1) })
      assert.equal(folds - beforeTail, 1, 'Append advances canonical analysis by one event')
      console.log('Packaged Session accumulator and canonical query reuse: first fold 1, unchanged 0, append 1')
    } finally {
      prototype.append = originalAppend
    }
    detach()
    const page = await ctx.sessionQuery.searchSessions({ query: 'final tail' })
    assert.equal(page.items.length, 1)
    assert.equal(page.items[0].live, false)
    assert.equal(page.items[0].persisted, true)
    await writer.close()
    const listBefore = counters.list
    const exact = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [session.id] }])
    assert.equal(exact.length, 1)
    assert.equal(exact[0].persisted, true)
    const titles = await ctx.sessionQuery.readTitleSnapshots([session.id])
    assert.equal(titles[0].status, 'fulfilled')
    assert.equal((await ctx.sessionQuery.readEvent({ sessionId: session.id, seq: sessionModule.SessionSeq(0) })).target.type, 'user/message')
    assert.equal(counters.list, listBefore, 'Exact metadata, titles and event reads do not enumerate the corpus')
    {
      const appendTo = (target, text) => target.append('user/message', createUserMessage({
        content: [{ type: 'text', text }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const ids = ['artifact-short', 'artifact-long'].map(id => sessionModule.SessionId(id))
      const texts = ['alpha alpha alpha', 'alpha alpha gap alpha alpha']
      for (let index = 0; index < ids.length; index += 1) {
        const stored = ctx.sessions.prepare(ids[index], { meta: { createdAt: 20 + index } })
        const storedWriter = await ctx.sessionPersistence.create(stored.header)
        const leave = ctx.sessions.enter(stored)
        ctx.sessions.announce(stored)
        appendTo(stored, texts[index])
        leave()
        await storedWriter.close()
      }
      const request = { query: 'alpha alpha' }
      const history = await ctx.sessionQuery.searchSessions(request)
      assert.deepEqual(history.items.map(item => item.header.id), ids,
        'BM25 ranks the shorter document first when actual phrase TF is equal')
      const live = ctx.sessions.prepare(ids[0], { meta: { createdAt: 20 } })
      appendTo(live, texts[0])
      const leaveLive = ctx.sessions.enter(live)
      ctx.sessions.announce(live)
      const unrelated = ctx.sessions.prepare(sessionModule.SessionId('artifact-unrelated'), { meta: { createdAt: 30 } })
      appendTo(unrelated, 'unrelated '.repeat(1000))
      const leaveUnrelated = ctx.sessions.enter(unrelated)
      ctx.sessions.announce(unrelated)
      try {
        const mixed = await ctx.sessionQuery.searchSessions(request)
        assert.deepEqual(mixed.items.map(item => item.header.id), ids,
          'Moving identical history to live with an unrelated long live document preserves ranking')
        assert.equal(mixed.items[0].live, true)
      } finally {
        leaveLive()
        leaveUnrelated()
      }
      const updated = ctx.sessions.prepare(ids[0], { meta: { createdAt: 20 } })
      appendTo(updated, 'fresh live marker')
      const leaveUpdated = ctx.sessions.enter(updated)
      ctx.sessions.announce(updated)
      try {
        const fresh = await ctx.sessionQuery.searchSessions({ query: 'fresh live marker' })
        assert.equal(fresh.items[0].header.id, ids[0])
        assert.equal(fresh.items[0].live, true)
        assert.deepEqual((await ctx.sessionQuery.searchSessions(request)).items.map(item => item.header.id), [ids[1]],
          'Latest live body shadows the old persisted phrase candidate')
      } finally {
        leaveUpdated()
      }
      console.log('artifact BM25 phrase ranking, mixed live/history stability, and latest live shadow passed')
    }
    console.log('Session-query smoke: shared official identities, built imports, unchanged search, durable closing tail, and targeted reads passed')
  } finally {
    await ctx.fiber.dispose()
  }
} finally {
  await rm(runtime, { recursive: true, force: true })
}

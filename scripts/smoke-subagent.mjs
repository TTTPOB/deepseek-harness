/** Isolated subagent built-entry and sibling-message ownership checks. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'
const [asset, ...extra] = process.argv.slice(2)
assert(asset && !extra.length, 'Usage: node scripts/smoke-subagent.mjs <subagent.tgz>')
const pkg = plan('subagent').packages[0]
const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], { encoding: 'utf8', timeout: 60_000 }).trim()
const runtime = await mkdtemp(join(tmpdir(), 'dsh-subagent-artifact-'))
try {
  await copyFile(resolve(asset), join(runtime, basename(asset)))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'subagent-artifact-smoke', private: true, type: 'module', packageManager, dependencies: { '@deepseek-ai/dsh': officialVersion } }))
  await writeFile(join(runtime, 'pnpm-workspace.yaml'), `packages:
  - .
blockExoticSubdeps: false
overrides:
  '${pkg.name}': 'file:./${basename(asset)}'
`)
  execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--store-dir', dirname(store), 'install', '--ignore-scripts'], { cwd: runtime, stdio: 'inherit', timeout: 600_000 })
  const local = createRequire(join(runtime, 'package.json'))
  const cli = createRequire(local.resolve('@deepseek-ai/dsh/package.json'))
  const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
  const manifest = await realpath(base.resolve(pkg.name + '/package.json'))
  assert.match(manifest, /file\+/)
  assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, pkg.version)
  const loaded = await import(pathToFileURL(base.resolve(pkg.name)).href)
  assert(Object.keys(loaded).length > 0)
  const directory = dirname(manifest)
  const { ContinuableActivationRegistry, ChildLock } = await import(pathToFileURL(join(directory, 'lib/types/continuation-activation.js')).href)
  const { SubagentContinuationManager } = await import(pathToFileURL(join(directory, 'lib/types/continuation.js')).href)
  const agents = [
    { id: 'root', session: { header: {} } },
    { id: 'a', session: { header: { parentSession: 'root' } } },
    { id: 'b', session: { header: { parentSession: 'root' } } },
  ]
  const [root, a, b] = agents
  const live = new Map(agents.map(agent => [agent.id, agent]))
  const ctx = { agents: { get: id => live.get(id) } }
  const registry = Object.create(ContinuableActivationRegistry.prototype)
  registry.ctx = ctx
  registry.resident = new Map()
  registry.closingScopes = new Map()
  registry.draining = false
  registry.locks = new ChildLock()
  for (const child of [a, b]) {
    registry.resident.set(child.id, {
      childId: child.id, parentSession: root.id, handle: { agent: child },
      inbox: { closing: undefined, hasPending: false },
      ownedChildren: new Set(), poke: Promise.withResolvers(),
    })
  }
  const manager = Object.create(SubagentContinuationManager.prototype)
  manager.ctx = ctx
  manager.activations = registry
  const signal = new AbortController().signal
  for (const [sender, target] of [[a, b], [b, a]]) {
    await assert.rejects(manager.sendMessage(sender, target.id, [{ type: 'text', text: 'cross-sibling' }], { signal }), /belongs to another parent session/)
  }
  for (const child of [a, b]) {
    const activation = registry.resident.get(child.id)
    assert.equal(activation.ownedChildren.size, 0, child.id)
    assert.equal(registry.settlementState(activation, activation.poke), 'ready', child.id)
  }
  console.log('Subagent built entry rejects sibling messages without orphaned holds')
} finally {
  await rm(runtime, { recursive: true, force: true })
}

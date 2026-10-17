/** Isolated subagent built-entry and manager message-ownership checks. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'

/** Check the installed manager without starting agents or a Host process. */
export async function checkSubagentManager(directory) {
  const { SubagentManager } = await import(pathToFileURL(join(directory, 'lib/types/manager.js')).href)
  const { ChildLock } = await import(pathToFileURL(join(directory, 'lib/types/activation.js')).href)
  const agents = [
    { id: 'root', session: { header: {} } },
    ...['a', 'b'].map(id => ({ id, session: { header: { parentSession: 'root' } }, inbox: { nextStep: [], nextTurn: [] } })),
  ]
  const [root, a, b] = agents
  const live = new Map(agents.map(agent => [agent.id, agent]))
  const manager = Object.create(SubagentManager.prototype)
  const observations = []
  const query = {
    async observeSession(id) {
      observations.push(id)
      return { header: { parentSession: id.startsWith('unresumable-') ? id.slice('unresumable-'.length) : root.id },
        events: [], inheritedEventCount: 0, [Symbol.dispose]() {} }
    },
  }
  manager.ctx = { agents: { get: id => live.get(id) }, get: name => name === 'sessionQuery' ? query : undefined }
  manager.resident = new Map()
  manager.closingScopes = new Map()
  manager.draining = false
  manager.locks = new ChildLock()
  for (const child of [a, b]) {
    manager.resident.set(child.id, {
      kind: 'local', childId: child.id, parent: root, handle: { agent: child },
      closing: undefined, ownedChildren: new Set(), poke: Promise.withResolvers(),
    })
  }
  const signal = new AbortController().signal
  const content = [{ type: 'text', text: 'cross-sibling' }]
  const held = []
  const holdOwnership = manager.holdOwnership.bind(manager)
  manager.holdOwnership = (parent, childId) => {
    held.push(childId)
    return holdOwnership(parent, childId)
  }
  for (const [sender, target] of [[a, b], [b, a]]) {
    await assert.rejects(manager.sendMessage(sender, target.id, content, { signal }), error =>
      error.code === 'UNAUTHORIZED' && /belongs to another parent session/.test(error.message))
  }
  assert.deepEqual(held, [], 'Resident sibling messages are rejected before acquiring a hold')
  assert.deepEqual(observations, [], 'Resident sibling denial does not read persistence')
  const parked = manager.resident.get(b.id)
  manager.resident.delete(b.id)
  await assert.rejects(manager.sendMessage(a, b.id, content, { signal }), error => error.code === 'UNAUTHORIZED')
  assert.deepEqual(held, [], 'Cold sibling messages are rejected before acquiring a hold')
  assert.deepEqual(observations, [b.id])
  manager.resident.set(b.id, parked)
  for (const child of [a, b]) {
    await assert.rejects(manager.sendMessage(child, 'unresumable-' + child.id, content, { signal }), error => error.code === 'NOT_RESUMABLE')
    const activation = manager.resident.get(child.id)
    assert.equal(activation.ownedChildren.size, 0, child.id)
    assert.equal(manager.settlementState(activation, activation.poke), 'ready', child.id)
  }
  assert.deepEqual(held, ['unresumable-a', 'unresumable-b'], 'Failed cold resume releases each admitted hold')
  console.log('Subagent manager rejects resident/cold sibling messages before holds and cleans up failed resume holds')
}

async function main() {
  const [asset, ...extra] = process.argv.slice(2)
  assert(asset && !extra.length, 'Usage: node scripts/smoke-subagent.mjs <subagent.tgz>')
  const pkg = plan('core').packages.find(pkg => pkg.directory === 'packages/subagent/subagent')
  const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], { encoding: 'utf8', timeout: 60_000 }).trim()
  const runtime = await mkdtemp(join(tmpdir(), 'dsh-subagent-artifact-'))
  try {
    await copyFile(resolve(asset), join(runtime, basename(asset)))
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: 'subagent-artifact-smoke', private: true, type: 'module', packageManager, dependencies: { '@deepseek-ai/dsh': officialVersion } }))
    await writeFile(join(runtime, 'pnpm-workspace.yaml'), JSON.stringify({ packages: ['.'], blockExoticSubdeps: false,
      overrides: { [pkg.name]: 'file:./' + basename(asset) } }))
    execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--store-dir', dirname(store), 'install', '--ignore-scripts'], { cwd: runtime, stdio: 'inherit', timeout: 600_000 })
    const local = createRequire(join(runtime, 'package.json'))
    const cli = createRequire(local.resolve('@deepseek-ai/dsh/package.json'))
    const base = createRequire(cli.resolve('@deepseek-ai/dsh-base/package.json'))
    const manifest = await realpath(base.resolve(pkg.name + '/package.json'))
    assert.match(manifest, /file\+/)
    assert.equal(JSON.parse(await readFile(manifest, 'utf8')).version, pkg.version)
    const loaded = await import(pathToFileURL(base.resolve(pkg.name)).href)
    assert(Object.keys(loaded).length > 0)
    await checkSubagentManager(dirname(manifest))
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

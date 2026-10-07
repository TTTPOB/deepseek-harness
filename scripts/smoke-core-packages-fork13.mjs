/** Verify four core tarballs with the official CLI, without personal plugins or a Host process. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

const names = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-mcp-client']
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, names.length, 'Usage: node scripts/smoke-core-packages-fork13.mjs <agent.tgz> <registry.tgz> <llm-pi-ai.tgz> <mcp-client.tgz>')
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const workspace = yaml.load(await readFile(join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8'))
const piSource = workspace.overrides['@earendil-works/pi-ai']
const parent = join(sourceRoot, 'dist/smoke')
await mkdir(parent, { recursive: true })
const root = await mkdtemp(join(parent, 'core-fork13-'))
const run = (args, cwd = root) => execFileSync('pnpm', ['--config.verify-deps-before-run=false', ...args], { cwd, stdio: 'inherit', timeout: 600_000 })
let ctx
try {
  for (const tarball of tarballs) await copyFile(tarball, join(root, basename(tarball)))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'core-fork13-smoke', private: true, type: 'module', packageManager: 'pnpm@11.24.0', dependencies: { '@deepseek-ai/dsh': '0.1.7-rc.2' } }))
  await writeFile(join(root, 'pnpm-workspace.yaml'), yaml.dump({ packages: ['.'], blockExoticSubdeps: false,
    overrides: { ...Object.fromEntries(names.map((name, index) => [name, 'file:./' + basename(tarballs[index])])), '@earendil-works/pi-ai': piSource } }))
  run(['install', '--ignore-scripts', '--config.enable-global-virtual-store=false'])
  const project = createRequire(join(root, 'package.json'))
  const host = await realpath(project.resolve('@deepseek-ai/dsh/package.json'))
  const hostRequire = createRequire(host)
  const load = async name => import(pathToFileURL(hostRequire.resolve(name)).href)
  const boot = await load('@deepseek-ai/dsh-app-boot')
  const { Context } = await load('@deepseek-ai/cordis')
  const home = join(root, 'home')
  const profileDirectory = join(home, 'profiles/web')
  await mkdir(profileDirectory, { recursive: true })
  const profileManifest = join(profileDirectory, 'package.json')
  await writeFile(profileManifest, JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  const profile = boot.loadProfileDirectory('core artifact smoke', profileDirectory, host)
  const resolution = await boot.createRuntimeResolution({ installAnchor: host, profile, home })
  ctx = new Context()
  await ctx.plugin(boot.PluginPackages, { resolution })
  const packages = []
  for (const name of names) {
    const selected = ctx.pluginPackages.packageOf(name, pathToFileURL(host).href)
    assert(selected, name)
    assert.equal(selected.version, '0.1.7-rc.2-fork1', name)
    const manifest = JSON.parse(await readFile(selected.manifestPath, 'utf8'))
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, '0.1.7-rc.2'), undefined, name)
    packages.push(await import(pathToFileURL(hostRequire.resolve(name)).href))
  }
  const [agent, presets, pi, mcp] = packages
  const { default: Schema } = await load('@deepseek-ai/schemastery')
  const [mcpConfig] = Schema.resolve({ transport: 'stdio', serverName: 'fixture', command: 'unused', maxBufferSize: 1048576 }, mcp.Config, {})
  assert.equal(mcpConfig.maxBufferSize, 1048576)
  assert.throws(() => Schema.resolve({ transport: 'stdio', serverName: 'fixture', command: 'unused', maxBufferSize: 0 }, mcp.Config, {}))
  const [piConfig] = Schema.resolve({}, pi.Config, {})
  assert.deepEqual(piConfig.providers.get(), {})
  const { Session, SessionId, default: SessionStore } = await load('@deepseek-ai/dsh-session')
  await ctx.plugin(agent.default)
  const events = []
  ctx.agents.setFactory({
    async createAgent(_owner, options) {
      const value = { id: options.sessionId, session: Session.create(options.sessionId), ctx, options: {}, status: 'idle' }
      const transaction = await options.setup?.(ctx, value)
      transaction?.commit()
      events.push('published')
      return { agent: value, dispose: async () => {} }
    },
  })
  const registration = await ctx.plugin(Object.assign(owner => {
    owner.agents.registerSetup(() => {
      events.push('contribution')
      return { commit: () => events.push('committed') }
    })
  }, { inject: ['agents'] }))
  await ctx.agents.create({ sessionId: SessionId('core-before') })
  assert.deepEqual(events, ['contribution', 'committed', 'published'])
  await registration.dispose()
  events.length = 0
  await ctx.agents.create({ sessionId: SessionId('core-after') })
  assert.deepEqual(events, ['published'])
  const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
  const { default: SessionProjections } = await load('@deepseek-ai/dsh-session-projection')
  ctx.baseUrl = pathToFileURL(root + '/').href
  await ctx.plugin(Loader)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(presets.default, { default: 'fixture' })
  await ctx.agentPresets.register({ id: 'fixture', plugins: [] })
  assert.equal(presets.livePresetMounts(ctx.fiber).length, 0)
  {
    await using lease = await ctx.agentPresets.acquireScope('fixture')
    const mounts = presets.livePresetMounts(ctx.fiber)
    assert.equal(mounts.length, 1)
    assert.equal(mounts[0].key, lease.key)
  }
  assert.equal(presets.livePresetMounts(ctx.fiber).length, 0)
  console.log('Four core artifacts resolve through official Host peers; packaged Config and awaited setup/disposal behavior passed. No personal plugins or Host process used.')
} finally {
  if (ctx) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

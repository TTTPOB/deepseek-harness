/** Verify core tarballs with the official CLI, without personal plugins or a Host process. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'
import { stageArtifactOverrides } from './daily-driver-artifacts.mjs'
const expected = plan('core').packages
const names = expected.map(pkg => pkg.name)
const artifact = name => names.indexOf('@deepseek-ai/dsh-' + name)
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, names.length, 'Usage: node scripts/smoke-core-packages.mjs <agent.tgz> <registry.tgz> <subagent.tgz> <llm-pi-ai.tgz> <mcp-client.tgz> <ptc-runtime-node.tgz> <tool-executor-ptc.tgz>')
const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], { encoding: 'utf8', timeout: 60_000 }).trim()
const root = await mkdtemp(join(tmpdir(), 'dsh-core-artifact-'))
const run = (args, cwd = root) => execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--store-dir', dirname(store), ...args], { cwd, stdio: 'inherit', timeout: 600_000 })
let ctx
try {
  await stageArtifactOverrides(root, expected, tarballs)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'core-artifact-smoke', private: true, type: 'module', packageManager, dependencies: { '@deepseek-ai/dsh': officialVersion } }))
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
    const anchor = host
    const selected = ctx.pluginPackages.packageOf(name, pathToFileURL(anchor).href)
    assert(selected, name)
    assert.equal(selected.version, expected.find(pkg => pkg.name === name).version, name)
    const manifest = JSON.parse(await readFile(selected.manifestPath, 'utf8'))
    const issue = boot.evaluatePluginCompatibility(manifest, {}, officialVersion)
    if (issue !== undefined) {
      const exemptions = { [`${name}@${manifest.version}`]: [officialVersion] }
      assert.equal(issue.exempted, false, name)
      assert.equal(boot.evaluatePluginCompatibility(manifest, exemptions, officialVersion).exempted, true, name)
    }
    packages.push(await load(name))
  }
  const [agent, presets, , pi, mcp] = packages
  const ptcRuntime = packages[artifact('ptc-runtime-node')]
  const { default: Schema } = await load('@deepseek-ai/schemastery')
  const [mcpConfig] = Schema.resolve({ transport: 'stdio', serverName: 'fixture', command: 'unused', maxBufferSize: 1048576 }, mcp.Config, {})
  assert.equal(mcpConfig.maxBufferSize, 1048576)
  assert.throws(() => Schema.resolve({ transport: 'stdio', serverName: 'fixture', command: 'unused', maxBufferSize: 0 }, mcp.Config, {}))
  const [piConfig] = Schema.resolve({}, pi.Config, {})
  assert.deepEqual(piConfig.providers.get(), {})
  const { Session, SessionId, default: SessionStore } = await load('@deepseek-ai/dsh-session')
  const { default: SessionProjections } = await load('@deepseek-ai/dsh-session-projection')
  await ctx.plugin(SessionProjections)
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
  ctx.baseUrl = pathToFileURL(root + '/').href
  await ctx.plugin(Loader)
  await ctx.plugin(SessionStore)
  await ctx.plugin(presets.default, { default: 'fixture' })
  let mounted = 0
  ctx.loader.builtins.fixture = owner => {
    mounted++
    owner.effect(() => () => { mounted-- })
  }
  await ctx.agentPresets.register({ id: 'fixture', plugins: [{ name: 'cordis:fixture' }] })
  assert.equal(mounted, 0)
  {
    await using lease = await ctx.agentPresets.acquireScope('fixture')
    assert.equal(mounted, 1)
    assert.equal(typeof lease.key, 'object')
  }
  assert.equal(mounted, 0)
  const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await load('@deepseek-ai/dsh-tools')
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const { defineTool } = await load('@deepseek-ai/dsh-tools')
  const { ToolCallId } = await load('@deepseek-ai/dsh-llm')
  const ptcExecutor = await load('@deepseek-ai/dsh-tool-executor-ptc')
  const calls = []
  for (const name of ['context_compress', 'ordinary_tool']) {
    ctx.tools.register(defineTool({
      name, description: 'Artifact smoke echo', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { calls.push(name); return name },
    }))
  }
  const { default: FileSystem } = await load('@deepseek-ai/dsh-fs-local')
  const { default: Subprocess } = await load('@deepseek-ai/dsh-subprocess-local')
  const { default: Sandbox } = await load('@deepseek-ai/dsh-sandbox-local')
  const { default: SandboxPolicy } = await load('@deepseek-ai/dsh-sandbox-policy')
  await ctx.plugin(FileSystem)
  await ctx.plugin(Subprocess)
  await ctx.plugin(Sandbox, {})
  await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
  const rawText = '"quotes\' C:\\temp ${literal} `tick`\n'
  for (const executionMode of ['per-call', 'persistent-in-memory']) {
    const fiber = await ctx.plugin(ptcRuntime.default, { executionMode })
    const runtime = ctx.get('ptcRuntime')
    const executor = await ctx.plugin(ptcExecutor, { ptcNativeTools: ['context_compress'] })
    calls.length = 0
    const direct = await ctx.tools.execute({
      calls: ['context_compress', 'ordinary_tool'].map(name => ({ type: 'tool-call', id: ToolCallId(name), name, arguments: '{}' })),
      signal: new AbortController().signal,
    })
    assert.equal(direct.results[0].result.isError, false, JSON.stringify(direct.results[0].result))
    assert.equal(direct.results[1].result.error.info.code, 'UNKNOWN_TOOL')
    assert.deepEqual(calls, ['context_compress'])
    const expression = '@``\n' + rawText + '``'
    const raw = await runtime.run(runtime.resolve({ program: executionMode === 'per-call' ? 'return ' + expression : expression, bindings: [] }))
    assert.equal(raw.value, rawText, executionMode)
    const failure = await runtime.run(runtime.resolve({ program: 'const command = "ssh h x "$HOME" y";', bindings: [] }))
    assert.equal(failure.error?.kind, 'exception', executionMode)
    assert.match(failure.error.message, /^SyntaxError at 1:27: /)
    assert.match(failure.error.message, /\n  1 \| const command = .*\n    \| +\^$/)
    const ordinary = '"a @``b`` c"'
    const preserved = await runtime.run(runtime.resolve({ program: executionMode === 'per-call' ? 'return ' + ordinary : ordinary, bindings: [] }))
    assert.equal(preserved.value, 'a @``b`` c', executionMode)

    await executor.dispose()
    await fiber.dispose()
  }
  console.log('Core artifacts resolve through official Host peers; Config, PTC native exception API, awaited setup, preset leases, PTC raw text with parse locations passed. No personal plugins or Host process used.')
} finally {
  if (ctx) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

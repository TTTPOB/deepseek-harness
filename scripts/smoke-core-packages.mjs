/** Verify core tarballs with the official CLI, without personal plugins or a Host process. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { checkSubagentManager } from './smoke-subagent.mjs'

import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'
import { stageArtifactOverrides } from './daily-driver-artifacts.mjs'
const expected = plan('core').packages
const names = expected.map(pkg => pkg.name)
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, names.length, 'Usage: node scripts/smoke-core-packages.mjs <agent.tgz> <registry.tgz> <subagent.tgz> <llm-pi-ai.tgz> <mcp-client.tgz> <tool-agent-team.tgz> <tools.tgz> <agent-loop.tgz> <ptc-runtime-node.tgz>')
const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], { encoding: 'utf8', timeout: 60_000 }).trim()
const root = await mkdtemp(join(tmpdir(), 'dsh-core-artifact-'))
const run = (args, cwd = root) => execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--store-dir', dirname(store), ...args], { cwd, stdio: 'inherit', timeout: 600_000 })
let ctx
try {
  await stageArtifactOverrides(root, expected, tarballs)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'core-artifact-smoke', private: true, type: 'module', packageManager, dependencies: { '@deepseek-ai/dsh': officialVersion, [names[5]]: 'file:./' + basename(tarballs[5]) } }))
  run(['install', '--ignore-scripts', '--config.enable-global-virtual-store=false'])
  const project = createRequire(join(root, 'package.json'))
  const host = await realpath(project.resolve('@deepseek-ai/dsh/package.json'))
  const hostRequire = createRequire(host)
  const resolver = name => name === names[5] ? project : hostRequire
  const load = async name => import(pathToFileURL(resolver(name).resolve(name)).href)
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
    const anchor = name === names[5] ? join(root, 'package.json') : host
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
  const [agent, presets, , pi, mcp, , , , ptcRuntime] = packages
  await checkSubagentManager(dirname(hostRequire.resolve(names[2] + '/package.json')))
  const { default: Schema } = await load('@deepseek-ai/schemastery')
  const [mcpConfig] = Schema.resolve({ transport: 'stdio', serverName: 'fixture', command: 'unused', maxBufferSize: 1048576 }, mcp.Config, {})
  assert.equal(mcpConfig.maxBufferSize, 1048576)
  assert.throws(() => Schema.resolve({ transport: 'stdio', serverName: 'fixture', command: 'unused', maxBufferSize: 0 }, mcp.Config, {}))
  const [piConfig] = Schema.resolve({}, pi.Config, {})
  assert.deepEqual(piConfig.providers.get(), {})
  const streamLimits = { maxConsecutiveWhitespaceChars: 5000, maxRepeatedPatternChars: 5000 }
  const [guardConfig] = Schema.resolve({ providers: { gateway: {
    api: 'openai-responses', baseURL: 'https://gateway.test/v1', models: [{ id: 'guard-model' }], compat: streamLimits,
  } } }, pi.Config, {})
  for (const [field, value] of Object.entries(streamLimits)) assert.equal(guardConfig.providers.get().gateway.compat[field], value)
  for (const field of Object.keys(streamLimits)) {
    for (const invalid of [-1, 0.5]) {
      assert.throws(() => Schema.resolve({ providers: { gateway: { compat: { [field]: invalid } } } }, pi.Config, {}))
    }
  }
  const adapterRequire = createRequire(hostRequire.resolve('@deepseek-ai/dsh-llm-pi-ai'))
  const responsesParser = adapterRequire.resolve('@earendil-works/pi-ai/api/openai-responses-shared', { conditions: new Set(['import', 'node', 'default']) })
  const piManifest = JSON.parse(await readFile(join(dirname(responsesParser), '../../package.json'), 'utf8'))
  assert.match(piManifest.version, /-fork\d+$/, 'isolated core must use the qualified Pi fork')
  const { processResponsesStream } = await import(pathToFileURL(responsesParser).href)
  for (const [field, delta, message] of [
    ['maxConsecutiveWhitespaceChars', ' '.repeat(12), /consecutive whitespace/],
    ['maxRepeatedPatternChars', 'abc'.repeat(4), /repeated a 3-character pattern/],
  ]) {
    const events = async function* () {
      yield { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'fixture', role: 'assistant', content: [] } }
      yield { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }
      yield { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta }
    }
    await assert.rejects(processResponsesStream(events(), { content: [] }, { push() {} },
      { compat: { maxConsecutiveWhitespaceChars: 0, maxRepeatedPatternChars: 0, [field]: delta.length } }), message)
  }
  console.log(JSON.stringify({ responsesParser, streamLimits }))
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
  const { createScope, bindScopeParent, scopeOf } = await load('@deepseek-ai/dsh-scope')
  const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await load('@deepseek-ai/dsh-tools')
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools, { ptcNativeTools: ['context_compress'] })
  assert.equal(ctx.tools.isNativeInPtc('context_compress'), true)
  assert.equal(ctx.tools.isNativeInPtc('ordinary_tool'), false)
  ctx.provide('agentTeams', { tryMembership: () => ({ role: 'lead', name: 'lead' }) })
  // Team tools resolve their execution provider only when a teammate is spawned.
  ctx.provide('subagents', { getProvider: () => undefined })
  const teamPresetKey = {}
  const ordinaryPresetKey = {}
  const teamKey = {}
  const ordinaryKey = {}
  let teamOwner
  await ctx.plugin({ inject: ['agents', 'agentTeams', 'tools', 'systemPrompt'], apply(owner) { teamOwner = owner } })
  const teamPreset = createScope(teamOwner, teamPresetKey)
  const teamScope = createScope(teamOwner, teamKey)
  const ordinaryScope = createScope(teamOwner, ordinaryKey)
  const teamBinding = bindScopeParent(teamKey, teamPresetKey)
  const ordinaryBinding = bindScopeParent(ordinaryKey, ordinaryPresetKey)
  const teamAgent = { id: 'team-scope-agent', ctx: teamScope.ctx }
  const ordinaryAgent = { id: 'ordinary-scope-agent', ctx: ordinaryScope.ctx }
  const originalList = ctx.agents.list
  ctx.agents.list = () => [teamAgent, ordinaryAgent]
  try {
    const teamFiber = await teamPreset.ctx.plugin(packages[5])
    const schemas = agent => ctx.tools.schemas(scopeOf(agent.ctx))
    assert(schemas(teamAgent).some(tool => tool.name === 'spawn_teammate'))
    assert(!schemas(ordinaryAgent).some(tool => tool.name === 'spawn_teammate'))
    assert(schemas(teamAgent).find(tool => tool.name === 'send_message').parameters.properties.target)
    teamBinding.rebind(ordinaryPresetKey)
    ordinaryBinding.rebind(teamPresetKey)
    ctx.emit('tools/change')
    assert(!schemas(teamAgent).some(tool => tool.name === 'spawn_teammate'))
    assert(schemas(ordinaryAgent).some(tool => tool.name === 'spawn_teammate'))
    await teamFiber.dispose()
    assert(!schemas(ordinaryAgent).some(tool => tool.name === 'spawn_teammate'))
  } finally {
    ctx.agents.list = originalList
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

    await fiber.dispose()
  }
  console.log('Core artifacts resolve through official Host peers; Config, PTC native exception API, awaited setup, preset leases, Team scope switching/disposal, and PTC raw text with parse locations passed. No personal plugins or Host process used.')
} finally {
  if (ctx) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
}

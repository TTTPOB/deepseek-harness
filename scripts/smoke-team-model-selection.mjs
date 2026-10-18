/** Verify the four team-model-selection tarballs through the official CLI and one test-only Loader tree. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { plan, officialVersion, packageManager } from './daily-driver-plan.mjs'
import { stageArtifactOverrides } from './daily-driver-artifacts.mjs'

const USAGE = 'Usage: node scripts/smoke-team-model-selection.mjs <subagent.tgz> <tool-subagent.tgz> <agent-team.tgz> <tool-agent-team.tgz>'
const expected = plan('team-model-selection').packages
const tarballs = process.argv.slice(2).map(path => resolve(path))
assert.equal(tarballs.length, expected.length, USAGE)
for (const path of tarballs) assert(existsSync(path), `${USAGE} (missing ${path})`)
for (const [index, pkg] of expected.entries()) {
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', tarballs[index], 'package/package.json'], { encoding: 'utf8' }))
  assert.equal(metadata.name, pkg.name)
  assert.equal(metadata.version, pkg.version)
}

const store = execFileSync('pnpm', ['--config.verify-deps-before-run=false', 'store', 'path'], { encoding: 'utf8', timeout: 60_000 }).trim()
const runtime = await mkdtemp(join(tmpdir(), 'dsh-team-model-selection-'))
const run = (args, cwd = runtime) => execFileSync('pnpm', ['--config.verify-deps-before-run=false', '--store-dir', dirname(store), ...args], { cwd, stdio: 'inherit', timeout: 600_000 })

/** Poll one predicate without holding a process or a port. */
async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(done => setTimeout(done, 20))
  }
}

/** Extract the model-facing text of one tool result. */
function text(result) {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Mount one test-only configuration; no Host or network server starts. */
async function openContext(runtime, boot, config) {
  const sessions = join(runtime, 'sessions')
  await mkdir(sessions, { recursive: true })
  const rows = [
    ['llm', '@deepseek-ai/dsh-llm'],
    ['session', '@deepseek-ai/dsh-session'],
    ['session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl', { root: sessions }],
    ['session-projection', '@deepseek-ai/dsh-session-projection'],
    ['system-prompt', '@deepseek-ai/dsh-system-prompt', { personaPrefix: '' }],
    ['tools', '@deepseek-ai/dsh-tools'],
    ['agent', '@deepseek-ai/dsh-agent'],
    ['fs', '@deepseek-ai/dsh-fs-local'],
    ['working-directory', '@deepseek-ai/dsh-working-directory'],
    ['agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [] }],
    ['subagent', '@deepseek-ai/dsh-subagent'],
    ['subagent-spawn', '@deepseek-ai/dsh-subagent-spawn-in-process', { providerName: 'spawn' }],
    ['agent-team', '@deepseek-ai/dsh-experimental-agent-team'],
    ['model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config.settings],
    ['team-tools', '@deepseek-ai/dsh-experimental-tool-agent-team', { modelSelectionSettings: true }],
  ]
  const lines = []
  for (const [id, name, value] of rows) {
    lines.push(`- id: ${id}`, `  name: '${name}'`)
    if (value !== undefined) {
      lines.push('  config:')
      for (const [key, entry] of Object.entries(value)) lines.push(`    ${key}: ${JSON.stringify(entry)}`)
    }
  }
  const configPath = join(runtime, 'cordis.yml')
  await writeFile(configPath, lines.join('\n') + '\n')
  return await boot(configPath)
}

let ctx
try {
  await stageArtifactOverrides(runtime, expected, tarballs)
  await writeFile(join(runtime, 'package.json'), JSON.stringify({
    name: 'team-model-selection-smoke', private: true, type: 'module', packageManager,
    dependencies: {
      '@deepseek-ai/dsh': officialVersion,
      '@deepseek-ai/dsh-app-boot': officialVersion,
      '@deepseek-ai/dsh-llm': officialVersion,
      '@deepseek-ai/dsh-session': officialVersion,
      '@deepseek-ai/dsh-scope': officialVersion,
      ...Object.fromEntries(expected.map((pkg, index) => [pkg.name, 'file:./' + basename(tarballs[index])])),
    },
  }))
  run(['install', '--ignore-scripts', '--config.enable-global-virtual-store=false'])
  const project = createRequire(join(runtime, 'package.json'))
  const host = await realpath(project.resolve('@deepseek-ai/dsh/package.json'))
  const load = async name => import(pathToFileURL(project.resolve(name)).href)

  // The official Host and the four overridden tarballs share one pnpm peer graph.
  for (const pkg of expected) {
    const manifest = await realpath(project.resolve(`${pkg.name}/package.json`))
    const metadata = JSON.parse(await readFile(manifest, 'utf8'))
    assert.equal(metadata.name, pkg.name)
    assert.equal(metadata.version, pkg.version)
    assert.match(manifest, /file\+/, `${pkg.name} must resolve from its staged tarball`)
  }
  const { boot } = await load('@deepseek-ai/dsh-app-boot')
  const bootTree = configPath => boot('team-model-selection smoke', configPath, [], undefined, pathToFileURL(host).href)

  const settings = { enabled: true, allowedModels: [{ provider: 'mock', model: 'mock' }, { provider: 'mock', model: 'other' }] }
  ctx = await openContext(runtime, bootTree, { settings })

  const shared = await load('@deepseek-ai/dsh-subagent')
  for (const name of ['requestedAgentOptions', 'assertAllowedModelSelection', 'preflightChildLlmRoute',
    'hasDelegationModelRequest', 'parentAgentOptionsForDelegation', 'selectSubagentModelSelectionPolicy',
    'recordSubagentModelSelection', 'subagentModelSelectionPolicy', 'listSubagentModels',
    'assertAllowedModelRoutes', 'modelRouteKey']) {
    assert.equal(typeof shared[name], 'function', `@deepseek-ai/dsh-subagent must export ${name}`)
  }
  assert.deepEqual(shared.subagentModelSelectionProjectionDefinition.key, 'subagentModelSelectionPolicy')
  assert.equal(shared.subagentModelSelectionProjectionDefinition.stateVersion, 1)
  assert.equal(typeof shared.AllowedModelRouteSchema, 'function')

  const { LlmAdapter, ReasoningEffortId, ToolCallId } = await load('@deepseek-ai/dsh-llm')
  const { SessionId } = await load('@deepseek-ai/dsh-session')
  const { scopeOf } = await load('@deepseek-ai/dsh-scope')
  class MockAdapter extends LlmAdapter {
    requests = []
    async resolveModel(provider, model) {
      if (model === 'missing') throw new Error('fixture unknown model')
      return { provider, id: model, name: model, reasoning: { defaultEffort: 'low', efforts: [
        { id: 'low', name: 'Low' }, { id: 'high', name: 'High' },
      ] } }
    }
    async listModels(_provider) {
      return [
        { provider: 'mock', id: 'mock', name: 'Mock' },
        { provider: 'mock', id: 'other', name: 'Other' },
        { provider: 'mock', id: 'outside', name: 'Outside' },
      ]
    }
    async *stream(options) {
      this.requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new MockAdapter()
  ctx.get('llm').registerAdapter(['mock'], adapter)
  assert.equal(ctx.get('subagentModelSelection').current().enabled, true)
  assert.deepEqual(ctx.get('subagentModelSelection').current().allowedModels, settings.allowedModels)

  const parentOptions = { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('low') }
  assert.equal(shared.hasDelegationModelRequest({}), false)
  assert.equal(shared.hasDelegationModelRequest({ model: 'other' }), true)
  assert.deepEqual(shared.requestedAgentOptions(parentOptions, undefined, {}, true), undefined)
  assert.deepEqual(shared.requestedAgentOptions(parentOptions, undefined,
    { provider: 'mock', model: 'other', reasoning_effort: 'high' }, true),
  { provider: 'mock', model: 'other', reasoningEffort: 'high' })
  assert.throws(() => shared.requestedAgentOptions(parentOptions, undefined, { provider: 'mock' }, true),
    /provider.*model.*supplied together/)
  const policy = { routes: settings.allowedModels }
  shared.assertAllowedModelSelection(policy, parentOptions, { provider: 'mock', model: 'other' },
    { provider: 'mock', model: 'other' })
  assert.throws(() => shared.assertAllowedModelSelection(policy, parentOptions, { provider: 'mock', model: 'outside' },
    { provider: 'mock', model: 'outside' }), /not allowed for this Session/)
  await shared.preflightChildLlmRoute(ctx.get('llm'), parentOptions,
    { provider: 'mock', model: 'other', reasoningEffort: ReasoningEffortId('high') }, new AbortController().signal)
  await assert.rejects(shared.preflightChildLlmRoute(ctx.get('llm'), parentOptions,
    { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('extreme') }, new AbortController().signal),
  /does not support reasoning effort/)

  const lead = await ctx.agentLoop.create(SessionId('team-model-selection-lead'), parentOptions)
  const scope = scopeOf(lead.ctx)
  const toolNames = ctx.tools.schemas(scope).map(tool => tool.name)
  const spawn = ctx.tools.schemas(scope).find(tool => tool.name === 'spawn_teammate')
  assert(spawn)
  for (const field of ['provider', 'model', 'reasoning_effort']) assert(spawn.parameters.properties[field], field)
  assert(toolNames.includes('list_agent_models'))

  const recorded = ctx.sessionProjections.stateOf(lead.session, 'subagentModelSelectionPolicy')
  assert.deepEqual(recorded, settings.allowedModels)
  const policyEvents = lead.session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy')
  assert.equal(policyEvents.length, 1, 'the tool installation records the route policy once')
  const frozen = shared.selectSubagentModelSelectionPolicy(
    { projections: ctx.sessionProjections, sessions: ctx.sessions }, lead.session,
    { current: () => ({ enabled: true, allowedModels: [{ provider: 'mock', model: 'outside' }] }) })
  assert.deepEqual(frozen.routes, settings.allowedModels, 'a durable policy wins over later settings')

  let child
  ctx.on('agent/created', ({ agent }) => { if (agent.id !== lead.id) child = agent })
  let callNumber = 0
  const execute = (name, args) => ctx.tools.execute({
    callId: ToolCallId(`team-model-selection-${name}-${++callNumber}`), name, arguments: args,
    signal: new AbortController().signal, agent: lead,
  })
  const spawnArgs = name => ({ name, description: 'fixture', prompt: 'work' })

  const models = await execute('list_agent_models', { provider: 'mock' })
  assert.match(text(models), /mock\/other/)
  assert.doesNotMatch(text(models), /mock\/outside/)
  const efforts = await execute('list_agent_models', { provider: 'mock', model: 'other' })
  assert.match(text(efforts), /Reasoning efforts:/)
  assert.match(text(efforts), /high/)

  const rejected = await execute('spawn_teammate', { ...spawnArgs('alpha'), provider: 'mock', model: 'mock', reasoning_effort: 'extreme' })
  assert.equal(rejected.isError, true)
  assert.match(text(rejected), /does not support reasoning effort/)
  assert(!ctx.agentTeams.listMembers(lead).some(member => member.name === 'alpha'), 'rejected preflight keeps the name free')
  assert.equal(lead.session.snapshotEvents().filter(event => event.type === 'team/member'
    && event.data.member.name === 'alpha').length, 0)

  const spawned = await execute('spawn_teammate', { ...spawnArgs('alpha'), provider: 'mock', model: 'other', reasoning_effort: 'high' })
  assert.equal(JSON.parse(text(spawned)).member.target, 'alpha')
  const row = ctx.agentTeams.listMembers(lead).find(member => member.name === 'alpha')
  assert(row)
  assert.equal(row.provider, 'spawn', 'the Team execution provider stays spawn')
  assert(child, 'the spawned child Agent was published')
  assert.equal(child.options.provider, 'mock')
  assert.equal(child.options.model, 'other')
  assert.equal(child.options.reasoningEffort, 'high')
  await waitFor(() => adapter.requests.some(request => request.provider === 'mock' && request.model === 'other'
    && request.reasoningEffort === 'high'), 'the selected child route request')

  const childPolicy = shared.selectSubagentModelSelectionPolicy(
    { projections: ctx.sessionProjections, sessions: ctx.sessions }, child.session,
    { current: () => ({ enabled: true, allowedModels: [{ provider: 'mock', model: 'outside' }] }) })
  assert.deepEqual(childPolicy.routes, settings.allowedModels, 'a child inherits the frozen parent policy')

  const denied = await execute('spawn_teammate', { ...spawnArgs('beta'), provider: 'mock', model: 'outside' })
  assert.equal(denied.isError, true)
  assert.match(text(denied), /not allowed for this Session/)
  assert(!ctx.agentTeams.listMembers(lead).some(member => member.name === 'beta'))

  console.log('Four team-model-selection artifacts resolve through official Host peers; public model-selection helpers, per-call route/effort, preflight before name reservation, and the frozen policy passed. No Host process used.')
} finally {
  try {
    if (ctx) await ctx.fiber.dispose()
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
}

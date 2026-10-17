import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as AgentPreset from '@deepseek-ai/dsh-agent-preset'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReasoningEffortId, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'
import type { Config as TeamToolConfig } from '../src/index.ts'

const SIGNAL = new AbortController().signal
const ALLOWED_ROUTES = [
  { provider: 'mock', model: 'mock' },
  { provider: 'mock', model: 'other-model' },
  { provider: 'missing-provider', model: 'mock' },
]
const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Mock adapter that also advertises a catalog containing an unauthorized model. */
class CatalogAdapter extends MockAdapter {
  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([
      { provider: 'mock', id: 'mock', name: 'Mock' },
      { provider: 'mock', id: 'other-model', name: 'Other' },
      { provider: 'mock', id: 'forbidden-model', name: 'Forbidden' },
    ])
  }
}

afterEach(async () => {
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface SetupOptions {
  /** Mount the Host settings service and the settings-controlled tool instance. */
  readonly enabled?: boolean
  readonly config?: TeamToolConfig
  readonly leadOptions?: AgentOptions
}

/** Mount the real Team stack with or without the Host model-selection setting. */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0], options: SetupOptions = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  const enabled = options.enabled === true
  if (enabled) {
    await ctx.plugin(SubagentModelSelectionConfig, { enabled: true, allowedModels: ALLOWED_ROUTES })
  }
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-model-selection-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  const fiber = await ctx.plugin(toolTeam, {
    ...options.config ?? {},
    ...enabled ? { modelSelectionSettings: true } : {},
  })
  const adapter = new CatalogAdapter(script, REASONING)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(
    SessionId('team-model-selection-lead'),
    options.leadOptions ?? { provider: 'mock', model: 'mock' },
  )
  return { ctx, lead, fiber, adapter }
}

function execute(ctx: Context, agent: Agent, name: string, args: unknown) {
  return ctx.tools.execute({
    callId: ToolCallId(`team-model-call-${++callNumber}`),
    name,
    arguments: args,
    signal: SIGNAL,
    agent,
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function schemaProperties(ctx: Context, agent: Agent, name: string): Record<string, unknown> {
  const schema = ctx.tools.schemas(agent).find(candidate => candidate.name === name)
  return (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

async function runTurn(agent: Agent, message: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Read one persisted Session's full event list. */
async function storedEvents(ctx: Context, id: SessionId) {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

describe('dsh-tool-team model selection', () => {
  it('rejects invalid or unauthorized routes before reserving a teammate name', async () => {
    const { ctx, lead } = await setup(['hang'], { enabled: true })
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ provider: 'mock', model: 'forbidden-model' }, 'is not allowed for this Session'],
      [{ provider: 'mock' }, '`provider` and `model` must be supplied together'],
      [{ model: 'mock' }, '`provider` and `model` must be supplied together'],
      [{ provider: 'mock', model: '' }, '`model` must be non-empty'],
      [{ provider: 'mock', model: 'mock', reasoning_effort: '' }, '`reasoning_effort` must be non-empty'],
      [{ provider: 'mock', model: 'mock', reasoning_effort: 'max' }, 'does not support reasoning effort "max"'],
      [{ provider: 'missing-provider', model: 'mock' }, 'no adapter registered for provider "missing-provider"'],
    ]
    for (const [selection, expected] of cases) {
      const result = await execute(ctx, lead, 'spawn_teammate', {
        name: 'rejected-route', description: 'rejected route', prompt: 'work', ...selection,
      })
      expect(result.isError, expected).toBe(true)
      expect(text(result)).toContain(expected)
    }
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/member')).toEqual([])
  })

  it('rejects an execution provider that cannot apply Agent options before reserving a name', async () => {
    const { ctx, lead } = await setup([], { enabled: true, config: { freshProvider: 'no-options' } })
    ctx.subagents.registerProvider({
      name: 'no-options',
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
      start: () => Promise.reject(new Error('a capability-less provider must not start')),
    })
    const rejected = await execute(ctx, lead, 'spawn_teammate', {
      name: 'no-options-worker', description: 'no options', prompt: 'work',
      provider: 'mock', model: 'mock',
    })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain('subagent provider "no-options" does not support child agentOptions')
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)

    const missing = await setup([], { enabled: true, config: { freshProvider: 'missing-provider' } })
    const unknown = await execute(missing.ctx, missing.lead, 'spawn_teammate', {
      name: 'unknown-provider', description: 'unknown provider', prompt: 'work',
    })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('requires the "missing-provider" subagent provider')
    expect(missing.ctx.agentTeams.listMembers(missing.lead)).toHaveLength(1)
  })

  it('lists only Session-authorized routes and efforts through list_agent_models', async () => {
    const { ctx, lead } = await setup(['hang', textResponse('settled')], { enabled: true })
    expect(text(await execute(ctx, lead, 'list_agent_models', {}))).toContain('mock — mock')
    const models = text(await execute(ctx, lead, 'list_agent_models', { provider: 'mock' }))
    expect(models).toContain('mock/mock — Mock')
    expect(models).toContain('mock/other-model — Other')
    expect(models).not.toContain('forbidden-model')
    const efforts = text(await execute(ctx, lead, 'list_agent_models', { provider: 'mock', model: 'mock' }))
    expect(efforts).toContain('Reasoning efforts:')
    expect(efforts).toContain('high (default)')
    const modelOnly = await execute(ctx, lead, 'list_agent_models', { model: 'mock' })
    expect(modelOnly.isError).toBe(true)
    expect(text(modelOnly)).toContain('`model` requires `provider`')
    const deniedProvider = await execute(ctx, lead, 'list_agent_models', { provider: 'other-provider' })
    expect(deniedProvider.isError).toBe(true)
    expect(text(deniedProvider)).toContain('is not allowed for this Session')
    const deniedModel = await execute(ctx, lead, 'list_agent_models', { provider: 'mock', model: 'forbidden-model' })
    expect(deniedModel.isError).toBe(true)
    expect(text(deniedModel)).toContain('not allowed for this Session')
    const unregistered = await execute(ctx, lead, 'list_agent_models', { provider: 'missing-provider' })
    expect(unregistered.isError).toBe(true)
    expect(text(unregistered)).toContain('LLM provider "missing-provider" is not registered')

    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'discovery-worker', description: 'discovery worker', prompt: 'wait',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = ctx.agentTeams.listMembers(lead)[1]!.id
    const child = await waitRunning(ctx, childId)
    expect(text(await execute(ctx, child, 'list_agent_models', { provider: 'mock' })))
      .toContain('mock/other-model — Other')
    ctx.agentTeams.interrupt(lead, 'discovery-worker')
    await waitNoAgent(ctx, childId)
    await lead.whenIdle()
  })

  it('restores a teammate route after real unload and never reports the Lead model for offline members', async () => {
    const { ctx, lead, adapter } = await setup(
      [textResponse('lead answer'), textResponse('finish once'), 'hang', textResponse('settled')],
      { enabled: true },
    )
    await runTurn(lead, 'Parent task')
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'cold-worker', description: 'cold worker', prompt: 'finish once',
      provider: 'mock', model: 'other-model',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = ctx.agentTeams.listMembers(lead)[1]!.id
    await waitNoAgent(ctx, childId)
    // An offline member has no current route; the Lead route is not substituted.
    expect(lead.session.requestHeader()?.config.model).toBe('mock')
    const offline = ctx.agentTeams.listMembers(lead)
    expect(offline[0]).toMatchObject({ name: 'lead', model: 'mock' })
    expect(offline[1]).toMatchObject({ name: 'cold-worker' })
    expect(offline[1]).not.toHaveProperty('model')

    const receipt = await ctx.agentTeams.sendMessage(lead, {
      target: 'cold-worker',
      content: [{ type: 'text', text: 'resume with the frozen route' }],
      signal: SIGNAL,
    })
    expect(receipt.messageId).toEqual(expect.any(String))
    const resumed = await waitRunning(ctx, childId)
    expect(resumed.options.model).toBe('other-model')
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ model: 'other-model' })
    await vi.waitFor(() => {
      expect(adapter.requests.findLast(request => request.sessionId === childId)?.model).toBe('other-model')
    })
    const events = await storedEvents(ctx, childId)
    expect(events.find(event => event.type === 'subagent/model-selection-policy'))
      .toMatchObject({ data: { allowedModels: ALLOWED_ROUTES } })
    ctx.agentTeams.interrupt(lead, 'cold-worker')
    await waitNoAgent(ctx, childId)
  })

  it('loads settings-controlled Team tools through a real Loader composition', async () => {
    const { ctx, fiber } = await setup([], { enabled: true })
    await fiber.dispose()
    await ctx.plugin(Loader)
    ctx.loader.builtins.registry = AgentPresets
    ctx.loader.builtins.preset = AgentPreset
    ctx.loader.builtins.teamTools = toolTeam
    await ctx.loader.root.update([
      { id: 'registry', name: 'cordis:registry', config: { default: 'team' } },
      {
        id: 'team',
        name: 'cordis:preset',
        config: { id: 'team', plugins: [{ name: 'cordis:teamTools', config: { modelSelectionSettings: true } }] },
      },
    ])
    const handle = await ctx.agents.create({
      sessionId: SessionId('loader-model-selection'),
      setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'team') },
    })
    expect(Object.keys(schemaProperties(ctx, handle.agent, 'spawn_teammate'))).toContain('provider')
    expect(ctx.tools.get('list_agent_models', handle.agent)).toBeDefined()
    expect(ctx.agentTeams.listMembers(handle.agent).map(member => member.name)).toEqual(['lead'])
    await handle.dispose()
  })

  it('hides route fields by default and rejects forced selection without reserving a name', async () => {
    const { ctx, lead } = await setup([textResponse('done')])
    expect(Object.keys(schemaProperties(ctx, lead, 'spawn_teammate')).sort())
      .toEqual(['context', 'description', 'name', 'prompt'])
    expect(ctx.tools.get('list_agent_models', lead)).toBeUndefined()

    const forced = await execute(ctx, lead, 'spawn_teammate', {
      name: 'forced-route', description: 'forced route', prompt: 'work',
      provider: 'mock', model: 'mock',
    })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('child model selection is disabled for this tool instance')
    expect(ctx.agentTeams.listMembers(lead)).toHaveLength(1)
    expect(lead.session.snapshotEvents().filter(event => event.type === 'team/member')).toEqual([])
  })

  it('fails load when the Host settings service is missing', async () => {
    const { ctx, fiber } = await setup([])
    await fiber.dispose()
    await expect(ctx.plugin(toolTeam, { modelSelectionSettings: true }))
      .rejects.toThrow('requires @deepseek-ai/dsh-tool-subagent/model-selection-settings')
  })

  it('exposes route fields, discovery, and a frozen Session policy when enabled', async () => {
    const { ctx, lead } = await setup([textResponse('done')], { enabled: true })
    expect(Object.keys(schemaProperties(ctx, lead, 'spawn_teammate')).sort())
      .toEqual(['context', 'description', 'model', 'name', 'prompt', 'provider', 'reasoning_effort'])
    const spawnSchema = ctx.tools.schemas(lead).find(candidate => candidate.name === 'spawn_teammate')
    expect(spawnSchema?.description).toContain('list_agent_models')
    expect(spawnSchema?.description).toContain('not the Team execution provider reported by list_agents')
    expect(spawnSchema?.description).toContain('can prevent provider-side reuse of the inherited conversation prefix')
    expect(spawnSchema?.description).not.toContain('mock')
    expect(ctx.tools.get('list_agent_models', lead)).toBeDefined()

    // The policy is recorded before the first request and inherited by children.
    const events = lead.session.snapshotEvents()
    const policyIndex = events.findIndex(event => event.type === 'subagent/model-selection-policy')
    const requestIndex = events.findIndex(event => event.type === 'request/header')
    expect(policyIndex).toBeGreaterThanOrEqual(0)
    expect(requestIndex === -1 || policyIndex < requestIndex).toBe(true)
    expect(events[policyIndex]?.type === 'subagent/model-selection-policy'
      ? events[policyIndex].data.allowedModels
      : []).toEqual(ALLOWED_ROUTES)

    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'policy-child', description: 'policy child', prompt: 'finish',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = ctx.agentTeams.listMembers(lead)[1]!.id
    const childEvents = await storedEvents(ctx, childId)
    expect(childEvents.find(event => event.type === 'subagent/model-selection-policy'))
      .toMatchObject({ data: { allowedModels: ALLOWED_ROUTES } })
    await waitNoAgent(ctx, childId)
  })

  it('selects an authorized route for a fresh teammate and keeps the execution provider separate', async () => {
    const { ctx, lead, adapter } = await setup(
      [textResponse('lead answer'), 'hang', textResponse('settled')],
      { enabled: true },
    )
    await runTurn(lead, 'Parent task')
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fresh-route', description: 'fresh route', prompt: 'wait',
      provider: 'mock', model: 'other-model',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const member = JSON.parse(text(spawned)) as { member: { target: string } }
    const childId = ctx.agentTeams.listMembers(lead)[1]!.id
    const child = await waitRunning(ctx, childId)
    expect(child.options).toMatchObject({ provider: 'mock', model: 'other-model' })
    expect(adapter.requests.find(request => request.sessionId === childId)?.model).toBe('other-model')
    expect(member.member.target).toBe('fresh-route')
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({
      name: 'fresh-route', provider: 'spawn', context: 'fresh', model: 'other-model',
    })
    ctx.agentTeams.interrupt(lead, 'fresh-route')
    await waitNoAgent(ctx, childId)
    await lead.whenIdle()
  })

  it('selects an authorized route for a fork teammate', async () => {
    const { ctx, lead, adapter } = await setup(
      [textResponse('lead answer'), 'hang', textResponse('settled')],
      { enabled: true },
    )
    await runTurn(lead, 'Parent task')
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'fork-route', description: 'fork route', prompt: 'review', context: 'fork',
      provider: 'mock', model: 'mock',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = ctx.agentTeams.listMembers(lead)[1]!.id
    await waitRunning(ctx, childId)
    expect(adapter.requests.find(request => request.sessionId === childId)?.model).toBe('mock')
    expect(ctx.agentTeams.listMembers(lead)[1]).toMatchObject({ provider: 'fork', context: 'fork', model: 'mock' })
    ctx.agentTeams.interrupt(lead, 'fork-route')
    await waitNoAgent(ctx, childId)
    await lead.whenIdle()
  })

  it('inherits the Lead current route when the call selects nothing', async () => {
    const { ctx, lead } = await setup([textResponse('lead answer'), 'hang', textResponse('settled')], {
      enabled: true,
      leadOptions: { provider: 'mock', model: 'lead-model' },
    })
    await runTurn(lead, 'Parent task')
    expect(lead.session.requestHeader()?.config.model).toBe('lead-model')
    const spawned = await execute(ctx, lead, 'spawn_teammate', {
      name: 'inherited-route', description: 'inherited route', prompt: 'wait',
    })
    expect(spawned.isError, text(spawned)).toBe(false)
    const childId = ctx.agentTeams.listMembers(lead)[1]!.id
    const child = await waitRunning(ctx, childId)
    expect(child.options).toMatchObject({ provider: 'mock', model: 'lead-model' })
    ctx.agentTeams.interrupt(lead, 'inherited-route')
    await waitNoAgent(ctx, childId)
    await lead.whenIdle()
  })

  it('clears the inherited effort when a selected route changes and keeps it otherwise', async () => {
    const { ctx, lead } = await setup(
      [textResponse('lead answer'), 'hang', 'hang', textResponse('settled'), textResponse('settled')],
      { enabled: true },
    )
    await runTurn(lead, 'Parent task')
    expect(lead.session.requestHeader()?.config.reasoningEffort).toBe('high')
    const changed = await execute(ctx, lead, 'spawn_teammate', {
      name: 'changed-route', description: 'changed route', prompt: 'wait',
      provider: 'mock', model: 'other-model',
    })
    expect(changed.isError, text(changed)).toBe(false)
    const changedId = ctx.agentTeams.listMembers(lead)[1]!.id
    const changedChild = await waitRunning(ctx, changedId)
    expect(changedChild.options).toMatchObject({ provider: 'mock', model: 'other-model' })
    expect(changedChild.options).not.toHaveProperty('reasoningEffort')

    const kept = await execute(ctx, lead, 'spawn_teammate', {
      name: 'kept-route', description: 'kept route', prompt: 'wait',
      provider: 'mock', model: 'mock',
    })
    expect(kept.isError, text(kept)).toBe(false)
    const keptId = ctx.agentTeams.listMembers(lead)[2]!.id
    const keptChild = await waitRunning(ctx, keptId)
    expect(keptChild.options).toMatchObject({
      provider: 'mock', model: 'mock', reasoningEffort: 'high',
    })
    ctx.agentTeams.interrupt(lead, 'changed-route')
    ctx.agentTeams.interrupt(lead, 'kept-route')
    await waitNoAgent(ctx, changedId)
    await waitNoAgent(ctx, keptId)
    await lead.whenIdle()
  })
})

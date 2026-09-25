import { afterEach, describe, expect, it } from 'vitest'
import { createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { entryListProblem, livePresetMounts } from '../src/index.ts'
import { currentKey, harness, declare, contribution, agentOn, liveRegistries, plugin } from './harness.ts'
import { omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import AgentPresets from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() { const ctx = await harness(); contexts.push(ctx); return ctx }

describe('workspace placement', () => {
  it('shares a workspace generation, inherits the exact parent and releases the lease last', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    const workspace = createScope(ctx, {})
    const other = createScope(ctx, {})
    const first = createScope(ctx, {})
    const second = createScope(ctx, {})
    const child = createScope(ctx, {})
    const foreign = createScope(ctx, {})
    const order: string[] = []
    const place = (agent: typeof first, root: typeof workspace) => ctx.agentPresets.place(agent.ctx, {
      key: scopeOf(root.ctx)!, ctx: root.ctx, release: async () => { order.push('lease') },
    })
    place(first, workspace)
    place(second, workspace)
    place(child, workspace)
    place(foreign, other)
    expect(scopeParentOf(scopeOf(first.ctx)!)).toBe(scopeOf(workspace.ctx))
    await ctx.agentPresets.mount(first.ctx)
    await ctx.agentPresets.mount(second.ctx)
    expect(scopeParentOf(scopeOf(first.ctx)!)).toBe(scopeParentOf(scopeOf(second.ctx)!))
    expect(ctx.agentPresets.composeFrom(child.ctx, first.ctx)).toBe('standard')
    expect(() => ctx.agentPresets.composeFrom(foreign.ctx, first.ctx)).toThrow(/across workspaces/)
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
    await first.dispose()
    await second.dispose()
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
    await child.dispose()
    expect(livePresetMounts(ctx.fiber)).toEqual([])
    expect(order).toEqual(['lease', 'lease', 'lease'])
    await foreign.dispose()
    await workspace.dispose()
    await other.dispose()
  })

  it('keeps cold inspection off workspace placement', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    expect(livePresetMounts(ctx.fiber)).toEqual([])
    expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' })
    expect((await ctx.agentPresets.compositionInventory())[0]?.rows).toHaveLength(1)
    await using _cold = await ctx.agentPresets.acquireScope()
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
  })
})

describe('declarative preset revisions', () => {
  it('lazily scopes tool and prompt registrations while Agents use them', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await declare(ctx, contribution('minimal'))
    expect(livePresetMounts(ctx.fiber)).toEqual([])
    const first = await agentOn(ctx, 'first')
    const second = await agentOn(ctx, 'second', 'minimal')
    const third = await agentOn(ctx, 'third')
    expect(ctx.tools.schemas(first).map(row => row.name)).toEqual(['standard'])
    expect(ctx.tools.schemas(second).map(row => row.name)).toEqual(['minimal'])
    expect(ctx.tools.schemas(third).map(row => row.name)).toEqual(['standard'])
    expect(ctx.tools.schemas()).toEqual([])
    const prompt = await ctx.systemPrompt.assemble(assembleContextFor(first))
    expect(prompt.sections.map(row => row.name)).toContain('preset:standard')
    expect(prompt.sections.map(row => row.name)).not.toContain('preset:minimal')
    expect(livePresetMounts(ctx.fiber)).toHaveLength(2)
  })

  it('retains a replaced revision for existing scopes and their children, then releases it', async () => {
    const ctx = await setup()
    const old = await declare(ctx, contribution('standard'))
    const agent = createScope(ctx, {})
    await ctx.agentPresets.mount(agent.ctx)
    const oldKey = await currentKey(ctx)
    await old.dispose()
    await declare(ctx, { ...contribution('replacement'), id: 'standard' })
    expect(await currentKey(ctx)).not.toBe(oldKey)
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
    const child = createScope(ctx, {})
    expect(ctx.agentPresets.composeFrom(child.ctx, agent.ctx)).toBe('standard')
    await agent.dispose()
    expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
    await child.dispose()
    expect(livePresetMounts(ctx.fiber)).toEqual([])
    const fresh = await agentOn(ctx, 'fresh')
    expect(ctx.tools.schemas(fresh).map(row => row.name)).toEqual(['replacement'])
  })

  it('removes definitions without revoking live bindings', async () => {
    const ctx = await setup()
    const definition = await declare(ctx, contribution('standard'))
    const agent = createScope(ctx, {})
    await ctx.agentPresets.mount(agent.ctx)
    await definition.dispose()
    expect(await ctx.agentPresets.list()).toEqual([])
    await expect(ctx.agentPresets.resolve()).rejects.toThrow('Unknown agent preset')
    expect(ctx.agentPresets.composedPreset(agent.ctx)).toBe('standard')
    await agent.dispose()
    expect(livePresetMounts(ctx.fiber)).toEqual([])
  })

  it('reports a failed definition while allowing healthy definitions and the host to start', async () => {
    const ctx = await setup()
    await declare(ctx, { id: 'broken', plugins: [{ name: 'missing-preset-plugin-for-test' }] })
    await declare(ctx, contribution('standard'))
    expect(await ctx.agentPresets.resolve('broken')).toEqual({ id: 'broken' })
    const scope = createScope(ctx, {})
    await expect(ctx.agentPresets.mount(scope.ctx, 'broken')).rejects.toThrow()
    expect(await ctx.agentPresets.mount(scope.ctx)).toEqual({ id: 'standard' })
    const roster = await ctx.agentPresets.remoteExportList()
    expect(roster.presets.find(row => row.id === 'standard')?.isDefault).toBe(true)
  })

  it('rejects duplicate IDs without disposing the first definition', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await expect(declare(ctx, contribution('standard'))).rejects.toThrow('Duplicate agent preset')
    expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' })
  })

  it('rebinds a blank scope and preserves a child inheriting its former revision', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await declare(ctx, contribution('minimal'))
    const scope = createScope(ctx, {})
    await ctx.agentPresets.mount(scope.ctx)
    await ctx.agentPresets.mount(scope.ctx)
    const child = createScope(ctx, {})
    ctx.agentPresets.composeFrom(child.ctx, scope.ctx)
    await ctx.agentPresets.recompose(scope.ctx, 'minimal')
    expect(ctx.agentPresets.composedPreset(scope.ctx)).toBe('minimal')
    expect(ctx.agentPresets.composedPreset(child.ctx)).toBe('standard')
    expect(ctx.agentPresets.composeFrom(createScope(ctx, {}).ctx, ctx)).toBeUndefined()
  })

  it('logs selection and rejects preset changes after the first turn', async () => {
    const ctx = await setup()
    await declare(ctx, contribution('standard'))
    await declare(ctx, contribution('minimal'))
    const agent = await agentOn(ctx, 'selection')
    expect(await ctx.agentPresets.select(agent, 'minimal')).toBe('minimal')
    expect(ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).toBe('minimal')
    agent.session.append('turn/start', { turn: 1 })
    await expect(ctx.agentPresets.select(agent, 'standard')).rejects.toThrow('already started')
  })

  it('inventories active and disabled child entries and declared display metadata', async () => {
    const ctx = await setup()
    await declare(ctx, { ...contribution('standard'), name: 'Standard', description: 'General', order: 2 })
    await declare(ctx, { id: 'empty', order: 1, plugins: [{ name: 'missing', disabled: true }] })
    expect((await ctx.agentPresets.list()).map(row => row.id)).toEqual(['empty', 'standard'])
    expect(await ctx.agentPresets.compositionInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'standard', name: 'Standard', isDefault: true, rows: expect.any(Array) as unknown[] }),
      expect.objectContaining({ id: 'empty', rows: [expect.objectContaining({ moduleName: 'missing', enabled: false })] }),
    ]))
  })

  it('renders a declaration as entry-list YAML for reading, conditions included', async () => {
    const ctx = await setup()
    await declare(ctx, {
      ...contribution('standard'), name: 'Standard', description: 'General',
      plugins: [
        { id: 'contribute', name: plugin('contribute'), config: { tool: 'standard' } },
        { id: 'windows-only', name: 'missing', disabled: { __jsExpr: "process.platform !== 'win32'" } },
      ],
    })
    const document = await ctx.agentPresets.readDocument('standard')
    expect(document).toMatchObject({ agentPreset: 'standard', name: 'Standard', description: 'General' })
    expect(document.content.startsWith('- id: contribute\n  name: ')).toBe(true)
    expect(document.content).toContain("\n  config:\n    tool: standard\n- id: windows-only\n  name: missing\n  disabled: !!js process.platform !== 'win32'\n")
    expect(document.content).not.toContain('__jsExpr')
    await declare(ctx, contribution('minimal'))
    expect(await ctx.agentPresets.readDocument('minimal')).toEqual({
      agentPreset: 'minimal', content: expect.any(String) as string,
    })
    await expect(ctx.agentPresets.readDocument('absent')).rejects.toThrow('Unknown agent preset: absent')
  })
})

it('retains a retired revision for an in-flight cold read', async () => {
  const ctx = await setup()
  const definition = await declare(ctx, contribution('standard'))
  const lease = await ctx.agentPresets.acquireScope()
  await definition.dispose()
  expect(livePresetMounts(ctx.fiber)).toHaveLength(1)
  await lease[Symbol.asyncDispose]()
  await lease[Symbol.asyncDispose]()
  expect(livePresetMounts(ctx.fiber)).toEqual([])
})

it.each([['throws', 'refused'], ['global-service', 'require isolate realms']])('contains a %s plugin activation failure', async (name, reason) => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  await declare(ctx, { id: 'invalid', plugins: [{ name: plugin(name), config: { message: 'refused', service: 'fixtureService' } }] })
  expect(await ctx.agentPresets.resolve('invalid')).toEqual({ id: 'invalid' })
  await expect(ctx.agentPresets.mount(createScope(ctx, {}).ctx, 'invalid')).rejects.toThrow(reason)
  expect(ctx.get('fixtureService')).toBeUndefined()
  expect(livePresetMounts(ctx.fiber)).toEqual([])
})

it('keeps a row waiting for an absent service mounted, reports it, and refuses bindings', async () => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  await declare(ctx, { id: 'invalid', plugins: [{ name: plugin('needs-missing') }] })
  expect(await ctx.agentPresets.resolve('invalid')).toEqual({ id: 'invalid' })
  expect(livePresetMounts(ctx.fiber)).toEqual([])
  await expect(ctx.agentPresets.mount(createScope(ctx, {}).ctx, 'invalid')).rejects.toThrow('waiting for serviceThatDoesNotExist')
  expect((await ctx.agentPresets.list())[0]).toEqual({ id: 'invalid' })
})



it('allows an isolated service and resolves it through the Agent composition', async () => {
  const ctx = await setup()
  const { plugin } = await import('./harness.ts')
  await declare(ctx, { id: 'standard', plugins: [{ name: 'cordis:group', group: true,
    isolate: { fixtureService: true }, config: [{ name: plugin('global-service'), config: { service: 'fixtureService', label: 'scoped' } }] }] })
  const scope = createScope(ctx, {})
  await ctx.agentPresets.mount(scope.ctx)
  expect(ctx.agentPresets.serviceFor({ ctx: scope.ctx }, 'fixtureService' as string & keyof Context)).toEqual({ label: 'scoped' })
  expect(ctx.agentPresets.serviceFor({ ctx }, 'fixtureService' as string & keyof Context)).toBeUndefined()
  expect(ctx.agentPresets.serviceFor({ ctx: scope.ctx }, 'loader')).toBeUndefined()
})

it('resolves the saved default over the deployment default, and drops a removed override', async () => {
  const ctx = await harness({ live: true })
  contexts.push(ctx)
  const live = liveRegistries.get(ctx)!
  await live.update({ selectedDefault: 'minimal' })
  expect(ctx.agentPresets.defaultId).toBe('minimal')
  await live.replace({ default: 'standard' })
  expect(ctx.agentPresets.defaultId).toBe('standard')
})

it('ignores a retired modeSelectionEnabled field in the user patch', async () => {
  const ctx = await harness({ live: true })
  contexts.push(ctx)
  const live = liveRegistries.get(ctx)!
  await declare(ctx, contribution('minimal'))
  // A patch written before Developer tools became the only gate still carries
  // this key; the Loader's declared fields simply do not include it.
  await live.update({ selectedDefault: 'minimal', modeSelectionEnabled: false })
  expect(ctx.agentPresets.defaultId).toBe('minimal')
  expect((await ctx.agentPresets.remoteExportList()).presets.find(row => row.id === 'minimal')?.isDefault).toBe(true)
  // Neither read nor rewritten: the raw entry keeps the key it was loaded with.
  expect(live.entry.options.config).toMatchObject({ selectedDefault: 'minimal', modeSelectionEnabled: false })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(async (ctx) => {
  await ctx.plugin(Loader)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx.plugin(AgentPresets, { default: 'standard' })
}))

it('refuses an unscoped binding and a second child join without leaking references', async () => {
  const ctx = await setup()
  const definition = await declare(ctx, contribution('standard'))
  await expect(ctx.agentPresets.mount(ctx)).rejects.toThrow('scoped context')
  await expect(ctx.agentPresets.register({ id: ' ', plugins: [] })).rejects.toThrow('empty')
  const parent = createScope(ctx, {})
  await ctx.agentPresets.mount(parent.ctx)
  expect(() => ctx.agentPresets.composeFrom(ctx, parent.ctx)).toThrow('requires a scope')
  const child = createScope(ctx, {})
  ctx.agentPresets.composeFrom(child.ctx, parent.ctx)
  expect(() => ctx.agentPresets.composeFrom(child.ctx, parent.ctx)).toThrow('already joined')
  await definition.dispose()
  await child.dispose()
  await parent.dispose()
  expect(livePresetMounts(ctx.fiber)).toHaveLength(0)
  await expect(ctx.agentPresets.acquireScope()).rejects.toThrow('Unknown')
})

it('serializes competing blank-session selections and recovers after a failed selection', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'competing')
  const results = await Promise.allSettled([
    ctx.agentPresets.select(agent, 'absent'), ctx.agentPresets.select(agent, 'minimal'), ctx.agentPresets.select(agent, 'standard'),
  ])
  expect(results.map(row => row.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
  expect(ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).toBe('standard')
})



it('does not log a selection when lazy mounting fails', async () => {
  const ctx = await setup()
  await declare(ctx, contribution('standard'))
  await declare(ctx, contribution('minimal'))
  const agent = await agentOn(ctx, 'observer')
  ctx.on('tools/change', () => { throw new Error('observer refused') })
  await expect(ctx.agentPresets.select(agent, 'minimal')).rejects.toThrow('observer refused')
  expect(ctx.sessionProjections.stateOf(agent.session, 'agentPreset')).toBeNull()
})

it('inventories failed conditional entries without executing their expressions again', async () => {
  const ctx = await setup()
  await declare(ctx, { id: 'broken', name: 'Broken', plugins: [
    { name: 'missing', disabled: { __jsExpr: 'false' } },
  ] })
  const inventory = await ctx.agentPresets.compositionInventory()
  expect(inventory[0]).toMatchObject({ id: 'broken',
    rows: [{ moduleName: 'missing', enabled: 'conditional', condition: 'false' }] })
})

it('does not bind a definition removed while acquisition yields, and disposal is idempotent', async () => {
  const ctx = await setup()
  const dispose = await ctx.agentPresets.register(contribution('standard'))
  const acquiring = ctx.agentPresets.acquireScope()
  const rejection = expect(acquiring).rejects.toThrow('Unknown agent preset')
  await dispose()
  await rejection
  await declare(ctx, contribution('standard'))
  await dispose()
  expect(await ctx.agentPresets.resolve()).toEqual({ id: 'standard' })
})

it('refuses to inherit a revision owned by a different registry', async () => {
  const ctx = await setup()
  const other = await setup()
  await declare(other, contribution('standard'))
  const parent = createScope(other, {})
  await other.agentPresets.mount(parent.ctx)
  expect(() => ctx.agentPresets.composeFrom(createScope(ctx, {}).ctx, parent.ctx)).toThrow('revision is unavailable')
})

it('validates malformed child YAML at the declaring plugin and retains diagnostics', async () => {
  const ctx = await setup()
  const { default: Preset } = await import('@deepseek-ai/dsh-agent-preset')
  ctx.loader.builtins.preset = Preset
  await ctx.loader.root.update([{ id: 'invalid', name: 'cordis:preset', config: { id: 'invalid', plugins: [1] } }])
  expect((await ctx.agentPresets.resolve('invalid')).broken).toContain('not a plugin row')
  expect((await ctx.agentPresets.compositionInventory())[0]!.rows).toEqual([])
})

it.each([
  ['nope', 'the composition must be a top-level list of plugin rows'],
  [[[]], 'row 1 is not a plugin row (expected a map with a "name")'],
  [[{ name: '' }], 'row 1 names no plugin (a "name" string is required)'],
  [[{ name: 'group', group: true, config: 'x' }], 'group row 1 must hold a list of plugin rows'],
  [[{ name: 'group', group: true, config: [{}] }], 'row 1 row 1 names no plugin (a "name" string is required)'],
  [[{ name: 'group', group: true, config: [{ name: 'child' }] }], undefined],
])('names the first invalid row of %j', (rows, problem) => {
  expect(entryListProblem(rows)).toBe(problem)
})

it('reports every process-global service published by a preset', async () => {
  const ctx = await setup()
  ctx.loader.builtins.leaks = { apply(child: Context) {
    child.provide('presetZulu', {})
    child.provide('presetAlpha', {})
  } }
  await declare(ctx, { id: 'leaks', plugins: [{ name: 'cordis:leaks' }] })
  await expect(ctx.agentPresets.mount(createScope(ctx, {}).ctx, 'leaks')).rejects.toThrow('presetAlpha, presetZulu')
})

/** Declarative Agent capability sets, activation and session binding. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: the optional `settings` service this registry keeps off the generated pages.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentPresetDocument, AgentPresetRoster } from './types.ts'
import { entryListProblem, type PresetDefinition } from './definition.ts'
import type { AgentPreset, Config } from './preset.ts'
import { agentPresetProjectionDefinition } from './session.ts'
import { auditRows, mountPreset, standingMountFor, serviceForAgent, type PresetMount } from './mount.ts'
import { definitionComposition, type AgentPresetComposition } from './composition-inventory.ts'

export { agentPresetProjectionDefinition } from './session.ts'
export { entryListProblem, type PresetDefinition } from './definition.ts'
export { auditRows, livePresetMounts, leakedServices, serviceForAgent, standingMountFor, type PresetMount, type RowAudit } from './mount.ts'
export type { AgentPreset, Config } from './preset.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresetRegistry
  }
}

interface Generation {
  scope: Scope
  key: ScopeKey
  mount: PresetMount
  users: number
  record: Definition
  workspace?: ScopeKey
  disposed?: boolean
}
interface Definition {
  config: PresetDefinition
  context: Context
  broken?: string
}
interface Binding {
  parent: ScopeParentBinding
  generation?: Generation
  placement?: PresetPlacement
}

/** Workspace lease transferred to the preset registry for one Agent. */
export interface PresetPlacement {
  readonly key: ScopeKey
  readonly ctx: Context
  release(): Promise<void>
}

/** Registry of YAML-declared presets and the revisions live Agents retain. */
export class AgentPresetRegistry extends TypertRemoteService {
  static inject = ['loader', 'sessionProjections']
  static Config = z.object({
    default: z.string().required(),
    selectedDefault: z.string().volatile(),
  })
  private readonly owner: Context
  private readonly definitions = new Map<string, Definition>()
  private readonly generations = new Map<ScopeKey, Generation>()
  private readonly mounts = new Map<ScopeKey | undefined, Map<Definition, Promise<Generation>>>()
  private readonly bindings = new WeakMap<ScopeKey, Binding>()
  private readonly switches = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.owner = ctx
    ctx.sessionProjections.register(agentPresetProjectionDefinition)
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'agent-preset/selected') ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /** Default preset for a subsequently created session. */
  get defaultId(): string { return this.config.selectedDefault.get() ?? this.config.default }

  /** Register a declaration; mount it on first Agent or cold inspection use. */
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    const context = this.ctx
    if (!definition.id.trim()) throw new Error('Preset id must not be empty')
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
    const record: Definition = { config: definition, context }
    const broken = entryListProblem(definition.plugins)
    if (broken !== undefined) record.broken = broken
    this.definitions.set(definition.id, record)
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      this.definitions.delete(definition.id)
      for (const generation of this.generations.values()) {
        if (generation.record === record) await this.collect(generation)
      }
    }
  }

  private async diagnostic(record: Definition): Promise<string | undefined> {
    return record.broken
  }

  private async collect(generation: Generation): Promise<void> {
    if (generation.users !== 0 || generation.disposed) return
    generation.disposed = true
    this.generations.delete(generation.key)
    const cache = this.mounts.get(generation.workspace)
    cache?.delete(generation.record)
    if (cache?.size === 0) this.mounts.delete(generation.workspace)
    await generation.scope.dispose()
  }

  private async retain(id?: string, placement?: PresetPlacement): Promise<Generation> {
    const wanted = id ?? this.defaultId
    for (;;) {
      const record = this.definitions.get(wanted)
      if (record === undefined) throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`,
        { agentPreset: wanted, available: [...this.definitions.keys()] })
      if (record.broken !== undefined) throw new RemoteError('agent-preset/invalid', record.broken,
        { agentPreset: wanted, reason: record.broken })
      let cache = this.mounts.get(placement?.key)
      if (cache === undefined) {
        cache = new Map()
        this.mounts.set(placement?.key, cache)
      }
      let pending = cache.get(record)
      if (pending === undefined) {
        const created = this.mountGeneration(record, placement)
        pending = created
        cache.set(record, created)
        void created.catch(() => {
          if (cache.get(record) === created) cache.delete(record)
          if (cache.size === 0) this.mounts.delete(placement?.key)
        })
      }
      const generation = await pending
      if (this.definitions.get(wanted) !== record || generation.disposed) {
        await this.collect(generation)
        continue
      }
      generation.users++
      return generation
    }
  }

  private async mountGeneration(record: Definition, placement?: PresetPlacement): Promise<Generation> {
    const key: ScopeKey = {}
    const scope = createScope(placement?.ctx ?? this.owner, key,
      placement === undefined ? undefined : { parent: placement.key })
    try {
      const context = scope.ctx.extend({ baseUrl: record.context.baseUrl })
      const mount = await mountPreset(context, record.config.id, record.config.plugins)
      let audit = await auditRows(mount.tree)
      if (audit.pending.length > 0) {
        await this.owner.loader.await()
        audit = await auditRows(mount.tree)
      }
      if (audit.pending.length > 0 || audit.failed.length > 0) {
        throw new Error([...audit.failed, ...audit.pending].join('\n'))
      }
      const generation: Generation = { scope, key, mount, users: 0, record,
        ...(placement === undefined ? {} : { workspace: placement.key }) }
      this.generations.set(key, generation)
      return generation
    } catch (error) {
      await scope.dispose()
      throw error
    }
  }

  /** Read every declared preset, including activation failures.
   * @returns Display metadata and loading diagnostics.
   */
  async list(): Promise<AgentPreset[]> {
    const rows = await Promise.all([...this.definitions.values()].map(async (record) => {
      const broken = await this.diagnostic(record)
      return {
        id: record.config.id,
        ...(record.config.name === undefined ? {} : { name: record.config.name }),
        ...(record.config.description === undefined ? {} : { description: record.config.description }),
        ...(record.config.order === undefined ? {} : { order: record.config.order }),
        ...(broken === undefined ? {} : { broken }),
      }
    }))
    return rows.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id))
  }

  /** Read the selection roster.
   * @returns Current presets, each marked when it is the default.
   */
  @Remote('list')
  async remoteExportList(): Promise<AgentPresetRoster> {
    const defaultId = this.defaultId
    return { presets: (await this.list()).map(row => ({ ...row, isDefault: row.id === defaultId })) }
  }

  /** Resolve an identity without starting an Agent.
   * @param id Explicit preset or the current default.
   * @returns Current metadata, including failure when activation failed.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const record = this.definitions.get(wanted)
    if (record === undefined) throw new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`,
      { agentPreset: wanted, available: [...this.definitions.keys()] })
    const broken = await this.diagnostic(record)
    return { id: wanted, ...(broken === undefined ? {} : { broken }) }
  }

  /** Read one declaration's child plugin list as YAML, for viewing only.
   * @param agentPreset Preset identity.
   * @returns The declared composition beside its published metadata.
   */
  @Remote('read')
  readDocument(agentPreset: string): Promise<AgentPresetDocument> {
    const record = this.definitions.get(agentPreset)
    if (record === undefined) {
      return Promise.reject(new RemoteError('agent-preset/not-found', `Unknown agent preset: ${agentPreset}`,
        { agentPreset, available: [...this.definitions.keys()] }))
    }
    const { id, name, description, plugins } = record.config
    // The Loader's own dialect, so `!!js` conditions read as declared rather than as expression objects.
    const content = dump(plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
    return Promise.resolve({
      agentPreset: id, content, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
    })
  }

  /** Transfer a workspace lease into the Agent scope before caller setup. */
  place(ctx: Context, placement: PresetPlacement): void {
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Agent placement requires a scoped context')
    if (this.bindings.has(key)) throw new Error('Agent is already placed')
    const binding: Binding = { parent: bindScopeParent(key, placement.key), placement }
    this.bindings.set(key, binding)
    try {
      ctx.effect(() => async () => {
        this.bindings.delete(key)
        const generation = binding.generation
        if (generation !== undefined) {
          generation.users--
          await this.collect(generation)
        }
        await placement.release()
      }, 'agent-preset.placement')
    } catch (error) {
      this.bindings.delete(key)
      throw error
    }
  }

  private async bind(ctx: Context, generation: Generation): Promise<void> {
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Agent preset binding requires a scoped context')
    const binding = this.bindings.get(key)
    if (binding?.generation === generation) return
    if (binding !== undefined) {
      if (binding.placement !== undefined && generation.workspace !== binding.placement.key) {
        throw new Error('Cannot bind a preset from another workspace')
      }
      binding.parent.rebind(generation.key)
      const old = binding.generation
      generation.users++
      binding.generation = generation
      if (old !== undefined) {
        old.users--
        await this.collect(old)
      }
    } else this.join(ctx, key, generation)
  }

  private join(ctx: Context, key: ScopeKey, generation: Generation): void {
    const binding: Binding = { parent: bindScopeParent(key, generation.key), generation }
    generation.users++
    this.bindings.set(key, binding)
    ctx.effect(() => async () => {
      this.bindings.delete(key)
      const current = binding.generation
      if (current !== undefined) {
        current.users--
        await this.collect(current)
      }
    }, 'agent-preset.binding')
  }

  /** Bind an unpublished Agent to the current preset revision.
   * @param ctx Agent context from its setup callback.
   * @param id Requested preset, or the default.
   * @returns Bound preset identity.
   */
  async mount(ctx: Context, id?: string): Promise<AgentPreset> {
    const key = scopeOf(ctx)
    const generation = await this.retain(id, key === undefined ? undefined : this.bindings.get(key)?.placement)
    try {
      await this.bind(ctx, generation)
      return { id: generation.mount.presetId }
    } finally {
      generation.users--
      await this.collect(generation)
    }
  }

  /** Join a child to the exact revision retained by its parent.
   * @param ctx Child Agent context.
   * @param parent Parent Agent context.
   * @returns Inherited preset id, or undefined in a preset-free composition.
   */
  composeFrom(ctx: Context, parent: Context): string | undefined {
    const mounted = standingMountFor(parent)
    if (mounted === undefined) return undefined
    const generation = this.generations.get(mounted.key)
    if (generation === undefined) throw new Error('Parent preset revision is unavailable')
    // A child has no existing binding, so this path has no asynchronous cleanup.
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Child preset binding requires a scope')
    const binding = this.bindings.get(key)
    if (binding?.generation !== undefined) throw new Error('Child already joined a preset')
    if (binding !== undefined) {
      if (binding.placement?.key !== generation.workspace) throw new Error('Cannot inherit a preset across workspaces')
      binding.parent.rebind(generation.key)
      binding.generation = generation
      generation.users++
    } else this.join(ctx, key, generation)
    return mounted.presetId
  }

  /** Read the preset a live Agent uses.
   * @param ctx Agent context.
   * @returns Its preset id, if bound.
   */
  composedPreset(ctx: Context): string | undefined { return standingMountFor(ctx)?.presetId }

  /** Read a service supplied inside an Agent's isolated preset group.
   * @param agent Agent whose composition is queried.
   * @param name Cordis service name.
   * @returns The service, or undefined.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.owner, agent, name)
  }

  /** Rebind a blank Agent; the caller owns the blank-session check.
   * @param ctx Agent context.
   * @param id Requested preset.
   * @returns The bound identity.
   */
  async recompose(ctx: Context, id: string): Promise<AgentPreset> {
    const preset = await this.mount(ctx, id)
    try { this.owner.emit('tools/change') }
    catch (error) { this.owner.logger.warn(`Preset tools observer: ${String(error)}`) }
    return preset
  }

  /** Select a preset before a session starts its first turn.
   * @param agent Target Agent.
   * @param agentPreset Requested identity.
   * @returns Committed preset identity.
   */
  @Remote('select')
  async select(agent: Agent, agentPreset: string): Promise<string> {
    const turn = (this.switches.get(agent.id) ?? Promise.resolve()).then(async () => {
      const boundary = this.owner.sessionProjections.stateOf(agent.session, 'turnBoundary')
      if (boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) {
        throw new RemoteError('agent-preset/locked', 'This session has already started', { sessionId: agent.id, agentPreset })
      }
      const preset = await this.recompose(agent.ctx, agentPreset)
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      return preset.id
    })
    const guard = turn.catch(() => undefined)
    this.switches.set(agent.id, guard)
    try { return await turn } finally {
      if (this.switches.get(agent.id) === guard) this.switches.delete(agent.id)
    }
  }

  /** Read current registrations for cold transcript presentation.
   * @param id Preset identity or the default.
   * @returns A revision lease; dispose it after the scoped read completes.
   */
  async acquireScope(id?: string): Promise<{ key: ScopeKey } & AsyncDisposable> {
    const generation = await this.retain(id)
    let disposed = false
    return { key: generation.key, [Symbol.asyncDispose]: async () => {
      if (disposed) return
      disposed = true
      generation.users--
      await this.collect(generation)
    } }
  }

  /** Read plugin rows without creating an Agent.
   * @returns Current declaration metadata and activation states.
   */
  compositionInventory(): Promise<AgentPresetComposition[]> {
    return Promise.all([...this.definitions.values()].map(async (record) => {
      const { id, name, description } = record.config
      const broken = await this.diagnostic(record)
      const read = definitionComposition(record.config.plugins, () => { throw new Error('Inactive definition') })
      return { id, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
        isDefault: id === this.defaultId,
        ...(broken === undefined ? {} : { broken }),
        rows: 'rows' in read ? read.rows : [] }
    }))
  }
}
export default AgentPresetRegistry

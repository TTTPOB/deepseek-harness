import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { listSubagentModels } from '../src/model-discovery.ts'
import type { ModelSelectionPolicy } from '../src/model-selection.ts'

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly empty = false) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: `${provider.toUpperCase()} API` }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.empty) return Promise.resolve([])
    return Promise.resolve([
      { provider, id: 'fast', name: 'Fast', description: 'Focused work.' },
      { provider, id: 'plain', name: 'Plain' },
    ])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model === 'plain') return Promise.resolve({ provider, id: model, name: 'Plain' })
    return Promise.resolve({
      provider,
      id: model,
      name: 'Fast',
      description: 'Focused work.',
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High', description: 'Quality first.' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

async function setup(routes = [
  { provider: 'alpha', model: 'fast' },
  { provider: 'alpha', model: 'plain' },
  { provider: 'beta', model: 'fast' },
  { provider: 'beta', model: 'plain' },
]) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  return { ctx, policy: { routes } satisfies ModelSelectionPolicy }
}

const signal = new AbortController().signal

function discover(
  ctx: Awaited<ReturnType<typeof setup>>['ctx'],
  policy: ModelSelectionPolicy,
  request: { provider?: string; model?: string },
) {
  return listSubagentModels(ctx.llm, policy, request, signal)
}

describe('listSubagentModels', () => {
  it('lists registered providers and follows live registration changes', async () => {
    const { ctx, policy } = await setup()
    expect(await discover(ctx, policy, {})).toBe('(no LLM providers)')

    const registration = ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    expect(await discover(ctx, policy, {})).toBe('alpha — ALPHA API')

    registration.replace(['beta'])
    expect(await discover(ctx, policy, {})).toBe('beta — BETA API')
    await ctx.fiber.dispose()
  })

  it('lists one provider\'s advertised models without treating the catalog as a whitelist', async () => {
    const { ctx, policy } = await setup()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    expect(await discover(ctx, policy, { provider: 'alpha' }))
      .toBe('alpha/fast — Fast: Focused work.\nalpha/plain — Plain')
    await ctx.fiber.dispose()
  })

  it('intersects provider and model discovery with the frozen allowlist', async () => {
    const { ctx, policy } = await setup([
      { provider: 'alpha', model: 'fast' },
      { provider: 'alpha', model: 'unlisted' },
      { provider: 'missing', model: 'hidden' },
    ])
    ctx.llm.registerAdapter(['alpha', 'beta'], new CatalogAdapter())

    expect(await discover(ctx, policy, {})).toBe('alpha — ALPHA API')
    expect(await discover(ctx, policy, { provider: 'alpha' })).toBe('alpha/fast — Fast: Focused work.')
    expect(await discover(ctx, policy, { provider: 'alpha', model: 'unlisted' }))
      .toContain('alpha/unlisted — Fast')

    await expect(discover(ctx, policy, { provider: 'alpha', model: 'plain' }))
      .rejects.toThrow('is not allowed for this Session')
    await ctx.fiber.dispose()
  })

  it('rejects an unauthorized provider before calling its adapter catalog', async () => {
    const { ctx, policy } = await setup([{ provider: 'alpha', model: 'fast' }])
    const adapter = new CatalogAdapter()
    const listModels = vi.spyOn(adapter, 'listModels')
    ctx.llm.registerAdapter(['alpha', 'secret'], adapter)

    await expect(discover(ctx, policy, { provider: 'secret' }))
      .rejects.toThrow('provider "secret" is not allowed for this Session')
    expect(listModels).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('renders an empty advertised model list', async () => {
    const { ctx, policy } = await setup([{ provider: 'alpha', model: 'fast' }])
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter(true))
    expect(await discover(ctx, policy, { provider: 'alpha' })).toBe('(no advertised models for alpha)')
    await ctx.fiber.dispose()
  })

  it('inspects exact-model efforts, descriptions, and defaults', async () => {
    const { ctx, policy } = await setup()
    ctx.llm.registerAdapter(['alpha', 'secret'], new CatalogAdapter())
    expect(await discover(ctx, policy, { provider: 'alpha', model: 'fast' })).toBe(
      'alpha/fast — Fast: Focused work.\nReasoning efforts:\n'
      + 'low — Low\nhigh (default) — High: Quality first.',
    )
    await ctx.fiber.dispose()
  })

  it('renders exact models without reasoning metadata', async () => {
    const { ctx, policy } = await setup()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    expect(await discover(ctx, policy, { provider: 'alpha', model: 'plain' }))
      .toBe('alpha/plain — Plain\nReasoning efforts:\n(no advertised reasoning efforts)')
    await ctx.fiber.dispose()
  })

  it.each([
    { args: { model: 'fast' }, expected: '`model` requires `provider`' },
    { args: { provider: '' }, expected: '`provider` must be non-empty' },
    { args: { provider: 'missing' }, expected: 'is not allowed for this Session' },
  ])('rejects incomplete or unavailable provider requests', async ({ args, expected }) => {
    const { ctx, policy } = await setup()
    await expect(discover(ctx, policy, args)).rejects.toThrow(expected)
    await ctx.fiber.dispose()
  })

  it('rejects an empty exact model after resolving the provider', async () => {
    const { ctx, policy } = await setup()
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    await expect(discover(ctx, policy, { provider: 'alpha', model: '' }))
      .rejects.toThrow('`model` must be non-empty')
    await ctx.fiber.dispose()
  })

  it('reports registered alternatives for an unavailable provider', async () => {
    const { ctx, policy } = await setup([
      { provider: 'alpha', model: 'fast' },
      { provider: 'missing', model: 'fast' },
    ])
    ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    await expect(discover(ctx, policy, { provider: 'missing' }))
      .rejects.toThrow('available providers: alpha')
    await ctx.fiber.dispose()
  })

  it('reports no available provider when the authorized registry intersection is empty', async () => {
    const { ctx, policy } = await setup([{ provider: 'missing', model: 'fast' }])
    await expect(discover(ctx, policy, { provider: 'missing' }))
      .rejects.toThrow('available providers: (none)')
    await ctx.fiber.dispose()
  })
})

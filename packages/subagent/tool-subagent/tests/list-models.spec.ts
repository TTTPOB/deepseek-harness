import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ToolCallId,
  LlmAdapter,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as tool from '../src/index.ts'
import { registerListSubagentModels } from '../src/list-models.ts'
import { testToolSignal, text } from './harness.ts'

class CatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string) {
    return { id: provider, name: `${provider.toUpperCase()} API` }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: 'Fast',
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }],
        defaultEffort: ReasoningEffortId('low'),
      },
    })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    return (async function* () { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } })()
  }
}

async function setupListTool() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerListSubagentModels(ctx, {
    routes: [{ provider: 'alpha', model: 'fast' }, { provider: 'beta', model: 'fast' }],
  })
  return ctx
}

let counter = 0

function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`list-models-${++counter}`),
    name: 'list_subagent_models',
    arguments: args,
  })
}

describe('list_subagent_models registration', () => {
  it('is omitted unless its delegation-tool instance owns discovery', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(tool, { provider: 'unused' })
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
  })

  it('stays registered without the optional LLM service and rejects discovery calls', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    registerListSubagentModels(ctx, { routes: [{ provider: 'alpha', model: 'fast' }] })
    const result = await call(ctx, {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('`llm` service is unavailable')
  })

  it('rejects two discovery-owning instances in one tool scope', async () => {
    const ctx = await setupListTool()
    expect(() => {
      registerListSubagentModels(ctx, { routes: [{ provider: 'alpha', model: 'fast' }] })
    }).toThrow('tool "list_subagent_models" is already registered')
  })

  it('follows live provider registration and disposal', async () => {
    const ctx = await setupListTool()
    const empty = await call(ctx, {})
    expect(empty.isError).toBe(false)
    expect(text(empty)).toBe('(no LLM providers)')

    const registration = ctx.llm.registerAdapter(['alpha'], new CatalogAdapter())
    const providers = await call(ctx, {})
    expect(providers.isError).toBe(false)
    expect(text(providers)).toBe('alpha — ALPHA API')

    registration.replace(['beta'])
    const changed = await call(ctx, {})
    expect(text(changed)).toBe('beta — BETA API')

    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('list_subagent_models')).toBeUndefined()
  })
})

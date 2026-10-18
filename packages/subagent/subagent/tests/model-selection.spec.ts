import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  assertAllowedModelRoutes,
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  modelRouteKey,
  preflightChildLlmRoute,
  requestedAgentOptions,
} from '../src/model-selection.ts'

const REASONING = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

const PARENT: AgentOptions = {
  provider: 'alpha',
  model: 'parent-model',
  reasoningEffort: ReasoningEffortId('high'),
}

describe('allowed route policy', () => {
  it('keys routes by provider and model', () => {
    expect(modelRouteKey({ provider: 'alpha', model: 'fast' }))
      .not.toBe(modelRouteKey({ provider: 'alpha', model: 'other' }))
    expect(modelRouteKey({ provider: 'beta', model: 'fast' }))
      .not.toBe(modelRouteKey({ provider: 'alpha', model: 'fast' }))
  })

  it('rejects empty route ids at the configuration boundary', () => {
    expect(() => { assertAllowedModelRoutes([{ provider: '', model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes([{ provider: 'provider', model: '' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes({ provider: 'provider', model: 'model' }) })
      .toThrow('requires an array of routes')
    expect(() => { assertAllowedModelRoutes([{ provider: 1, model: 'model' }]) })
      .toThrow('requires non-empty provider and model ids')
    expect(() => { assertAllowedModelRoutes([{ provider: 'alpha', model: 'fast' }, { provider: 'alpha', model: 'fast' }]) })
      .toThrow('repeats route "alpha/fast"')
    expect(() => { assertAllowedModelRoutes([{ provider: 'alpha', model: 'fast' }]) }).not.toThrow()
  })
})

describe('requestedAgentOptions', () => {
  it('keeps configured defaults when the call selects nothing', () => {
    const configured = { provider: 'alpha', model: 'configured', maxTokens: 5 }
    expect(requestedAgentOptions(PARENT, configured, {}, true)).toBe(configured)
    expect(requestedAgentOptions(PARENT, undefined, {}, true)).toBeUndefined()
  })

  it('rejects any selection when this instance disables it', () => {
    expect(() => requestedAgentOptions(PARENT, undefined, { reasoning_effort: 'low' }, false))
      .toThrow('child model selection is disabled for this tool instance')
  })

  it.each([
    { request: { provider: '' }, expected: '`provider` must be non-empty' },
    { request: { provider: 'alpha', model: '' }, expected: '`model` must be non-empty' },
    { request: { reasoning_effort: '' }, expected: '`reasoning_effort` must be non-empty' },
  ])('rejects empty model-facing values', ({ request, expected }) => {
    expect(() => requestedAgentOptions(PARENT, undefined, request, true)).toThrow(expected)
  })

  it('requires provider and model together', () => {
    expect(() => requestedAgentOptions(PARENT, undefined, { provider: 'alpha' }, true))
      .toThrow('`provider` and `model` must be supplied together')
    expect(() => requestedAgentOptions(PARENT, undefined, { model: 'fast' }, true))
      .toThrow('`provider` and `model` must be supplied together')
  })

  it('replaces a changed route and clears the configured route-owned effort', () => {
    const configured = {
      provider: 'alpha',
      model: 'configured-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 9,
    }
    expect(requestedAgentOptions(PARENT, configured, { provider: 'beta', model: 'fast' }, true))
      .toEqual({ provider: 'beta', model: 'fast', maxTokens: 9 })
  })

  it('retains a configured effort when the explicit route is unchanged', () => {
    const configured = {
      provider: 'alpha',
      model: 'configured-model',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect(requestedAgentOptions(PARENT, configured, { provider: 'alpha', model: 'configured-model' }, true))
      .toEqual(configured)
  })

  it('compares a route with parent values when no configured route exists', () => {
    expect(requestedAgentOptions(PARENT, undefined, { provider: 'alpha', model: 'parent-model' }, true))
      .toEqual({ provider: 'alpha', model: 'parent-model' })
    expect(requestedAgentOptions(PARENT, undefined, { provider: 'beta', model: 'fast' }, true))
      .toEqual({ provider: 'beta', model: 'fast' })
  })

  it('adds an effort-only override without inventing route values', () => {
    expect(requestedAgentOptions(PARENT, undefined, { reasoning_effort: 'low' }, true))
      .toEqual({ reasoningEffort: ReasoningEffortId('low') })
  })

  it('adds an explicit route and effort over configured defaults', () => {
    const configured = { maxTokens: 7 }
    expect(requestedAgentOptions(PARENT, configured, { provider: 'beta', model: 'fast', reasoning_effort: 'low' }, true))
      .toEqual({ maxTokens: 7, provider: 'beta', model: 'fast', reasoningEffort: ReasoningEffortId('low') })
  })
})

describe('delegation selection detection', () => {
  it('detects any model-facing selection field', () => {
    expect(hasDelegationModelRequest({})).toBe(false)
    expect(hasDelegationModelRequest({ provider: 'alpha' })).toBe(true)
    expect(hasDelegationModelRequest({ model: 'fast' })).toBe(true)
    expect(hasDelegationModelRequest({ reasoning_effort: 'low' })).toBe(true)
  })

  it('detects configured provider, model, or effort values', () => {
    expect(hasConfiguredLlmSelection(undefined)).toBe(false)
    expect(hasConfiguredLlmSelection({})).toBe(false)
    expect(hasConfiguredLlmSelection({ provider: 'alpha' })).toBe(true)
    expect(hasConfiguredLlmSelection({ model: 'fast' })).toBe(true)
    expect(hasConfiguredLlmSelection({ reasoningEffort: ReasoningEffortId('low') })).toBe(true)
  })
})

describe('assertAllowedModelSelection', () => {
  const policy = { routes: [{ provider: 'alpha', model: 'allowed-model' }] }

  it('allows pure inheritance and rejects explicit values outside the policy', () => {
    expect(() => { assertAllowedModelSelection(policy, PARENT, undefined, {}) }).not.toThrow()
    expect(() => { assertAllowedModelSelection(undefined, PARENT, undefined, {}) }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        PARENT,
        { provider: 'alpha', model: 'allowed-model' },
        { provider: 'alpha', model: 'allowed-model' },
      )
    }).not.toThrow()
    expect(() => {
      assertAllowedModelSelection(
        policy,
        PARENT,
        { provider: 'alpha', model: 'other-model' },
        { provider: 'alpha', model: 'other-model' },
      )
    }).toThrow('is not allowed for this Session')
    expect(() => {
      assertAllowedModelSelection(
        policy,
        PARENT,
        { reasoningEffort: ReasoningEffortId('low') },
        { reasoning_effort: 'low' },
      )
    }).toThrow('alpha/parent-model')
    expect(() => {
      assertAllowedModelSelection(policy, {}, { reasoningEffort: ReasoningEffortId('low') }, { reasoning_effort: 'low' })
    }).toThrow('without an effective provider and model')
  })
})

describe('preflightChildLlmRoute', () => {
  it('rejects a selection without an effective route', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(preflightChildLlmRoute(ctx.llm, {}, undefined, AbortSignal.abort()))
      .rejects.toThrow('without an effective provider and model')
    await ctx.fiber.dispose()
  })

  it('resolves the effective route through the live adapter', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new MockAdapter([], REASONING)
    const resolve = vi.spyOn(adapter, 'resolveModel')
    ctx.llm.registerAdapter(['alpha'], adapter)
    const signal = new AbortController().signal

    await preflightChildLlmRoute(ctx.llm, PARENT, { provider: 'alpha', model: 'unlisted' }, signal)
    expect(resolve).toHaveBeenCalledWith('alpha', 'unlisted', signal)

    await expect(preflightChildLlmRoute(ctx.llm, PARENT, { reasoningEffort: ReasoningEffortId('max') }, signal))
      .rejects.toThrow('does not support reasoning effort "max"')
    await ctx.fiber.dispose()
  })

  it('omits a parent effort when the caller forbids inheriting it', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['alpha'], new MockAdapter([], REASONING))
    const signal = new AbortController().signal
    const parent = { provider: 'alpha', model: 'parent-model', reasoningEffort: ReasoningEffortId('max') }

    await expect(preflightChildLlmRoute(ctx.llm, parent, undefined, signal))
      .rejects.toThrow('does not support reasoning effort "max"')
    await expect(preflightChildLlmRoute(ctx.llm, parent, undefined, signal, false)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })
})

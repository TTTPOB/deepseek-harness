import { describe, expect, it } from 'vitest'
import type { Context, Model, Api } from '@earendil-works/pi-ai'
import { Config, resolveProfiles } from '../src/config.ts'
import type { PiAiCompatProfile } from '../src/catalog.ts'

const cases = [
  { field: 'deferredToolsMode', value: 'kimi', api: 'openai-completions' },
  { field: 'supportsToolSearch', value: true, api: 'openai-responses' },
  { field: 'supportsAdditionalTools', value: true, api: 'openai-responses' },
  { field: 'supportsToolReferences', value: true, api: 'anthropic-messages' },
] as const

function configured(compat: Record<string, unknown>, api: string, modelCompat?: Record<string, unknown>) {
  return Config({ providers: { gateway: {
    api, baseURL: 'https://gateway.test/v1', compat,
    models: [{ id: 'model', ...(modelCompat === undefined ? {} : { compat: modelCompat }) }],
  } } })
}

function resolved(compat: Record<string, unknown>, api: string, modelCompat?: Record<string, unknown>) {
  const profile = resolveProfiles(configured(compat, api, modelCompat).providers).get('gateway')!
  return { provider: profile.piProvider!, model: profile.piProvider!.getModels()[0]! }
}

function deferredContext(model: Model<Api>): Context {
  return {
    tools: ['discover', 'echo'].map(name => ({
      name, description: `Use ${name}.`, parameters: { type: 'object', properties: {} },
    })),
    messages: [
      { role: 'user', content: 'Find echo.', timestamp: 0 },
      {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'toolCall', id: 'call_discover', name: 'discover', arguments: {} }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse', timestamp: 0,
      },
      {
        role: 'toolResult', toolCallId: 'call_discover', toolName: 'discover',
        content: [{ type: 'text', text: 'Echo is available.' }], addedToolNames: ['echo'],
        isError: false, timestamp: 0,
      },
    ],
  }
}

async function payload(compat: PiAiCompatProfile, api: string): Promise<unknown> {
  const { provider, model } = resolved({ ...compat }, api)
  let captured: unknown
  // onPayload runs after the real SDK serializer and before network I/O.
  const stream = provider.streamSimple(model, deferredContext(model), {
    apiKey: 'keyless-payload-test', maxRetries: 0,
    onPayload(value) { captured = value; throw new Error('payload captured') },
  })
  const result = await stream.result()
  expect(result.errorMessage).toContain('payload captured')
  expect(captured).toBeDefined()
  return captured
}

function json(value: unknown): string { return JSON.stringify(value) }

describe('deferred-tool compatibility configuration', () => {
  it.each(cases)('accepts $field on its consuming protocol', ({ field, value, api }) => {
    expect(resolved({ [field]: value }, api).model.compat).toMatchObject({ [field]: value })
  })

  it.each(cases.filter(row => row.value === true))('preserves explicit false for $field', ({ field, api }) => {
    expect(resolved({ [field]: false }, api).model.compat).toMatchObject({ [field]: false })
    expect(resolved({ [field]: true }, api, { [field]: false }).model.compat).toMatchObject({ [field]: false })
  })

  it.each(cases)('rejects invalid, empty, unknown and misplaced $field values', ({ field, value, api }) => {
    expect(() => configured({ [field]: 'unsupported' }, api)).toThrow()
    for (const empty of [null, undefined]) {
      expect(() => resolved({ [field]: empty }, api)).toThrow(/with no value/)
      expect(() => resolved({}, api, { [field]: empty })).toThrow(/with no value/)
    }
    expect(() => resolved({ [`${field}Typo`]: value }, api)).toThrow(/no wire protocol declares/)
    const wrongApi = api === 'openai-completions' ? 'anthropic-messages' : 'openai-completions'
    expect(() => resolved({ [field]: value }, wrongApi)).toThrow(/compat/)
    expect(() => resolved({}, wrongApi, { [field]: value })).toThrow(/compat/)
  })

  it('offers both Responses fields on Azure and Codex catalog routes', () => {
    for (const route of ['azure-openai-responses', 'openai-codex']) {
      const providers = Config({ providers: { [route]: { compat: {
        supportsToolSearch: true, supportsAdditionalTools: false,
      } } } }).providers
      const model = resolveProfiles(providers).get(route)!.piProvider!.getModels()[0]!
      expect(model.compat).toMatchObject({ supportsToolSearch: true, supportsAdditionalTools: false })
    }
  })

  it.each(cases)('leaves $field absent when unconfigured', ({ field, api }) => {
    expect(resolved({}, api).model.compat ?? {}).not.toHaveProperty(field)
  })
})

describe('real pi-ai deferred-tool request payloads', () => {
  it('serializes Responses tool search only when enabled', async () => {
    const enabled = await payload({ supportsToolSearch: true }, 'openai-responses')
    expect(json(enabled)).toContain('tool_search_output')
    expect(json(enabled)).toContain('defer_loading')
    expect(json(await payload({ supportsToolSearch: false }, 'openai-responses'))).not.toContain('tool_search_output')
    await expect(JSON.stringify(enabled, null, 2) + '\n').toMatchFileSnapshot('./expected/deferred-tool-search.json')
  })

  it('gives additional_tools precedence over tool search', async () => {
    const enabled = await payload({ supportsAdditionalTools: true, supportsToolSearch: true }, 'openai-responses')
    expect(json(enabled)).toContain('additional_tools')
    expect(json(enabled)).not.toContain('tool_search_output')
    expect(json(await payload({ supportsAdditionalTools: false }, 'openai-responses'))).not.toContain('additional_tools')
    await expect(JSON.stringify(enabled, null, 2) + '\n').toMatchFileSnapshot('./expected/deferred-additional-tools.json')
  })

  it('serializes Anthropic tool references only when enabled', async () => {
    const enabled = await payload({ supportsToolReferences: true }, 'anthropic-messages')
    expect(json(enabled)).toContain('tool_reference')
    expect(json(await payload({ supportsToolReferences: false }, 'anthropic-messages'))).not.toContain('tool_reference')
    await expect(JSON.stringify(enabled, null, 2) + '\n').toMatchFileSnapshot('./expected/deferred-tool-references.json')
  })

  it('applies Kimi serialization only when configured', async () => {
    const enabled = await payload({ deferredToolsMode: 'kimi' }, 'openai-completions')
    const ordinary = await payload({}, 'openai-completions')
    expect(enabled).not.toEqual(ordinary)
    await expect(JSON.stringify(enabled, null, 2) + '\n').toMatchFileSnapshot('./expected/deferred-kimi.json')
    await expect(JSON.stringify(ordinary, null, 2) + '\n').toMatchFileSnapshot('./expected/deferred-ordinary.json')
  })
})

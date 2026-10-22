import { describe, expect, it } from 'vitest'
import { Config, resolveProfiles } from '../src/config.ts'
import { THINKING_TOKEN_BUDGET_FIELDS } from '../src/catalog.ts'

function configured(compat: Record<string, unknown>, api = 'openai-completions'): Config {
  return Config({ providers: { gateway: {
    api, baseURL: 'https://gateway.test/v1', models: [{ id: 'model' }], compat,
  } } })
}

function resolved(compat: Record<string, unknown>, api = 'openai-completions') {
  return resolveProfiles(structuredClone(configured(compat, api).providers.get()) as import('../src/config.ts').Options['providers']).get('gateway')?.piProvider?.getModels()[0]?.compat
}

describe('pi-ai gateway compatibility declarations', () => {
  it.each(THINKING_TOKEN_BUDGET_FIELDS)('preserves reasoning-budget field %s', (field) => {
    expect(resolved({ thinkingTokenBudgetField: field })).toMatchObject({ thinkingTokenBudgetField: field })
  })

  it.each([-2, 0, 2])('preserves scheduler priority %s', (priority) => {
    expect(resolved({ vllmPriority: priority })).toMatchObject({ vllmPriority: priority })
  })

  it('preserves a disabled Responses output-cap parameter', () => {
    expect(resolved({ supportsMaxOutputTokens: false }, 'openai-responses'))
      .toMatchObject({ supportsMaxOutputTokens: false })
  })

  it.each(['chatTemplateKwargs', 'chatTemplateArgs'])('accepts thinking.budget in %s', (field) => {
    const value = { budget: { $var: 'thinking.budget' } }
    expect(resolved({ [field]: value })).toMatchObject({ [field]: value })
  })

  it.each([
    { thinkingTokenBudgetField: 'unknown' },
    { vllmPriority: 'high' },
    { vllmPriority: 0.5 },
    { supportsMaxOutputTokens: 'false' },
    { chatTemplateKwargs: { budget: { $var: 'thinking.unknown' } } },
    { chatTemplateArgs: { budget: { $var: 'thinking.unknown' } } },
  ])('rejects invalid schema values: %j', (compat) => {
    expect(() => configured(compat)).toThrow()
  })

  it.each([
    { thinkingTokenBudgetField: 'thinking_budget' },
    { vllmPriority: 0 },
    { supportsMaxOutputTokens: false },
  ])('rejects fields on a protocol that cannot consume them: %j', (compat) => {
    expect(() => resolved(compat, 'anthropic-messages')).toThrow(/compat/)
  })

  it.each([
    'supportsMidConvoEffort', 'allowedFallbackModels', 'sessionAffinityFormat',
  ])('withholds catalog-owned %s', (field) => {
    expect(() => resolved({ [field]: true }, 'anthropic-messages'))
      .toThrow(/which is not configurable here/)
  })

  it.each(['openai-completions', 'anthropic-messages', 'openai-responses'])(
    'preserves explicit system update capability for %s', (api) => {
      expect(resolved({ supportsMidConvoSystemMessages: true }, api))
        .toMatchObject({ supportsMidConvoSystemMessages: true })
    })

  it('preserves catalog protocol system update capability', () => {
    const route = resolveProfiles({ mistral: { compat: { supportsMidConvoSystemMessages: true } } }).get('mistral')
    expect(route?.piProvider?.getModels()[0]?.compat).toMatchObject({ supportsMidConvoSystemMessages: true })
  })

  it('preserves protocol-specific tool update capabilities', () => {
    expect(resolved({ supportsMidConvoToolAdditions: true }))
      .toMatchObject({ supportsMidConvoToolAdditions: true })
    expect(resolved({ supportsMidConvoToolChanges: true }, 'anthropic-messages'))
      .toMatchObject({ supportsMidConvoToolChanges: true })
  })

  it.each(['input', 'instructions'])('preserves Responses system prompt format %s', (systemPromptFormat) => {
    expect(resolved({ systemPromptFormat }, 'openai-responses')).toMatchObject({ systemPromptFormat })
  })

  it.each(['supportsAdditionalTools', 'supportsToolSearch'])('preserves Responses %s', (field) => {
    expect(resolved({ [field]: true }, 'openai-responses')).toMatchObject({ [field]: true })
    expect(() => resolved({ [field]: true })).toThrow(/compat/)
  })

  it('keeps generic additions absent unless configured', () => {
    expect(resolved({})).toBeUndefined()
  })
})
describe('Responses degenerate-output limit declarations', () => {
  const fields = ['maxConsecutiveWhitespaceChars', 'maxRepeatedPatternChars']
  const responsesProviders = ['openai', 'azure', 'openai-codex']

  it.each(responsesProviders)('passes provider limits to catalog models on %s', (provider) => {
    for (const limit of [0, 5000]) {
      const compat = { maxConsecutiveWhitespaceChars: limit, maxRepeatedPatternChars: limit }
      const route = resolveProfiles({ [provider]: { compat } }).get(provider)
      expect(route?.piProvider?.getModels()[0]?.compat).toMatchObject(compat)
    }
  })

  it('passes hand-declared provider limits to Responses models', () => {
    const compat = { maxConsecutiveWhitespaceChars: 5000, maxRepeatedPatternChars: 5000 }
    expect(resolved(compat, 'openai-responses')).toMatchObject(compat)
  })

  it.each(fields)('rejects negative and fractional %s in the configuration schema', (field) => {
    for (const value of [-1, 0.5]) {
      expect(() => configured({ [field]: value }, 'openai-responses')).toThrow()
      expect(() => Config({ providers: { gateway: {
        api: 'openai-responses', baseURL: 'https://gateway.test/v1',
        models: [{ id: 'model', compat: { [field]: value } }],
      } } })).toThrow()
    }
  })

  it.each(['openai-completions', 'anthropic-messages'])('rejects Responses-only limits on %s', (api) => {
    for (const field of fields) {
      expect(() => resolved({ [field]: 5000 }, api)).toThrow(/compat/)
    }
  })

  it.each(['amazon-bedrock', 'mistral', 'google', 'google-vertex'])('rejects Responses-only limits on catalog %s', (provider) => {
    for (const field of fields) {
      expect(() => resolveProfiles({ [provider]: { compat: { [field]: 5000 } } })).toThrow(/compat/)
    }
  })

  it('keeps both limits absent unless configured', () => {
    expect(resolved({}, 'openai-responses')).toBeUndefined()
  })

  it('lets a model override one provider limit without losing the other', () => {
    const route = resolveProfiles({ gateway: {
      api: 'openai-responses', baseURL: 'https://gateway.test/v1',
      compat: { maxConsecutiveWhitespaceChars: 5000, maxRepeatedPatternChars: 5000 },
      models: [{ id: 'model', compat: { maxConsecutiveWhitespaceChars: 0 } }],
    } }).get('gateway')
    expect(route?.piProvider?.getModels()[0]?.compat).toMatchObject({
      maxConsecutiveWhitespaceChars: 0, maxRepeatedPatternChars: 5000,
    })
  })
})

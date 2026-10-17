/** Gateway declarations through the target pi-ai fork's real Responses serializer. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

it.each([undefined, 'input', 'instructions'] as const)(
  'serializes the configured Responses system prompt format %s', async (systemPromptFormat) => {
    const server = await mockServer([{ status: 401, body: '{"error":{"message":"fixture rejection"}}' }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      const profiles = resolveProfiles({ gateway: {
        api: 'openai-responses', baseURL: server.url,
        models: [{ id: 'private-model' }],
        compat: {
          supportsMidConvoSystemMessages: true,
          supportsAdditionalTools: true,
          ...systemPromptFormat === undefined ? {} : { systemPromptFormat },
        },
      } })
      const adapter = new PiAiAdapter({
        profiles: () => profiles,
        resolveApiKey: () => Promise.resolve('fixture-key'),
        auth: memoryAuth(),
      })
      ctx.llm.registerAdapter(['gateway'], adapter)
      expect(await adapter.resolveModel('gateway', 'private-model')).toMatchObject({
        systemPromptUpdate: 'in-history', toolUpdate: 'addition-only',
      })
      const system = (text: string) => createMessage({
        role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }],
      })
      await assemble(ctx, { provider: 'gateway', model: 'private-model', messages: [
        system('initial policy'),
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }),
        system('later policy'),
      ] })
      expect(server.requests).toHaveLength(1)
      const request = server.requests[0] as { instructions?: string; input: unknown[] }
      if (systemPromptFormat === 'instructions') {
        expect(request.instructions).toBe('initial policy')
        expect(JSON.stringify(request.input)).not.toContain('initial policy')
      } else {
        expect(request).not.toHaveProperty('instructions')
        expect(JSON.stringify(request.input)).toContain('initial policy')
      }
      expect(JSON.stringify(request.input)).toContain('later policy')
    } finally {
      await ctx.fiber.dispose()
    }
  },
)

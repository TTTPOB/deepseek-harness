/** System messages serialize as an ordered Responses transcript. */
import { afterEach, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

it('keeps initial and later system messages in Responses input order', async () => {
  const server = await mockServer([{ status: 401, body: '{"error":{"message":"fixture rejection"}}' }])
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const profiles = resolveProfiles({ gateway: {
    api: 'openai-responses', baseURL: server.url,
    models: [{ id: 'private-model' }],
    compat: { supportsMidConvoSystemMessages: true },
  } })
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: () => Promise.resolve('fixture-key'),
    auth: memoryAuth(),
  })
  ctx.effect(() => ctx.llm.registerAdapter(['gateway'], adapter))
  const initial = 'initial policy'
  const user = 'hello'
  const later = 'later policy'
  const system = (text: string) => createMessage({
    role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }],
  })
  await assemble(ctx, { provider: 'gateway', model: 'private-model', messages: [
    system(initial),
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: user }] }),
    system(later),
  ] })
  expect(server.requests).toHaveLength(1)
  const request = server.requests[0] as { input: unknown[] }
  expect(request).not.toHaveProperty('instructions')
  expect(request.input).toEqual([
    { role: 'system', content: initial },
    { role: 'user', content: [{ type: 'input_text', text: user }] },
    { role: 'system', content: later },
  ])
})

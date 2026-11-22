import { afterEach, describe, expect, it } from 'vitest'
import type { AssistantMessageEvent, Model } from '@earendil-works/pi-ai'
import { stream as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages'
import { stream as streamCompletions } from '@earendil-works/pi-ai/api/openai-completions'
import { stream as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { toStreamChunks } from '../src/stream.ts'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { anthropicFrame as frame, anthropicMessageStart, closeMockServers, mockServer } from './mock-server.ts'

afterEach(closeMockServers)

/** A write call whose arguments arrive in many small deltas. */
const args = { file_path: 'notes.md', content: 'x'.repeat(2048) }
const argsJson = JSON.stringify(args)
const fragments = argsJson.match(/.{1,7}/gs) ?? []

function model<A extends 'anthropic-messages' | 'openai-completions' | 'openai-responses'>(api: A, baseUrl: string): Model<A> {
  return {
    id: 'm', name: 'm', api, provider: 'test', baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  }
}

async function collect(events: AsyncIterable<AssistantMessageEvent>) {
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of toStreamChunks(events)) {
    chunks.push(chunk)
    assembler.push(chunk)
  }
  const deltas = chunks.flatMap(chunk => chunk.type === 'tool-call-delta' && chunk.argumentsDelta
    ? [chunk.argumentsDelta] : [])
  return { assembler, chunks, deltas }
}

async function expectCompleteArguments(events: AsyncIterable<AssistantMessageEvent>, id: string) {
  const { assembler, chunks, deltas } = await collect(events)
  expect(deltas).toEqual(fragments)
  expect(assembler.blocks()).toEqual([{ type: 'tool-call', id, name: 'write', arguments: argsJson }])
  expect(chunks.at(-2)?.type).toBe('usage')
  expect(assembler.finish).toEqual({ kind: 'tool-calls' })
}

const context = normalizeContext({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] })

describe('streamed tool-call arguments through pi-ai and the adapter', () => {
  it('preserves an empty Responses message after parallel tool calls with its replay metadata', async () => {
    const calls = [0, 1, 2].map(index => ({ type: 'function_call', call_id: `call_${index}`, id: `item_${index}`, name: 'read', arguments: '{}' }))
    const empty = { type: 'message', id: 'message_empty', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] }
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"response_empty_text"}}',
      ...[...calls, empty].flatMap((item, output_index) => [
        JSON.stringify({ type: 'response.output_item.added', output_index, item }),
        JSON.stringify({ type: 'response.output_item.done', output_index, item }),
      ]),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'response_empty_text', status: 'completed', output: [...calls, empty], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const assembler = new BlockAssembler()
    for await (const chunk of toStreamChunks(streamResponses(model('openai-responses', server.url), context, { apiKey: 'test-key' }))) {
      assembler.push(chunk)
    }
    expect(assembler.blocks()).toEqual([
      ...calls.map(call => ({ type: 'tool-call', id: `${call.call_id}|${call.id}`, name: 'read', arguments: '{}' })),
      { type: 'text', text: '' },
    ])
    expect(assembler.replayState?.blocks).toEqual([
      ...calls.map(() => ({ type: 'tool-call' })),
      { type: 'text', textSignature: JSON.stringify({ v: 1, id: 'message_empty' }) },
    ])
    expect(assembler.finish).toEqual({ kind: 'tool-calls' })
    expect(server.requests).toHaveLength(1)
  })

  it('openai-completions emits each fragment and closes with final arguments', async () => {
    const server = await mockServer([{ events: [
      JSON.stringify({ choices: [{
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } }],
        },
        index: 0, finish_reason: null,
      }] }),
      ...fragments.map(fragment => JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] }, index: 0, finish_reason: null }],
      })),
      '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      '[DONE]',
    ] }])
    const events = streamCompletions(model('openai-completions', server.url), context, { apiKey: 'test-key' })
    await expectCompleteArguments(events, 'call_1')
  })

  it('anthropic-messages emits each fragment and closes with final arguments', async () => {
    const server = await mockServer([{ events: [
      anthropicMessageStart,
      frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write', input: {} } }),
      ...fragments.map(fragment => frame({
        type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: fragment },
      })),
      frame({ type: 'content_block_stop', index: 0 }),
      frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } }),
      frame({ type: 'message_stop' }),
    ] }])
    const events = streamAnthropic(model('anthropic-messages', server.url), context, { apiKey: 'test-key' })
    await expectCompleteArguments(events, 'toolu_1')
  })

  it('openai-responses emits each fragment and closes with final arguments', async () => {
    const item = { type: 'function_call', call_id: 'call_1', id: 'fc_1', name: 'write' }
    const server = await mockServer([{ events: [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }),
      ...fragments.map(fragment => JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: fragment })),
      JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 0, arguments: argsJson }),
      JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: argsJson } }),
      JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      } }),
    ] }])
    const events = streamResponses(model('openai-responses', server.url), context, { apiKey: 'test-key' })
    await expectCompleteArguments(events, 'call_1|fc_1')
  })

  it('openai-responses finishes at the output cap without finalizing an unfinished tool call', async () => {
    const item = { type: 'function_call', call_id: 'call_1', id: 'fc_1', name: 'write', arguments: '' }
    const partial = fragments.slice(0, 3)
    const maxTokens = 32
    const server = await mockServer([{ events: [
      JSON.stringify({ type: 'response.created', response: { id: 'resp_truncated' } }),
      JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }),
      ...partial.map(delta => JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta })),
      JSON.stringify({ type: 'response.incomplete', response: {
        id: 'resp_truncated', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [{ ...item, arguments: partial.join(''), status: 'incomplete' }],
        usage: { input_tokens: 3, output_tokens: maxTokens, total_tokens: 3 + maxTokens },
      } }),
    ] }])
    const { assembler, chunks, deltas } = await collect(streamResponses(
      model('openai-responses', server.url), context, { apiKey: 'test-key', maxTokens },
    ))
    expect(server.requests).toEqual([expect.objectContaining({ max_output_tokens: maxTokens })])
    expect(deltas).toEqual(partial)
    expect(chunks.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toBe(false)
    expect(chunks.at(-2)?.type).toBe('usage')
    expect(assembler.blocks()).toEqual([])
    expect(assembler.finish).toEqual({ kind: 'max-tokens' })
  })
})

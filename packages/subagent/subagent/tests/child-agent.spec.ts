import { describe, expect, it } from 'vitest'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveChildAgentOptions, resolveChildDepth } from '../src/child-agent.ts'

function parentAgent(selection?: ModelSelection): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
    model: { current: () => selection },
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort when no route is supplied', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears parent effort through an explicit undefined override', () => {
    const parent = parentAgent()
    const child = resolveChildAgentOptions(parent, {
      provider: 'parent-provider', model: 'parent-model', reasoningEffort: undefined,
    }, 1)
    expect(child.reasoningEffort).toBeUndefined()
    expect(parent.options.reasoningEffort).toBe('high')
  })

  it('inherits compatible effort when only one route field is overridden', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'parent-model' }, 1).reasoningEffort).toBe('high')
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the current retained selection before any request over creation-time values', () => {
    const selection: ModelSelection = {
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: ReasoningEffortId('low'),
    }
    const parent = parentAgent(selection)
    expect(parent.session.snapshotEvents()).toHaveLength(0)
    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      ...selection,
      maxTokens: parent.options.maxTokens,
      subagentDepth: 1,
    })
  })
})

describe('delegation depth limits', () => {
  it.each([-1, -0, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid runtime depth %s', (depth) => {
    const parent = parentAgent()
    parent.options.subagentDepth = depth
    expect(() => resolveChildDepth(parent, undefined)).toThrow('agent subagentDepth must be a non-negative safe integer')
  })

  it('rejects a child depth beyond the exact integer range', () => {
    const parent = parentAgent()
    parent.options.subagentDepth = Number.MAX_SAFE_INTEGER
    expect(() => resolveChildDepth(parent, undefined)).toThrow('subagent child depth exceeds the safe-integer range')
  })
})

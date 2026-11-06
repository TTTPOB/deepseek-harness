import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '../src/model-selection-state.ts'

const ALLOWED = [{ provider: 'alpha', model: 'fast-model' }]

async function mountProjections() {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const policy = await ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  return { ctx, policy }
}

describe('subagent model-selection projection', () => {
  it('initializes null, records once, and reads detached routes', async () => {
    const { ctx, policy } = await mountProjections()
    const session = Session.create(SessionId('projection'))

    expect(subagentModelSelectionPolicy(policy, session)).toBeUndefined()

    session.append('subagent/model-selection-policy', { allowedModels: ALLOWED })
    const recorded = session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy')
    expect(recorded).toHaveLength(1)

    const first = subagentModelSelectionPolicy(policy, session)
    expect(first).toEqual(ALLOWED)
    Object.assign(first![0]!, { provider: 'mutated' })
    expect(subagentModelSelectionPolicy(policy, session)).toEqual(ALLOWED)

    session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'beta', model: 'other' }] })
    expect(subagentModelSelectionPolicy(policy, session)).toEqual(ALLOWED)
    await ctx.fiber.dispose()
  })

  it('rejects an empty or malformed durable policy when it is read', async () => {
    const { ctx, policy } = await mountProjections()
    const empty = Session.create(SessionId('empty-policy'))
    empty.append('subagent/model-selection-policy', { allowedModels: [] })
    expect(() => subagentModelSelectionPolicy(policy, empty))
      .toThrow('requires at least one route')

    const malformed = Session.create(SessionId('malformed-policy'))
    malformed.append('subagent/model-selection-policy', {
      allowedModels: [{ provider: 1, model: 'fast-model' }],
    } as never)
    expect(() => subagentModelSelectionPolicy(policy, malformed))
      .toThrow('requires non-empty provider and model ids')
    await ctx.fiber.dispose()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import {
  recordSubagentModelSelection,
  selectSubagentModelSelectionPolicy,
  subagentModelSelectionPolicy,
  subagentModelSelectionProjectionDefinition,
} from '../src/model-selection-state.ts'

const ALLOWED = [{ provider: 'alpha', model: 'fast-model' }]

async function mountProjections() {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  return ctx
}

function childSession(id: string, parentSession: SessionId): Session {
  return Session.create(SessionId(id), undefined, {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
    origin: 'subagent',
    parentSession,
  })
}

describe('subagent model-selection projection', () => {
  it('initializes null, records once, and reads detached routes', async () => {
    const ctx = await mountProjections()
    const session = Session.create(SessionId('projection'))

    expect(subagentModelSelectionPolicy(ctx.sessionProjections, session)).toBeUndefined()

    recordSubagentModelSelection(ctx.sessionProjections, session, ALLOWED)
    recordSubagentModelSelection(ctx.sessionProjections, session, [{ provider: 'beta', model: 'other' }])
    const recorded = session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy')
    expect(recorded).toHaveLength(1)

    const first = subagentModelSelectionPolicy(ctx.sessionProjections, session)
    expect(first).toEqual(ALLOWED)
    Object.assign(first![0]!, { provider: 'mutated' })
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, session)).toEqual(ALLOWED)

    session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'beta', model: 'other' }] })
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, session)).toEqual(ALLOWED)
    await ctx.fiber.dispose()
  })

  it('rejects an empty or malformed durable policy when it is read', async () => {
    const ctx = await mountProjections()
    const empty = Session.create(SessionId('empty-policy'))
    empty.append('subagent/model-selection-policy', { allowedModels: [] })
    expect(() => subagentModelSelectionPolicy(ctx.sessionProjections, empty))
      .toThrow('requires at least one route')

    const malformed = Session.create(SessionId('malformed-policy'))
    malformed.append('subagent/model-selection-policy', {
      allowedModels: [{ provider: 1, model: 'fast-model' }],
    } as never)
    expect(() => subagentModelSelectionPolicy(ctx.sessionProjections, malformed))
      .toThrow('requires non-empty provider and model ids')
    await ctx.fiber.dispose()
  })
})

describe('selectSubagentModelSelectionPolicy', () => {
  it('returns nothing when the composition does not enable selection', async () => {
    const ctx = await mountProjections()
    const session = Session.create(SessionId('disabled-composition'))
    expect(selectSubagentModelSelectionPolicy({ projections: ctx.sessionProjections, sessions: undefined }, session, undefined))
      .toBeUndefined()
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, session)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('samples the current preference once for a fresh top-level Session', async () => {
    const ctx = await mountProjections()
    const session = Session.create(SessionId('fresh-root'))
    const current = vi.fn(() => ({ enabled: true, allowedModels: [...ALLOWED] }))
    const scope = { projections: ctx.sessionProjections, sessions: undefined }

    expect(selectSubagentModelSelectionPolicy(scope, session, { current })).toEqual({ routes: ALLOWED })
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, session)).toEqual(ALLOWED)
    expect(selectSubagentModelSelectionPolicy(scope, session, { current })).toEqual({ routes: ALLOWED })
    expect(current).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('records nothing when the current preference is disabled', async () => {
    const ctx = await mountProjections()
    const session = Session.create(SessionId('disabled-preference'))
    const policy = selectSubagentModelSelectionPolicy(
      { projections: ctx.sessionProjections, sessions: undefined },
      session,
      { current: () => ({ enabled: false, allowedModels: [...ALLOWED] }) },
    )
    expect(policy).toBeUndefined()
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, session)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('does not grant a policy to an existing Session composed without one', async () => {
    const ctx = await mountProjections()
    const old = Session.create(SessionId('old-session'), [])
    const resumed = Session.create(SessionId('resumed-session'), old.snapshotEvents())
    const current = vi.fn(() => ({ enabled: true, allowedModels: [...ALLOWED] }))

    expect(selectSubagentModelSelectionPolicy({ projections: ctx.sessionProjections, sessions: undefined }, resumed, { current }))
      .toBeUndefined()
    expect(current).not.toHaveBeenCalled()
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, resumed)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('inherits a delegating parent policy and freezes it on the child', async () => {
    const ctx = await mountProjections()
    const parentSession = Session.create(SessionId('policy-parent'))
    recordSubagentModelSelection(ctx.sessionProjections, parentSession, ALLOWED)
    const child = childSession('policy-child', parentSession.id)
    const scope = {
      projections: ctx.sessionProjections,
      sessions: { get: (id: SessionId) => id === parentSession.id ? parentSession : undefined },
    }
    const current = vi.fn(() => { throw new Error('must not read settings') })

    expect(selectSubagentModelSelectionPolicy(scope, child, { current })).toEqual({ routes: ALLOWED })
    expect(current).not.toHaveBeenCalled()
    expect(subagentModelSelectionPolicy(ctx.sessionProjections, child)).toEqual(ALLOWED)

    const restored = Session.create(SessionId('restored-child'), child.snapshotEvents())
    expect(selectSubagentModelSelectionPolicy(
      { projections: ctx.sessionProjections, sessions: { get: () => undefined } },
      restored,
      { current },
    )).toEqual({ routes: ALLOWED })
    expect(current).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('does not fall back to the preference for a child or an orphan parent', async () => {
    const ctx = await mountProjections()
    const plainParent = Session.create(SessionId('plain-parent'))
    const child = childSession('plain-child', plainParent.id)
    const current = vi.fn(() => ({ enabled: true, allowedModels: [...ALLOWED] }))
    const scope = {
      projections: ctx.sessionProjections,
      sessions: { get: (id: SessionId) => id === plainParent.id ? plainParent : undefined },
    }

    expect(selectSubagentModelSelectionPolicy(scope, child, { current })).toBeUndefined()

    const orphan = childSession('orphan-child', SessionId('missing-parent'))
    expect(selectSubagentModelSelectionPolicy(scope, orphan, { current })).toBeUndefined()
    expect(current).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('requires the Session registry when a child inherits its parent policy', async () => {
    const ctx = await mountProjections()
    const child = childSession('child-without-registry', SessionId('missing-parent'))
    expect(() => selectSubagentModelSelectionPolicy(
      { projections: ctx.sessionProjections, sessions: undefined },
      child,
      { current: () => ({ enabled: true, allowedModels: [...ALLOWED] }) },
    )).toThrow('child model-selection inheritance requires the Session registry')
    await ctx.fiber.dispose()
  })
})

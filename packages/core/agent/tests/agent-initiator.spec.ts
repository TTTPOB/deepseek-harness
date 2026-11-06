import { describe, expect, it, vi } from 'vitest'
import { AsyncResource } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import { runInNewContext } from 'node:vm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

function agent(id: string): Agent {
  return { id: SessionId(id) } as Agent
}

async function harness(): Promise<{
  ctx: Context
  service: AgentRegistry
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentRegistry)
  return {
    ctx,
    service: ctx.agents,
    dispose: fiber.dispose,
  }
}

/** Fail a lifecycle regression promptly instead of waiting for Vitest's suite timeout. */
async function promptly<T>(task: Promise<T>): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  const timer = setTimeout(() => { timeout.reject(new Error('initiator teardown did not settle promptly')) }, 1000)
  try {
    return await Promise.race([task, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

describe('AgentRegistry initiator scope', () => {
  it('reports an absent initiator and requires an active boundary', async () => {
    const { service, dispose } = await harness()
    expect(service.currentInitiator()).toBeUndefined()
    expect(() => service.requireInitiator()).toThrow('no initiating agent is active')
    await dispose()
  })

  it('preserves exact synchronous and Promise return identities across await', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('identity')
    const value = { result: true }
    expect(service.withInitiator(initiator, () => {
      expect(service.requireInitiator()).toBe(initiator)
      return value
    })).toBe(value)

    const promise = service.withInitiator(initiator, async () => {
      expect(service.requireInitiator()).toBe(initiator)
      await Promise.resolve()
      expect(service.requireInitiator()).toBe(initiator)
      return value
    })
    expect(service.withInitiator(initiator, () => promise)).toBe(promise)
    await expect(promise).resolves.toBe(value)
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('clears captured asynchronous contexts when a synchronous operation returns', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('sync-captured')
    const read = service.withInitiator(initiator, () => {
      expect(service.get(initiator.id)).toBeUndefined()
      const captured = AsyncResource.bind(() => service.currentInitiator())
      expect(captured()).toBe(initiator)
      return captured
    })

    expect(read()).toBeUndefined()
    await dispose()
  })

  it('keeps captured contexts readable across await and clears them on fulfillment', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('async-captured')
    const release = Promise.withResolvers<boolean>()
    let read = (): Agent | undefined => undefined
    const pending = service.withInitiator(initiator, async () => {
      read = AsyncResource.bind(() => service.currentInitiator())
      await release.promise
      expect(service.requireInitiator()).toBe(initiator)
      expect(read()).toBe(initiator)
    })

    expect(read()).toBe(initiator)
    release.resolve(true)
    await pending
    expect(read()).toBeUndefined()
    await dispose()
  })

  it('clears captured contexts after synchronous throws and Promise rejection', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('failed-captured')
    const error = new Error('operation failed')
    let read = (): Agent | undefined => undefined
    expect(() => service.withInitiator(initiator, () => {
      read = AsyncResource.bind(() => service.currentInitiator())
      throw error
    })).toThrow(error)
    expect(read()).toBeUndefined()

    await expect(service.withInitiator(initiator, async () => {
      read = AsyncResource.bind(() => service.currentInitiator())
      await Promise.resolve()
      expect(read()).toBe(initiator)
      throw error
    })).rejects.toBe(error)
    expect(read()).toBeUndefined()
    await dispose()
  })

  it('clears a settled child context while its parent operation continues', async () => {
    const { service, dispose } = await harness()
    const parent = agent('captured-parent')
    const child = agent('captured-child')
    let readParent = (): Agent | undefined => undefined
    await service.withInitiator(parent, async () => {
      readParent = AsyncResource.bind(() => service.currentInitiator())
      const readChild = await service.withInitiator(child, async () => {
        await Promise.resolve()
        expect(service.requireInitiator()).toBe(child)
        return AsyncResource.bind(() => service.currentInitiator())
      })
      expect(readChild()).toBeUndefined()
      expect(service.requireInitiator()).toBe(parent)
      expect(readParent()).toBe(parent)
    })
    expect(readParent()).toBeUndefined()
    await dispose()
  })

  it('tracks a branded Promise without calling its overridable then property', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('overridden-then')
    const release = Promise.withResolvers<boolean>()
    void Object.defineProperty(release.promise, 'then', {
      value: () => { throw new Error('overridden then called') },
    })

    const pending = service.withInitiator(initiator, () => release.promise)
    expect(pending).toBe(release.promise)

    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await new Promise<void>((resolve, reject) => {
      void Promise.prototype.then.call(pending, resolve, reject)
    })
    await disposal
    expect(disposed).toBe(true)
  })

  it('preserves a settled branded Promise when its species blocks observer construction', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('invalid-species')
    const promise = Promise.resolve()
    const constructor = {}
    Object.defineProperty(constructor, Symbol.species, {
      get: () => { throw new Error('invalid species') },
    })
    void Object.defineProperty(promise, 'constructor', { value: constructor })

    let read = (): Agent | undefined => undefined
    expect(service.withInitiator(initiator, () => {
      read = AsyncResource.bind(() => service.currentInitiator())
      return promise
    })).toBe(promise)
    expect(read()).toBe(initiator)
    await promptly(dispose())
  })

  it('isolates overlapping initiators', async () => {
    const { service, dispose } = await harness()
    const a = agent('a')
    const b = agent('b')
    const bothStarted = Promise.withResolvers<boolean>()
    const release = Promise.withResolvers<boolean>()
    let starts = 0
    const run = (initiator: Agent): Promise<void> => service.withInitiator(initiator, async () => {
      expect(service.requireInitiator()).toBe(initiator)
      starts += 1
      if (starts === 2) bothStarted.resolve(true)
      await release.promise
      expect(service.requireInitiator()).toBe(initiator)
    })

    const pending = [run(a), run(b)]
    await bothStarted.promise
    expect(service.currentInitiator()).toBeUndefined()
    release.resolve(true)
    await Promise.all(pending)
    await dispose()
  })

  it('restores nested and explicitly cleared boundaries', async () => {
    const { service, dispose } = await harness()
    const parent = agent('parent')
    const child = agent('child')

    service.withInitiator(parent, () => {
      expect(service.requireInitiator()).toBe(parent)
      service.withInitiator(child, () => { expect(service.requireInitiator()).toBe(child) })
      expect(service.requireInitiator()).toBe(parent)
      service.withoutInitiator(() => {
        expect(service.currentInitiator()).toBeUndefined()
        expect(() => service.requireInitiator()).toThrow('no initiating agent is active')
      })
      expect(service.requireInitiator()).toBe(parent)
    })
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('restores the parent after synchronous throws and rejected operations', async () => {
    const { service, dispose } = await harness()
    const parent = agent('parent')
    const child = agent('child')
    const syncError = new Error('sync failure')
    const asyncError = new Error('async failure')

    service.withInitiator(parent, () => {
      expect(() => service.withInitiator(child, () => { throw syncError })).toThrow(syncError)
      expect(service.requireInitiator()).toBe(parent)
    })
    await expect(service.withInitiator(child, async () => {
      await Promise.resolve()
      throw asyncError
    })).rejects.toBe(asyncError)
    expect(service.currentInitiator()).toBeUndefined()
    await dispose()
  })

  it('stops new boundaries, drains active Promises, and invalidates retained references', async () => {
    const { ctx, service, dispose } = await harness()
    const initiator = agent('draining')
    const release = Promise.withResolvers<boolean>()
    const pending = service.withInitiator(initiator, async () => {
      await release.promise
      expect(service.requireInitiator()).toBe(initiator)
    })
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()

    expect(() => service.withInitiator(initiator, () => 1)).toThrow('agent initiator scope is disposed')
    expect(() => service.withoutInitiator(() => 1)).toThrow('agent initiator scope is disposed')
    expect(disposed).toBe(false)
    expect(ctx.get('agents')).toBeUndefined()
    release.resolve(true)
    await pending
    await disposal
    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
    expect(() => service.requireInitiator()).toThrow('agent initiator scope is disposed')
  })

  it('drains cross-realm Promise boundaries before disposal', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('cross-realm')
    const release = Promise.withResolvers<boolean>()
    const operation = runInNewContext(
      '(async () => { await release; inspect() })',
      {
        release: release.promise,
        inspect: () => { expect(service.requireInitiator()).toBe(initiator) },
      },
    ) as () => Promise<void>
    const pending = service.withInitiator(initiator, operation)
    expect(pending).not.toBeInstanceOf(Promise)

    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await pending
    await disposal
    expect(disposed).toBe(true)
  })

  it('does not self-deadlock when a boundary returns service disposal', async () => {
    const { service, dispose } = await harness()
    const initiator = agent('service-disposer')

    const returned = service.withInitiator(initiator, dispose)
    await promptly(returned)

    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })

  it('does not self-deadlock when nested boundaries return ancestor disposal', async () => {
    const { ctx, service } = await harness()
    const parent = agent('parent-disposer')
    const child = agent('child-disposer')
    let disposal: Promise<void> | undefined

    const returned = service.withInitiator(parent, () => service.withInitiator(child, () => {
      disposal = ctx.fiber.dispose()
      return disposal
    }))
    expect(returned).toBe(disposal)

    await promptly(returned)
    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })

  it('keeps an in-flight initiator after reentrant teardown releases its drain count', async () => {
    const { ctx, service } = await harness()
    const initiator = agent('reentrant-in-flight')
    const unrelated = agent('reentrant-unrelated')
    const release = Promise.withResolvers<boolean>()
    const pending = service.withInitiator(unrelated, () => release.promise)

    const returned = service.withInitiator(initiator, async () => {
      const read = AsyncResource.bind(() => service.currentInitiator())
      const disposal = ctx.fiber.dispose()
      try {
        // Closing precedes reentrant release; the drain count distinguishes those teardown phases.
        await vi.waitFor(() => { expect(Reflect.get(service, 'activeInitiatorRuns')).toBe(1) })
        expect(service.requireInitiator()).toBe(initiator)
        expect(read()).toBe(initiator)
      } finally {
        release.resolve(true)
        await disposal
      }
    })
    await pending
    await promptly(returned)
  })

  it('excludes an asynchronous teardown initiator while draining unrelated boundaries', async () => {
    const { ctx, service } = await harness()
    const initiator = agent('async-disposer')
    const unrelated = agent('unrelated')
    const release = Promise.withResolvers<boolean>()
    const pending = service.withInitiator(unrelated, async () => {
      await release.promise
      expect(service.requireInitiator()).toBe(unrelated)
    })

    const returned = service.withInitiator(initiator, async () => {
      await Promise.resolve()
      await ctx.fiber.dispose()
    })
    let disposed = false
    void returned.then(() => { disposed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toBe(false)

    release.resolve(true)
    await pending
    await promptly(returned)

    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { CatalogManager } from '../src/catalog-manager.ts'
import { FileModelsStore } from '../src/models-store.ts'

let context: Context | undefined
let manager: CatalogManager | undefined
let home: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  manager = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function baseModel(provider = 'deepseek'): Model<Api> {
  const model = getBuiltinModels(provider as never)[0]
  if (model === undefined) throw new Error(`${provider} catalog fixture is empty`)
  return structuredClone(model)
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function response(model: Model<Api>, name: string): Response {
  return new Response(JSON.stringify({ [model.id]: { ...model, name } }), { status: 200 })
}

async function setup(
  fetcher: typeof fetch,
  intervalMs = 300_000,
  active: ReadonlySet<string> = new Set(),
): Promise<CatalogManager> {
  home = await mkdtemp(join(tmpdir(), 'dsh-pi-catalog-manager-'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubGlobal('fetch', fetcher)
  context = new Context()
  manager = new CatalogManager(context, { intervalMs, onPublication: () => {} })
  manager.configure(intervalMs, active)
  return manager
}

describe('CatalogManager lifecycle', () => {
  it('restores active routes from disk without making a startup network request', async () => {
    const model = baseModel()
    const cached = { ...model, name: 'Cached model' }
    home = await mkdtemp(join(tmpdir(), 'dsh-pi-catalog-cache-'))
    vi.stubEnv('DSH_HOME', home)
    await new FileModelsStore(home).write('deepseek', { models: [cached], checkedAt: 1 })
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('network must stay idle'))
    vi.stubGlobal('fetch', fetcher)
    context = new Context()
    manager = new CatalogManager(context, { intervalMs: 300_000, onPublication: () => {} })
    manager.configure(300_000, new Set(['deepseek']))

    await vi.waitFor(() => {
      expect(manager?.modelsFor('deepseek').find(entry => entry.id === model.id)?.name).toBe('Cached model')
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refreshes only active builtin routes on periodic ticks', async () => {
    const deepseek = baseModel()
    const anthropic = baseModel('anthropic')
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input)
      return Promise.resolve(url.endsWith('/deepseek')
        ? response(deepseek, 'DeepSeek remote')
        : response(anthropic, 'Anthropic remote'))
    })
    const catalog = await setup(fetcher, 20, new Set(['deepseek']))

    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1) }, { timeout: 1000 })
    expect(requestUrl(fetcher.mock.calls[0]?.[0] ?? '')).toContain('/deepseek')
    catalog.configure(20, new Set(['anthropic']))
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).endsWith('/deepseek'))).toHaveLength(1)
  })

  it('deduplicates provider refreshes while caller cancellation stays local', async () => {
    const model = baseModel()
    const started = Promise.withResolvers<undefined>()
    const result = Promise.withResolvers<Response>()
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      started.resolve(undefined)
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        void result.promise.then(resolve, reject)
      })
    })
    const catalog = await setup(fetcher)
    const caller = new AbortController()
    const first = catalog.refresh('deepseek', caller.signal, true)
    await started.promise
    const second = catalog.refresh('deepseek', undefined, true)
    caller.abort('caller stopped waiting')
    await expect(first).resolves.toMatchObject({ aborted: true })
    result.resolve(response(model, 'Shared remote'))
    await expect(second).resolves.toMatchObject({ aborted: false })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('upgrades an in-flight restore to a forced network refresh', async () => {
    const model = baseModel()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(model, 'Forced remote'))
    const catalog = await setup(fetcher)

    const restoring = catalog.restore('deepseek')
    const refreshing = catalog.refresh('deepseek', undefined, true)

    await expect(restoring).resolves.toMatchObject({ aborted: false })
    await expect(refreshing).resolves.toMatchObject({ aborted: false })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(catalog.modelsFor('deepseek').find(entry => entry.id === model.id)?.name).toBe('Forced remote')
  })

  it('aborts and awaits shared work during disposal', async () => {
    const started = Promise.withResolvers<undefined>()
    let aborted = false
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((_, reject) => {
      started.resolve(undefined)
      init?.signal?.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      }, { once: true })
    }))
    const catalog = await setup(fetcher)
    const pending = catalog.refresh('deepseek')
    await started.promise
    await context?.fiber.dispose()
    expect(aborted).toBe(true)
    await expect(pending).resolves.toMatchObject({ aborted: true })
    context = undefined
  })

  it('supersedes stale work when the interval and active routes change', async () => {
    const model = baseModel()
    const started = Promise.withResolvers<undefined>()
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((resolve, reject) => {
      started.resolve(undefined)
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      if (fetcher.mock.calls.length > 1) resolve(response(model, 'Remote'))
    }))
    const catalog = await setup(fetcher, 300_000)
    const first = catalog.refresh('deepseek')
    await started.promise
    catalog.configure(20, new Set())
    await expect(first).resolves.toMatchObject({ aborted: true })
    catalog.configure(20, new Set(['deepseek']))
    await vi.waitFor(() => { expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2) }, { timeout: 1000 })
  })
})

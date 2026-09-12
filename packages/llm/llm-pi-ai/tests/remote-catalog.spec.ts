import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModels } from '@earendil-works/pi-ai'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import { FileModelsStore } from '../src/models-store.ts'
import { createRemoteCatalogProvider } from '../src/remote-catalog.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

function baseModel(providerId = 'deepseek'): Model<Api> {
  const model = getBuiltinModels(providerId as BuiltinProvider)[0]
  if (model === undefined) throw new Error(`${providerId} catalog fixture is empty`)
  return structuredClone(model)
}

function responseCatalog(providerId = 'deepseek'): Record<string, unknown> {
  const model = baseModel(providerId)
  const existing = model as unknown as Record<string, unknown>
  const remote = {
    ...existing,
    name: providerId === 'deepseek' ? 'Remote DeepSeek' : `Remote ${providerId}`,
    headers: { 'x-model-source': 'remote' },
    samplingParams: { top_p: 0.9 },
    vendorMetadata: { revision: 7 },
  }
  const added = { ...existing, id: `${providerId}-remote-new`, api: 'remote-api', name: 'Remote New' }
  return { [model.id]: remote, [added.id]: added }
}

async function setup(options: {
  providerId?: string
  now: () => number
  ttlMs?: number
  fetch: typeof fetch
}): Promise<{ models: ReturnType<typeof createModels>; store: FileModelsStore; home: string }> {
  const providerId = options.providerId ?? 'deepseek'
  const home = await mkdtemp(join(tmpdir(), 'dsh-pi-remote-catalog-'))
  homes.push(home)
  const store = new FileModelsStore(home)
  const models = createModels({ modelsStore: store })
  models.setProvider(createRemoteCatalogProvider(providerId, {
    ttlMs: options.ttlMs ?? 1000,
    test: { fetch: options.fetch, baseUrl: 'https://catalog.test', now: options.now },
  }))
  return { models, store, home }
}

describe('remote builtin catalog provider', () => {
  it('runs keyless, overlays a 200 catalog, and persists every descriptor field', async () => {
    const now = 1000
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(responseCatalog()), {
      status: 200,
      headers: {
        etag: '"v1"',
        'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
      },
    }))
    const { models, store } = await setup({ fetch: fetcher, now: () => now })

    const result = await models.refresh()

    expect(result).toEqual({ aborted: false, errors: new Map() })
    expect(await models.checkAuth('deepseek')).toEqual({ source: 'public model catalog', type: 'api_key' })
    expect(models.getModel('deepseek', 'deepseek-remote-new')?.api).toBe('remote-api')
    expect(models.getModel('deepseek', baseModel().id)?.name).toBe('Remote DeepSeek')
    expect(await store.read('deepseek')).toMatchObject({
      checkedAt: now,
      etag: '"v1"',
      lastModified: Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'),
    })
    const persisted = await store.read('deepseek')
    const remote = persisted?.models.find(model => model.id === baseModel().id) as unknown as Record<string, unknown> | undefined
    expect(remote?.vendorMetadata).toEqual({ revision: 7 })
    expect(remote?.samplingParams).toEqual({ top_p: 0.9 })
  })

  it('uses another installed builtin provider and refuses foreign descriptors', async () => {
    const providerId = 'anthropic'
    const model = baseModel(providerId)
    let now = 1000
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(responseCatalog(providerId)), {
      status: 200,
    }))
    const { models } = await setup({ providerId, fetch: fetcher, now: () => now, ttlMs: 0 })

    await models.refresh()
    expect(fetcher).toHaveBeenCalledWith(
      'https://catalog.test/api/models/providers/anthropic',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(models.getModel(providerId, model.id)?.name).toBe('Remote anthropic')

    now = 2000
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({
      [model.id]: { ...model, provider: 'deepseek' },
    }), { status: 200 }))
    const result = await models.refresh()
    expect(result.errors.get(providerId)?.message).toMatch(/invalid Pi model descriptor/)
    expect(models.getModel(providerId, model.id)?.name).toBe('Remote anthropic')
  })

  it('restores before a fresh TTL skip, then refreshes stale data with 304 validators', async () => {
    let now = 1000
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(responseCatalog()), {
        status: 200,
        headers: { etag: '"v1"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
      }))
      .mockResolvedValueOnce(new Response(null, {
        status: 304,
        headers: { etag: '"v2"', 'last-modified': 'Wed, 21 Oct 2015 07:28:01 GMT' },
      }))
    const { models, store } = await setup({ fetch: fetcher, now: () => now })

    await models.refresh()
    now = 1500
    await models.refresh()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(models.getModel('deepseek', 'deepseek-remote-new')?.name).toBe('Remote New')

    now = 2501
    await models.refresh()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      'if-none-match': '"v1"',
      'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
    })
    expect((await store.read('deepseek'))?.checkedAt).toBe(2501)
    expect((await store.read('deepseek'))?.etag).toBe('"v2"')
  })

  it('rejects 304 when no cached response body exists', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 304 }))
    const { models } = await setup({ fetch: fetcher, now: () => 1000 })

    const result = await models.refresh()

    expect(result.errors.get('deepseek')?.message).toMatch(/without a cached body/)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('retains the last published overlay after HTTP and JSON failures', async () => {
    let now = 1000
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(responseCatalog()), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        [baseModel().id]: { ...baseModel(), provider: 'other-provider' },
      }), { status: 200 }))
    const { models } = await setup({ fetch: fetcher, now: () => now })

    await models.refresh()
    now = 2500
    expect((await models.refresh()).errors.has('deepseek')).toBe(true)
    expect(models.getModel('deepseek', 'deepseek-remote-new')?.name).toBe('Remote New')
    now = 4000
    expect((await models.refresh()).errors.has('deepseek')).toBe(true)
    expect(models.getModel('deepseek', 'deepseek-remote-new')?.name).toBe('Remote New')
  })

  it('forces a network refresh despite a fresh cached check', async () => {
    let now = 1000
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(responseCatalog()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ [baseModel().id]: { ...baseModel(), name: 'Forced Remote' } }), { status: 200 }))
    const { models } = await setup({ fetch: fetcher, now: () => now })

    await models.refresh()
    now = 1500
    await models.refresh({ force: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(models.getModel('deepseek', baseModel().id)?.name).toBe('Forced Remote')
  })

  it('aborts an in-flight request without replacing the prior overlay', async () => {
    const now = 1000
    const first = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(responseCatalog()), { status: 200 }))
    const { models } = await setup({ fetch: first, now: () => now })
    await models.refresh()

    const controller = new AbortController()
    const pending = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('operation aborted')) }, { once: true })
    }))
    const abortedModels = createModels({ modelsStore: new FileModelsStore(homes[0]) })
    abortedModels.setProvider(createRemoteCatalogProvider('deepseek', {
      ttlMs: 100000,
      test: { fetch: pending, baseUrl: 'https://catalog.test', now: () => now },
    }))
    await abortedModels.refresh()
    const refresh = abortedModels.refresh({ signal: controller.signal, force: true })
    await vi.waitFor(() => { expect(pending).toHaveBeenCalledOnce() })
    controller.abort('test cancellation')
    expect((await refresh).aborted).toBe(true)
    expect(abortedModels.getModel('deepseek', 'deepseek-remote-new')?.name).toBe('Remote New')
  })

  it('lets Pi generations supersede a slow refresh and reject stale publication', async () => {
    const now = 1000
    const started = Promise.withResolvers<undefined>()
    const lateResult = Promise.withResolvers<Response>()
    let supersededSignal: AbortSignal | undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (fetcher.mock.calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify(responseCatalog()), { status: 200 }))
      }
      if (fetcher.mock.calls.length === 2) {
        supersededSignal = init?.signal ?? undefined
        started.resolve(undefined)
        return lateResult.promise
      }
      return Promise.resolve(new Response(JSON.stringify({
        [baseModel().id]: { ...baseModel(), name: 'Second Refresh' },
      }), { status: 200, headers: { etag: '"second"' } }))
    })
    const { models, store } = await setup({ fetch: fetcher, now: () => now })

    await models.refresh()
    const first = models.refresh({ force: true })
    await started.promise
    const second = await models.refresh({ force: true })
    expect(second.errors).toEqual(new Map())
    expect(supersededSignal?.aborted).toBe(true)
    lateResult.resolve(new Response(null, { status: 304, headers: { etag: '"stale"' } }))
    expect((await first).errors).toEqual(new Map())
    expect(models.getModel('deepseek', baseModel().id)?.name).toBe('Second Refresh')
    expect((await store.read('deepseek'))?.models[0]?.name).toBe('Second Refresh')
    expect((await store.read('deepseek'))?.etag).toBe('"second"')
  })
})

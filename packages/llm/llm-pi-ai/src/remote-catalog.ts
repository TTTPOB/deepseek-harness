/** Remote overlay for an installed Pi builtin model catalog. */

import type {
  Api,
  Model,
  Provider,
  ProviderAuth,
  RefreshModelsContext,
} from '@earendil-works/pi-ai'
import { catalogModels, catalogProvider } from './catalog.ts'
import { MAX_RESPONSE_BYTES, readBoundedResponse, ResponseTooLargeError } from './bounded-response.ts'
import { parsePiModel, parsePiModelCatalog } from './model-validation.ts'

const MODELS_ENDPOINT = 'https://pi.dev'

/** Public catalog auth used only by the catalog-management collection, never by a request route. */
const PUBLIC_CATALOG_AUTH: ProviderAuth = {
  apiKey: {
    name: 'Public model catalog',
    resolve: () => Promise.resolve({ auth: {}, source: 'public model catalog' }),
  },
}

/** Test-only substitutions for the fixed catalog endpoint and wall clock. */
export interface RemoteCatalogTestOptions {
  /** Test fetch implementation. */
  fetch?: typeof fetch
  /** Test endpoint origin; production always uses pi.dev. */
  baseUrl?: string
  /** Test clock returning Unix milliseconds. */
  now?: () => number
}

/** Options for one remote catalog wrapper. */
export interface RemoteCatalogOptions {
  /** Caller-selected freshness interval in milliseconds. */
  ttlMs: number
  /** Internal test substitutions; omitted by production callers. */
  test?: RemoteCatalogTestOptions
  /** Called after Pi accepts a publication into this provider generation. */
  onPublish?: () => void
}

function assertClock(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('llm-pi-ai: remote catalog clock returned an invalid time')
  return now
}

function fresh(stored: RefreshModelsContext['stored'], now: number, ttlMs: number): boolean {
  return stored?.checkedAt !== undefined && stored.checkedAt + ttlMs > now
}

function headerValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)
  return value === null ? undefined : value
}

function lastModified(headers: Headers, previous: number | undefined, retainPrevious: boolean): number | undefined {
  const value = headerValue(headers, 'last-modified')
  if (value === undefined) return retainPrevious ? previous : undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('llm-pi-ai: remote catalog has an invalid Last-Modified header')
  return parsed
}

function endpoint(baseUrl: string, providerId: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/api/models/providers/${encodeURIComponent(providerId)}`
}

/**
 * Build the catalog-management provider used by an isolated Pi Models
 * collection. It preserves the selected builtin provider's static descriptors
 * and streams, while remote descriptors replace or extend them by model id.
 * This provider is not a request route; its public auth only lets
 * `Models.refresh()` inspect the public catalog without credentials.
 * @param providerId - installed Pi builtin provider id.
 * @param options - caller-selected TTL and internal test substitutions.
 * @returns a provider suitable for `createModels({ modelsStore })`.
 */
export function createRemoteCatalogProvider(providerId: string, options: RemoteCatalogOptions): Provider {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs < 0) {
    throw new Error('llm-pi-ai: remote catalog ttlMs must be a non-negative finite number')
  }
  const base = catalogProvider(providerId)
  if (base === undefined) throw new Error(`llm-pi-ai: installed catalog has no ${providerId} provider`)
  const baseline = catalogModels(providerId)
  let overlay: readonly Model<Api>[] = []
  const clock = options.test?.now ?? Date.now
  const fetcher = options.test?.fetch ?? globalThis.fetch
  const url = endpoint(options.test?.baseUrl ?? MODELS_ENDPOINT, providerId)

  const notifyPublished = (): void => {
    try {
      options.onPublish?.()
    } catch {
      // Publication has already committed; observer failures cannot undo it.
    }
  }

  const mergeModels = (): readonly Model<Api>[] => {
    const merged = [...baseline.values()]
    for (const model of overlay) {
      const index = merged.findIndex(candidate => candidate.id === model.id)
      if (index === -1) merged.push(model)
      else merged[index] = model
    }
    return merged
  }

  const refreshModels = async (context: RefreshModelsContext): Promise<void> => {
    context.signal.throwIfAborted()
    if (context.stored !== undefined) {
      const restored = context.stored.models.map(model => parsePiModel(model, providerId, model.id))
      if (!await context.publish({ update: () => { overlay = restored } })) return
      notifyPublished()
    }
    context.signal.throwIfAborted()
    if (!context.allowNetwork) return
    const now = assertClock(clock())
    if (!context.force && fresh(context.stored, now, options.ttlMs)) return
    const headers: Record<string, string> = { accept: 'application/json' }
    if (context.stored?.etag !== undefined) headers['if-none-match'] = context.stored.etag
    if (context.stored?.lastModified !== undefined) {
      headers['if-modified-since'] = new Date(context.stored.lastModified).toUTCString()
    }
    let response: Response
    try {
      context.signal.throwIfAborted()
      response = await fetcher(url, { method: 'GET', headers, signal: context.signal })
    } catch (error: unknown) {
      context.signal.throwIfAborted()
      throw new Error(`llm-pi-ai: could not reach remote model catalog ${url}`, { cause: error })
    }
    if (response.status === 304) {
      if (context.stored === undefined) throw new Error('llm-pi-ai: remote catalog returned 304 without a cached body')
      const checkedAt = assertClock(clock())
      const etag = headerValue(response.headers, 'etag') ?? context.stored.etag
      const modified = lastModified(response.headers, context.stored.lastModified, true)
      const persist = {
        models: context.stored.models,
        checkedAt,
        ...etag === undefined ? {} : { etag },
        ...modified === undefined ? {} : { lastModified: modified },
      }
      if (await context.publish({ persist, update: () => { overlay = [...context.stored?.models ?? []] } })) notifyPublished()
      return
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {
        // The HTTP status already decides this refresh; body cleanup cannot replace that diagnostic.
      })
      throw new Error(`llm-pi-ai: remote model catalog answered HTTP ${response.status}`)
    }
    let body: string
    try {
      body = await readBoundedResponse(response, MAX_RESPONSE_BYTES, context.signal)
    } catch (error: unknown) {
      context.signal.throwIfAborted()
      if (error instanceof ResponseTooLargeError) {
        throw new Error(`llm-pi-ai: remote model catalog answered with more than ${MAX_RESPONSE_BYTES} bytes`, { cause: error })
      }
      throw new Error(`llm-pi-ai: could not read remote model catalog ${url}`, { cause: error })
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(body)
    } catch (error: unknown) {
      throw new Error('llm-pi-ai: remote model catalog did not answer with JSON', { cause: error })
    }
    const models = parsePiModelCatalog(decoded, providerId)
    const checkedAt = assertClock(clock())
    const etag = headerValue(response.headers, 'etag')
    const modified = lastModified(response.headers, undefined, false)
    const persist = {
      models,
      checkedAt,
      ...etag === undefined ? {} : { etag },
      ...modified === undefined ? {} : { lastModified: modified },
    }
    if (await context.publish({ persist, update: () => { overlay = models } })) notifyPublished()
  }

  return {
    ...base,
    id: providerId,
    auth: PUBLIC_CATALOG_AUTH,
    getModels: mergeModels,
    refreshModels,
  }
}

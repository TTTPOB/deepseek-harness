/** Private lifecycle owner for live builtin Pi model catalogs. */

import type { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import type { Api, Model, ModelsRefreshResult, MutableModels } from '@earendil-works/pi-ai'
import { catalogProviderIds } from './catalog.ts'
import { FileModelsStore } from './models-store.ts'
import { createRemoteCatalogProvider } from './remote-catalog.ts'

interface SharedRefresh {
  controller: AbortController
  strength: RefreshStrength
  operation: Promise<ModelsRefreshResult>
}

const enum RefreshStrength {
  restore,
  normal,
  force,
}

interface CatalogManagerOptions {
  intervalMs: number
  onPublication: () => void
}

function abortedResult(): ModelsRefreshResult {
  return { aborted: true, errors: new Map() }
}

/**
 * Wait for a shared refresh without passing the caller's signal to Pi. A caller
 * can stop waiting while another caller continues to observe the same work.
 */
async function waitForCaller(
  operation: Promise<ModelsRefreshResult>,
  signal: AbortSignal | undefined,
): Promise<ModelsRefreshResult> {
  if (signal === undefined) return operation
  if (signal.aborted) return abortedResult()
  return new Promise<ModelsRefreshResult>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      finish(() => { resolve(abortedResult()) })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (result) => {
        finish(() => { resolve(result) })
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error('catalog refresh failed', { cause: error }))
        })
      },
    )
    if (signal.aborted) onAbort()
  })
}

/**
 * Owns one Pi catalog collection for all installed builtin providers. Request
 * providers never enter this collection: it is only the public catalog's
 * cache, refresh, and validated synchronous model view.
 */
export class CatalogManager {
  private readonly models: MutableModels
  private readonly lifecycle = new AbortController()
  private readonly operations = new Set<Promise<ModelsRefreshResult>>()
  private readonly shared = new Map<string, SharedRefresh>()
  private readonly providers = new Set(catalogProviderIds())
  private readonly onPublication: () => void
  private active = new Set<string>()
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private disposed = false

  /**
   * @param ctx - Fiber owning the manager's timer and teardown.
   * @param options - interval and publication invalidation callback.
   */
  constructor(private readonly ctx: Context, options: CatalogManagerOptions) {
    this.intervalMs = options.intervalMs
    this.onPublication = options.onPublication
    this.models = createModels({ modelsStore: new FileModelsStore() })
    this.replaceProviders()
    ctx.effect(() => async () => {
      this.disposed = true
      this.lifecycle.abort('llm-pi-ai catalog manager disposed')
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
      for (const entry of this.shared.values()) entry.controller.abort('catalog manager disposed')
      await Promise.allSettled([...this.operations])
      this.shared.clear()
    }, 'llm-pi-ai.catalogManager()')
    this.startTimer()
  }

  /**
   * Return the current validated model view for one installed provider.
   * @param provider - installed builtin provider id.
   * @returns the synchronous model view.
   */
  modelsFor(provider: string): readonly Model<Api>[] {
    return this.models.getModels(provider)
  }

  /**
   * Restore installed provider caches before configuration validation. The
   * settings service validates its persisted section synchronously during
   * registration, so remote-only model overrides must already be resolvable.
   * @returns completion after every cache read settles.
   */
  async restoreInstalled(): Promise<void> {
    const results = await Promise.all([...this.providers].map(provider => this.restore(provider)))
    for (const result of results) {
      for (const [provider, error] of result.errors) this.logBackgroundFailure(provider, error)
    }
  }

  /**
   * Apply the active-route set and catalog interval. Provider replacements
   * intentionally create a new remote generation, so stale fetches cannot
   * publish after settings changes.
   * @param intervalMs - new TTL and periodic refresh cadence.
   * @param active - configured builtin routes with inherited model lists.
   */
  configure(intervalMs: number, active: ReadonlySet<string>): void {
    if (this.disposed) return
    const intervalChanged = this.intervalMs !== intervalMs
    const added = [...active].filter(provider => !this.active.has(provider))
    const removed = [...this.active].filter(provider => !active.has(provider))
    this.active = new Set(active)

    if (intervalChanged) {
      this.intervalMs = intervalMs
      this.replaceProviders()
      this.abortShared()
      this.startTimer()
      for (const provider of this.active) this.restoreInBackground(provider)
      return
    }

    for (const provider of removed) {
      this.abortShared(provider)
      this.replaceProvider(provider)
    }
    for (const provider of added) this.restoreInBackground(provider)
  }

  /**
   * Restore one provider from disk without performing network I/O.
   * @param provider - installed builtin provider id.
   * @param signal - caller cancellation that does not cancel shared work.
   * @returns the refresh result.
   */
  restore(provider: string, signal?: AbortSignal): Promise<ModelsRefreshResult> {
    return this.runRefresh(provider, false, false, signal)
  }

  /**
   * Refresh one provider's remote catalog, deduplicated by provider id.
   * @param provider - installed builtin provider id.
   * @param signal - caller cancellation that does not cancel shared work.
   * @param force - bypass the provider freshness TTL.
   * @returns the refresh result.
   */
  refresh(provider: string, signal?: AbortSignal, force = false): Promise<ModelsRefreshResult> {
    return this.runRefresh(provider, true, force, signal)
  }

  private runRefresh(
    provider: string,
    allowNetwork: boolean,
    force: boolean,
    callerSignal?: AbortSignal,
  ): Promise<ModelsRefreshResult> {
    if (this.disposed || !this.providers.has(provider)) return Promise.resolve(abortedResult())
    const strength = allowNetwork
      ? (force ? RefreshStrength.force : RefreshStrength.normal)
      : RefreshStrength.restore
    const existing = this.shared.get(provider)
    if (existing !== undefined) {
      if (existing.strength >= strength) return waitForCaller(existing.operation, callerSignal)
      existing.strength = strength
      const previous = existing.operation
      const operation = previous.then(() => {
        if (existing.controller.signal.aborted) return abortedResult()
        return this.refreshModels(provider, strength, existing.controller)
      })
      existing.operation = operation
      this.track(provider, existing, operation)
      return waitForCaller(operation, callerSignal)
    }

    const controller = new AbortController()
    const operation = this.refreshModels(provider, strength, controller)
    const entry = { controller, strength, operation }
    this.shared.set(provider, entry)
    this.track(provider, entry, operation)
    return waitForCaller(operation, callerSignal)
  }

  private refreshModels(
    provider: string,
    strength: RefreshStrength,
    controller: AbortController,
  ): Promise<ModelsRefreshResult> {
    return this.models.refresh({
      providers: [provider],
      allowNetwork: strength >= RefreshStrength.normal,
      force: strength === RefreshStrength.force,
      signal: AbortSignal.any([this.lifecycle.signal, controller.signal]),
    })
  }

  private track(provider: string, entry: SharedRefresh, operation: Promise<ModelsRefreshResult>): void {
    this.operations.add(operation)
    void operation.then(
      () => { this.complete(provider, entry, operation) },
      () => { this.complete(provider, entry, operation) },
    )
  }

  private complete(provider: string, entry: SharedRefresh, operation: Promise<ModelsRefreshResult>): void {
    if (this.shared.get(provider) === entry && entry.operation === operation) this.shared.delete(provider)
    this.operations.delete(operation)
  }

  private abortShared(provider?: string): void {
    if (provider === undefined) {
      for (const id of [...this.shared.keys()]) this.abortShared(id)
      return
    }
    const entry = this.shared.get(provider)
    if (entry === undefined) return
    this.shared.delete(provider)
    entry.controller.abort('catalog configuration changed')
  }

  private replaceProviders(): void {
    for (const provider of this.providers) this.replaceProvider(provider)
  }

  private replaceProvider(provider: string): void {
    this.models.setProvider(createRemoteCatalogProvider(provider, {
      ttlMs: this.intervalMs,
      onPublish: () => {
        if (this.disposed) return
        try {
          this.onPublication()
        } catch (error) {
          this.ctx.logger.warn(`llm-pi-ai: catalog publication observer failed for provider "${provider}"`)
          this.ctx.logger.warn(error)
        }
      },
    }))
  }

  private restoreInBackground(provider: string): void {
    void this.restore(provider).then((result) => {
      for (const [id, error] of result.errors) this.logBackgroundFailure(id, error)
    }, (error: unknown) => { this.logBackgroundFailure(provider, error) })
  }

  private startTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (this.disposed) return
      void Promise.allSettled([...this.active].map(provider => this.refresh(provider))).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') this.logBackgroundFailure('active provider', result.reason)
          else for (const [provider, error] of result.value.errors) this.logBackgroundFailure(provider, error)
        }
      })
    }, this.intervalMs)
  }

  private logBackgroundFailure(provider: string, error: unknown): void {
    this.ctx.logger.warn(`llm-pi-ai: background catalog refresh failed for ${provider}`)
    this.ctx.logger.warn(error)
  }
}

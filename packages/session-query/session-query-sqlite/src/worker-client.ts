/** Correlate Host requests with the single index worker. */

import { Worker } from 'node:worker_threads'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { Command, Result, WorkerConfig, WorkerRequest, WorkerResponse } from './protocol.ts'

function workerEntry(): URL {
  if (!import.meta.url.endsWith('.ts')) return new URL('./search-worker.js', import.meta.url)
  const entry = new URL('./worker.ts', import.meta.url)
  // Vitest aliases and the Host's TS loader are not inherited by Node workers.
  const bootstrap = [
    `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}`,
    'register()',
    `await import(${JSON.stringify(entry.href)})`,
  ].join('\n')
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`)
}

/** Parent end of the worker protocol; disposal terminates outstanding work. */
export class SearchWorker {
  private readonly worker: Worker
  private nextId = 0
  private failure?: SessionQueryError
  private readonly pending = new Map<number, { resolve(result: Result[keyof Result]): void; reject(error: Error): void }>()

  /** @param config - validated options for the worker-owned index. */
  constructor(config: WorkerConfig) {
    this.worker = new Worker(workerEntry(), { workerData: config, execArgv: [] })
    this.worker.on('message', (message: WorkerResponse) => {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      this.pending.delete(message.id)
      if (this.pending.size === 0) this.worker.unref()
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new SessionQueryError(message.message, message.code))
    })
    this.worker.on('error', error => this.fail(`session search worker failed: ${error.message}`))
    this.worker.on('exit', code => this.fail(`session search worker exited (${code})`))
    this.worker.unref()
  }

  /**
   * @param command - detached worker instruction.
   * @returns the result paired with its command.
   */
  call<C extends Command>(command: C): Promise<Result[C['kind']]> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const id = ++this.nextId
    return new Promise<Result[C['kind']]>((resolve, reject) => {
      this.worker.ref()
      this.pending.set(id, { resolve: result => resolve(result as Result[C['kind']]), reject })
      try {
        this.worker.postMessage({ id, command } satisfies WorkerRequest)
      } catch (error: unknown) {
        this.pending.delete(id)
        if (this.pending.size === 0) this.worker.unref()
        reject(error)
      }
    })
  }

  /** Reject callers and wait for the thread to stop. */
  async close(): Promise<void> {
    this.fail('session-search SQLite index is closed')
    await this.worker.terminate()
  }

  private fail(message: string): void {
    this.failure ??= new SessionQueryError(message, 'SESSION_QUERY_INDEX_FAILED')
    for (const operation of this.pending.values()) operation.reject(this.failure)
    this.pending.clear()
  }
}

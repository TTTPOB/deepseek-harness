/** Owner-private, provider-scoped persistence for Pi remote model catalogs. */

import { createHash } from 'node:crypto'
import { readFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Api, Model, ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from '@earendil-works/pi-ai'
import { parsePiModel } from './model-validation.ts'

const FORMAT_VERSION = 1
const STORE_DIRECTORY = 'llm-pi-ai/models-v1'

/** A decoded versioned record written by {@link FileModelsStore}. */
interface StoredModelsRecord {
  formatVersion: 1
  providerId: string
  models: readonly Model<Api>[]
  lastModified?: number
  checkedAt?: number
  etag?: string
}

/**
 * Error raised when a durable model catalog cannot be trusted.
 * The file remains in place so operators can inspect or replace it.
 */
export class InvalidModelsStoreRecordError extends Error {
  /**
   * @param message - explanation of the invalid record.
   * @param options - original parse or validation failure.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InvalidModelsStoreRecordError'
  }
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function providerFilename(providerId: string): string {
  return `${createHash('sha256').update(providerId).digest('hex')}.json`
}

function validateTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidModelsStoreRecordError(`llm-pi-ai: model catalog has an invalid ${field}`)
  }
  return value as number
}

function validateEntry(providerId: string, entry: ModelsStoreEntry): StoredModelsRecord {
  if (providerId.length === 0) throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog provider id is empty')
  if (!Array.isArray(entry.models)) throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog models is not an array')
  const candidates: readonly Model<Api>[] = entry.models
  const models = candidates.map((model: Model<Api>) => parsePiModel(model, providerId, model.id))
  if (entry.etag !== undefined && typeof entry.etag !== 'string') {
    throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog has an invalid etag')
  }
  const lastModified = validateTimestamp(entry.lastModified, 'lastModified')
  const checkedAt = validateTimestamp(entry.checkedAt, 'checkedAt')
  return {
    formatVersion: FORMAT_VERSION,
    providerId,
    models,
    ...lastModified === undefined ? {} : { lastModified },
    ...checkedAt === undefined ? {} : { checkedAt },
    ...entry.etag === undefined ? {} : { etag: entry.etag },
  }
}

function parseRecord(text: string, providerId: string): ModelsStoreEntry {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog is not valid JSON', { cause: error })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog record is not an object')
  }
  const record = value as Record<string, unknown>
  if (record.formatVersion !== FORMAT_VERSION || record.providerId !== providerId || !Array.isArray(record.models)) {
    throw new InvalidModelsStoreRecordError(
      `llm-pi-ai: model catalog record is unsupported or belongs to another provider (expected "${providerId}")`,
    )
  }
  try {
    const entry = validateEntry(providerId, {
      models: record.models as readonly Model<Api>[],
      ...record.lastModified === undefined ? {} : { lastModified: record.lastModified as number },
      ...record.checkedAt === undefined ? {} : { checkedAt: record.checkedAt as number },
      ...record.etag === undefined ? {} : { etag: record.etag as string },
    })
    return {
      models: entry.models,
      ...entry.lastModified === undefined ? {} : { lastModified: entry.lastModified },
      ...entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt },
      ...entry.etag === undefined ? {} : { etag: entry.etag },
    }
  } catch (error: unknown) {
    if (error instanceof InvalidModelsStoreRecordError) throw error
    throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog record contains an invalid model', { cause: error })
  }
}

function throwIfAborted(options?: ModelsStoreOperationOptions): void {
  options?.signal?.throwIfAborted()
}

/**
 * File-backed Pi model store rooted below the resolved Harness home.
 * Reads do not acquire a lock; writes and deletes replace or remove one
 * provider file while holding the atomic-write sibling lock.
 */
export class FileModelsStore implements ModelsStore {
  /** Owner-private directory containing hashed provider records. */
  readonly root: string

  /**
   * @param dshHome - optional explicit home used by isolated tests.
   */
  constructor(dshHome?: string) {
    this.root = join(resolveDshHome(dshHome), STORE_DIRECTORY)
  }

  /**
   * Resolve a provider's bounded, non-traversable record path.
   * @param providerId - Pi provider identifier.
   * @returns the provider-scoped JSON path.
   */
  pathFor(providerId: string): string {
    if (providerId.length === 0) throw new InvalidModelsStoreRecordError('llm-pi-ai: model catalog provider id is empty')
    return join(this.root, providerFilename(providerId))
  }

  /**
   * Read one provider record without acquiring a writer lock.
   * @param providerId - Pi provider identifier.
   * @param options - optional cancellation signal.
   * @returns the validated record, or undefined when the file is absent.
   */
  async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
    const path = this.pathFor(providerId)
    throwIfAborted(options)
    try {
      const text = await readFile(path, 'utf8')
      throwIfAborted(options)
      return parseRecord(text, providerId)
    } catch (error: unknown) {
      if (absent(error)) return undefined
      throw error
    }
  }

  /**
   * Atomically persist one validated provider record.
   * @param providerId - Pi provider identifier.
   * @param entry - Pi model catalog and remote validators.
   * @param options - optional cancellation signal.
   */
  async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
    const path = this.pathFor(providerId)
    const record = validateEntry(providerId, entry)
    throwIfAborted(options)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    throwIfAborted(options)
    await withFileLock(path, async () => {
      throwIfAborted(options)
      await writeFileAtomic(path, `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    })
  }

  /**
   * Delete one provider record; missing records are normal absence.
   * @param providerId - Pi provider identifier.
   * @param options - optional cancellation signal.
   */
  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    const path = this.pathFor(providerId)
    throwIfAborted(options)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    throwIfAborted(options)
    await withFileLock(path, async () => {
      throwIfAborted(options)
      try {
        await unlink(path)
      } catch (error: unknown) {
        if (!absent(error)) throw error
      }
    })
  }
}

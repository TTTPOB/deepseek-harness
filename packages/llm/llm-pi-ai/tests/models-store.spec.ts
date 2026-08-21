import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { FileModelsStore, InvalidModelsStoreRecordError } from '../src/models-store.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

function fixture(): Model<Api> {
  const model = getBuiltinModels('deepseek')[0]
  if (model === undefined) throw new Error('DeepSeek catalog fixture is empty')
  return structuredClone(model)
}

async function store(): Promise<FileModelsStore> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pi-model-store-'))
  homes.push(home)
  return new FileModelsStore(home)
}

describe('FileModelsStore', () => {
  it('uses provider-scoped hashed records with owner-only permissions and atomic JSON', async () => {
    const models = await store()
    const model = { ...fixture(), provider: 'deepseek/../other' } as Model<Api>
    await models.write('deepseek/../other', { models: [model] })

    const path = models.pathFor('deepseek/../other')
    expect(path.startsWith(models.root)).toBe(true)
    expect(path).not.toContain('deepseek/../other')
    expect((await stat(models.root)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await models.read('deepseek/../other')).toEqual({ models: [model] })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      formatVersion: 1,
      providerId: 'deepseek/../other',
    })
  })

  it('treats absent reads and deletes as normal absence', async () => {
    const models = await store()
    await expect(models.read('deepseek')).resolves.toBeUndefined()
    await expect(models.delete('deepseek')).resolves.toBeUndefined()
  })

  it('rejects corrupt, unsupported, and mismatched durable records', async () => {
    const models = await store()
    const path = models.pathFor('deepseek')
    await mkdir(models.root, { recursive: true })
    await writeFile(path, '{not json')
    await expect(models.read('deepseek')).rejects.toBeInstanceOf(InvalidModelsStoreRecordError)

    await writeFile(path, JSON.stringify({ formatVersion: 1, providerId: 'other', models: [] }))
    await expect(models.read('deepseek')).rejects.toThrow(/belongs to another provider/)

    await writeFile(path, JSON.stringify({ formatVersion: 1, providerId: 'deepseek', models: [{ id: 'wrong' }] }))
    await expect(models.read('deepseek')).rejects.toThrow(/contains an invalid model/)
  })

  it('serializes concurrent writes without exposing partial records', async () => {
    const models = await store()
    const first = fixture()
    const second = { ...first, id: `${first.id}-second` }
    await Promise.all([
      models.write('deepseek', { models: [first], checkedAt: 1 }),
      models.write('deepseek', { models: [second], checkedAt: 2 }),
    ])
    const record = await models.read('deepseek')
    expect(record?.models).toHaveLength(1)
    expect([first.id, second.id]).toContain(record?.models[0]?.id)
  })

  it('checks abort before each operation', async () => {
    const models = await store()
    const controller = new AbortController()
    controller.abort()
    await expect(models.read('deepseek', { signal: controller.signal })).rejects.toThrow()
    await expect(models.write('deepseek', { models: [fixture()] }, { signal: controller.signal })).rejects.toThrow()
    await expect(models.delete('deepseek', { signal: controller.signal })).rejects.toThrow()
  })

  it('does not mutate after an aborted lock wait eventually acquires the lock', async () => {
    const models = await store()
    const initial = fixture()
    await models.write('deepseek', { models: [initial] })
    const path = models.pathFor('deepseek')
    const lockPath = `${path}.lock`
    await writeFile(lockPath, 'test holder\n', { mode: 0o600, flag: 'wx' })

    const controller = new AbortController()
    const replacement = { ...initial, id: `${initial.id}-not-written` }
    const pending = models.write('deepseek', { models: [replacement] }, { signal: controller.signal })
    await new Promise<undefined>(resolve => setTimeout(() => { resolve(undefined) }, 50))
    controller.abort()
    await rm(lockPath)

    await expect(pending).rejects.toThrow()
    expect(await models.read('deepseek')).toEqual({ models: [initial] })
  })
})

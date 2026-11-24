/** Own the derived index and read durable JSONL logs outside the Host thread. */

import { parentPort, workerData } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import {
  SessionQueryError, assertSessionHeadersCompatible, buildSessionEventSearchDocuments, readColdSessionLog,
} from '@deepseek-ai/dsh-session-query'
import type { Command, Result, WorkerConfig, WorkerRequest, WorkerResponse } from './protocol.ts'
import { openSearchDatabase, rebuildDocumentKeysBatch } from './schema.ts'
import { SearchStore } from './store.ts'

if (parentPort === null) throw new Error('session search worker requires a parent port')
const port = parentPort
const config = workerData as WorkerConfig
let epoch = 0
let store: SearchStore | undefined
let keysReady = false
let reader: { promise: Promise<SessionPersistence>; dispose(): Promise<void> } | undefined
let snapshots: readonly SessionPersistenceSnapshot[] = []
const opening = openSearchDatabase(config.path, config.journalMode, config.keysPath, config.synchronous)

function assertEpoch(expected: number): void {
  if (epoch !== expected) throw new SessionQueryError('session search source was replaced', 'SESSION_QUERY_PERSISTENCE_FAILED')
}

async function dispatch(command: Command): Promise<Result[keyof Result]> {
  const db = await opening
  if (command.kind === 'open') return undefined
  if (command.kind === 'keys') {
    keysReady ||= rebuildDocumentKeysBatch(db)
    return keysReady
  }
  if (command.kind === 'bind') {
    const prior = reader
    epoch = command.epoch
    snapshots = []
    store?.resetObservedRevisions()
    if (command.jsonl === undefined) reader = undefined
    else {
      const ctx = new Context()
      const options = command.jsonl
      const mounting = import('@deepseek-ai/dsh-session-persistence-jsonl').then(plugin => ({ fiber: ctx.plugin(plugin, options) }))
      const promise = mounting.then(async ({ fiber }) => {
        await fiber
        return ctx.sessionPersistence
      })
      reader = { promise, async dispose() { await (await mounting).fiber.dispose() } }
    }
    await prior?.dispose()
    await reader?.promise
    return undefined
  }
  assertEpoch(command.epoch)
  if (command.kind === 'list') {
    const source = await reader?.promise
    if (source === undefined) throw new Error('JSONL reader is not bound')
    const listed = await source.list()
    assertEpoch(command.epoch)
    snapshots = listed
    return snapshots.length
  }
  if (command.kind === 'snapshots') {
    const batch = snapshots.slice(command.from, command.from + command.limit)
    if (command.from + batch.length === snapshots.length) snapshots = []
    return batch
  }
  if (command.kind === 'stat') return (await reader?.promise)?.stat(command.id)
  if (!keysReady) throw new SessionQueryError('session search document keys are rebuilding; retry shortly', 'SESSION_QUERY_INDEX_WARMING')
  store ??= new SearchStore(db, config.snippetChars)
  switch (command.kind) {
    case 'stored': {
      const { snapshot } = command
      const id = snapshot.header.id
      if (store.hasRevision(id, snapshot.revision, command.reuseDisk)) return 'current'
      let log = command.log
      if (log === undefined) {
        const source = await reader?.promise
        if (source === undefined) return 'needs-log'
        try {
          log = await readColdSessionLog(source, id)
        } catch (error: unknown) {
          if ((await source.stat(id))?.revision !== snapshot.revision) return 'changed'
          throw new SessionQueryError(`cannot read session ${id} for search: ${message(error)}`, 'SESSION_QUERY_PERSISTENCE_FAILED')
        }
        if ((await source.stat(id))?.revision !== snapshot.revision) return 'changed'
      }
      assertEpoch(command.epoch)
      assertSessionHeadersCompatible(snapshot.header, log.header)
      const { header, inheritedEventCount, events } = log
      store.writeStored({ header, inheritedEventCount, documents: buildSessionEventSearchDocuments(id, events) }, snapshot.revision)
      return 'written'
    }
    case 'live': store.writeLive(command.id, command.entry, command.persisted); return undefined
    case 'indexed': return store.listIds(command.after, command.limit)
    case 'remove': store.removeStored(command.ids); return undefined
    case 'sessions': return store.searchSessions(command.request, command.persisted)
    case 'events': return store.searchEvents(command.request, command.persisted)
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

port.on('message', async ({ id, command }: WorkerRequest) => {
  let response: WorkerResponse
  try {
    response = { id, ok: true, result: await dispatch(command) }
  } catch (error: unknown) {
    const code = error instanceof SessionQueryError ? error.code
      : command.kind === 'list' || command.kind === 'stat' || command.kind === 'bind'
        ? 'SESSION_QUERY_PERSISTENCE_FAILED' : 'SESSION_QUERY_INDEX_FAILED'
    response = { id, ok: false, code, message: message(error) }
  }
  port.postMessage(response)
})

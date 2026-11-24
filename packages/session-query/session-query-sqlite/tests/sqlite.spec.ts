import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadOptions,
  SessionHandleReadResult,
  SessionPersistenceListOptions,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine, {
  SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES,
  SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID,
  SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION,
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-query-sqlite'
import {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SessionQueryError,
  SessionSearchCursor,
  type SessionQueryErrorCode,
} from '@deepseek-ai/dsh-session-query'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'test': { kind: 'test' } & ContextFormed
  }
}

import { generationLogPath } from '../../../session/session-persistence-jsonl/src/format.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

function header(id: string, createdAt = 1, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, ...extra }
}

function messageEvents(text: string, time = 1): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    data: createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }]
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

class TestHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)

  constructor(
    readonly id: SessionIdType,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
  ) {}

  async read(_offset = 0, _length?: number, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    TestPersistence.reads.set(this.id, (TestPersistence.reads.get(this.id) ?? 0) + 1)
    TestPersistence.readSignals.push(options?.signal)
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const entry = TestPersistence.entries.get(this.id)
    if (entry === undefined) throw new SessionPersistenceNotFoundError(this.id)
    await TestPersistence.readEffect?.(entry, options?.signal)
    TestPersistence.readEffect = undefined
    return { eventState: 'detached', events: structuredClone(entry.events) }
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    if (this.access === 'read') return Promise.reject(new SessionReadOnlyError(this.id, 'append'))
    const entry = TestPersistence.entries.get(this.id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(this.id))
    entry.events.push(...structuredClone(events))
    TestPersistence.revisions.set(this.id, ++TestPersistence.nextRevision)
    return Promise.resolve()
  }

  flush(): Promise<void> {
    if (this.access === 'read') return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

class TestPersistence extends SessionPersistence {
  static entries = new Map<SessionIdType, { meta: SessionHeader; events: SessionEvent[] }>()
  static revisions = new Map<SessionIdType, number>()
  static sizes = new Map<SessionIdType, number>()
  static nextRevision = 0
  static reads = new Map<SessionIdType, number>()
  static readSignals: Array<AbortSignal | undefined> = []
  static listSignals: Array<AbortSignal | undefined> = []
  static readEffect: ((
    entry: { meta: SessionHeader; events: SessionEvent[] },
    signal?: AbortSignal,
  ) => void | Promise<void>) | undefined
  static listGate: Promise<void> | undefined
  static listStarted: (() => void) | undefined
  static listEffect: ((signal?: AbortSignal) => void | Promise<void>) | undefined
  static listOverride: (() => SessionPersistenceSnapshot[]) | undefined
  static failure: unknown

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map()
    this.revisions = new Map()
    this.sizes = new Map()
    this.reads = new Map()
    this.readSignals = []
    this.listSignals = []
    this.readEffect = undefined
    for (const entry of entries) this.set(entry)
    this.listGate = undefined
    this.listStarted = undefined
    this.listEffect = undefined
    this.listOverride = undefined
    this.failure = undefined
  }

  static set(entry: { meta: SessionHeader; events: SessionEvent[] }): void {
    this.entries.set(entry.meta.id, structuredClone(entry))
    this.revisions.set(entry.meta.id, ++this.nextRevision)
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    TestPersistence.set({ meta: header, events: [] })
    return Promise.resolve(new TestHandle(header.id, structuredClone(header), 'write'))
  }

  // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
  async flush(): Promise<void> {}

  open(id: SessionIdType, access: SessionAccess): Promise<SessionHandle> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    return Promise.resolve(new TestHandle(id, structuredClone(entry.meta), access))
  }

  stat(id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(id)}`),
      ...TestPersistence.sizes.has(id) ? { sizeBytes: TestPersistence.sizes.get(id)! } : {},
    })
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    TestPersistence.listSignals.push(options?.signal)
    TestPersistence.listStarted?.()
    await TestPersistence.listGate
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const snapshots = TestPersistence.listOverride?.()
      ?? [...TestPersistence.entries.values()].map((entry) => {
        const sizeBytes = TestPersistence.sizes.get(entry.meta.id)
        return {
          header: structuredClone(entry.meta),
          revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(entry.meta.id)}`),
          ...sizeBytes === undefined ? {} : { sizeBytes },
        }
      })
    await TestPersistence.listEffect?.(options?.signal)
    return snapshots
  }
}

async function liveContext(config: ConstructorParameters<typeof SqliteSessionQueryEngine>[1] = { path: ':memory:' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SqliteSessionQueryEngine, config)
  return ctx
}

async function retryWarming<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + 15_000
  for (;;) {
    try { return await operation() } catch (error: unknown) {
      if (!(error instanceof SessionQueryError) || error.code !== 'SESSION_QUERY_INDEX_WARMING' || performance.now() >= deadline) throw error
      await delay(10)
    }
  }
}

function searchSessions(ctx: Context, ...args: Parameters<Context['sessionQuery']['searchSessions']>) {
  return retryWarming(() => ctx.sessionQuery.searchSessions(...args))
}

function searchEvents(ctx: Context, ...args: Parameters<Context['sessionQuery']['searchEvents']>) {
  return retryWarming(() => ctx.sessionQuery.searchEvents(...args))
}

function notifyStored(ctx: Context, meta: SessionHeader): void {
  const session = ctx.sessions.prepare(meta.id, { meta: { createdAt: meta.createdAt } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  detach()
}

describe('SQLite session search', () => {
  it('defaults and validates opening policy and persisted inspection concurrency through its Cordis config', async () => {
    const defaultCtx = await liveContext()
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.openAt).toBe('startup')
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.persistedReadConcurrency)
      .toBe(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY)

    const configuredValue = 2
    const configured = new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      openAt: 'first-search',
      persistedReadConcurrency: configuredValue,
    })
    expect(configured.openAt).toBe('first-search')
    expect(configured.persistedReadConcurrency).toBe(configuredValue)
    const configuredCtx = await liveContext(configured)
    expect((configuredCtx.sessionQuery as SqliteSessionQueryEngine).config.persistedReadConcurrency)
      .toBe(configuredValue)
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.maxIndexedSessionBytes)
      .toBe(SESSION_QUERY_SQLITE_DEFAULT_MAX_INDEXED_SESSION_BYTES)
    expect(new SqliteSessionQueryEngine.Config({ path: ':memory:', maxIndexedSessionBytes: 7 })
      .maxIndexedSessionBytes).toBe(7)
    for (const maxIndexedSessionBytes of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SqliteSessionQueryEngine.Config({
        path: ':memory:',
        maxIndexedSessionBytes,
      })).toThrow()
    }

    for (const persistedReadConcurrency of [0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SqliteSessionQueryEngine.Config({
        path: ':memory:',
        persistedReadConcurrency,
      })).toThrow()
    }
    expect(() => new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      openAt: 'later' as never,
    })).toThrow()
    for (const warmupWaitMs of [-1, 0.5, 2 ** 31]) {
      expect(() => new SqliteSessionQueryEngine.Config({ path: ':memory:', warmupWaitMs })).toThrow()
    }
  })

  it('mounts and disposes first-search mode without opening its database', async () => {
    const path = await temporaryPath('unopened.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, {
      path,
      openAt: 'first-search',
    })

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await search.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses search in never mode while inherited reads and traces keep working', async () => {
    const path = await temporaryPath('never-mode.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path, openAt: 'never' })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    expect(service.config.openAt).toBe('never')

    const parent = SessionId('never-parent')
    const child = SessionId('never-child')
    ctx.sessions.create(parent, { seed: messageEvents('never opened needle'), meta: { createdAt: 10 } })
    ctx.sessions.create(child, { meta: { parentSession: parent, createdAt: 20 } })

    await expect(service.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SEARCH_DISABLED'))
    await expect(service.searchEvents({ sessionId: parent, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SEARCH_DISABLED'))

    expect((await service.listSessions()).map(record => record.header.id).sort())
      .toEqual([child, parent])
    const lineage = await service.traceSession(parent)
    expect(lineage.complete).toBe(true)
    expect(lineage.descendants.map(node => node.session.header.id)).toEqual([child])

    // The disabled index never touches the filesystem, in mount, use, or disposal.
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await search.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })



  it('searches two-character Unicode61 tokens in live-only sessions', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 20 })
    const session = ctx.sessions.create(SessionId('live'), {
      seed: messageEvents('inherited context'),
      inheritedEventCount: SessionLogOffset(1),
      // agentPreset rides along: the index rebuilds the header a caller reads,
      // and a session listed under the wrong composition is a lie about what it
      // ran. The full-header comparison below is what pins every column.
      meta: { cwd: '/work', createdAt: 10, isSeeded: true, delegationDepth: 2, agentPreset: 'minimal' },
    })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'An AI helper' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )

    await expect(searchEvents(ctx, { sessionId: session.id, query: 'AI' }))
      .resolves.toMatchObject({
        session: session.header,
        items: [{ sessionId: session.id, seq: SessionSeq(2), snippet: 'An AI helper' }],
      })
    await expect(searchSessions(ctx, { query: 'AI' }))
      .resolves.toMatchObject({ items: [{ header: session.header, live: true, persisted: false }] })
  })

  it('excludes assistant reasoning while indexing visible answer text', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('reasoning'))
    session.append(
      'assistant/message',
      {
        stream: [],
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'private-chain-marker' },
            { type: 'text', text: 'visible-answer-marker' },
          ],
          source: { provider: 'mock', model: 'mock' },
        }),
      },
      { surfaceOp: 'append' },
    )

    await expect(searchSessions(ctx, { query: 'private-chain-marker' }))
      .resolves.toEqual({ items: [] })
    await expect(searchSessions(ctx, { query: 'visible-answer-marker' }))
      .resolves.toMatchObject({
        items: [{
          header: { id: session.id },
          bestMatch: { snippet: 'visible-answer-marker' },
        }],
      })
  })

  it('searches all surfaces by default and applies metadata before ranking', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 20 })
    const parent = SessionId('parent')
    const events: SessionEvent[] = [
      { type: 'user/message', seq: SessionSeq(0), time: 10, data: createUserMessage({
        content: [{ type: 'text', text: 'needle original' }], source: { kind: 'user' },
      }), surfaceOp: 'append' },
      {
        type: 'assistant/attempt',
        seq: SessionSeq(1),
        time: 11,
        data: {
          turn: 1,
          step: 1,
          stream: [{ type: 'text-chunks', time0: 11, index: 0, dt: [], texts: ['needle raw'] }],
        },
      },
      { type: 'user/message', seq: SessionSeq(2), time: 12, data: createUserMessage({
        content: [{ type: 'text', text: 'needle summary' }], source: { kind: 'test' },
      }), surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] },
      { type: 'turn/end', seq: SessionSeq(3), time: 13, data: { turn: 1, reason: { kind: 'error', error: { message: 'needle failure', code: 'UNKNOWN' } } } },
    ]
    ctx.sessions.create(SessionId('a'), { seed: events, meta: { cwd: '/a', parentSession: parent, createdAt: 20 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('needle peer', 12), meta: { createdAt: 20 } })

    const all = await searchEvents(ctx, { sessionId: SessionId('a'), query: 'needle' })
    expect(new Set(all.items.map(item => item.surface))).toEqual(new Set(['current', 'shadowed', 'log-only']))
    await expect(searchEvents(ctx, {
      sessionId: SessionId('a'),
      query: 'needle',
      filters: [
        { kind: 'seq', from: 2, to: 2 },
        { kind: 'time', from: 12, to: 12 },
        { kind: 'type', values: ['user/message'] },
        { kind: 'surface', values: ['current'] },
      ],
    })).resolves.toMatchObject({ items: [{ seq: SessionSeq(2), surface: 'current' }] })

    const grouped = await searchSessions(ctx, {
      query: 'needle',
      sessionFilters: [
        { kind: 'id', values: [SessionId('a')] },
        { kind: 'cwd', values: ['/a'] },
        { kind: 'created-at', from: 20, to: 20 },
        { kind: 'parent', values: [parent] },
        { kind: 'availability', values: ['live'] },
      ],
      eventFilters: [{ kind: 'surface', values: ['shadowed'] }],
    })
    expect(grouped.items).toHaveLength(1)
    expect(grouped.items[0]).toMatchObject({
      header: { id: SessionId('a'), cwd: '/a', parentSession: parent },
      live: true,
      persisted: false,
      bestMatch: { seq: SessionSeq(0), surface: 'shadowed' },
    })
  })

  it('searches at the supported FTS5 outer-predicate boundary in both scopes', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('predicate-boundary'), {
      seed: messageEvents('needle'),
      meta: { cwd: '/work' },
    })
    const sessionFilters = Array.from(
      { length: 14 },
      () => ({ kind: 'cwd' as const, values: ['/work', null] }),
    )
    const eventFilters = Array.from(
      { length: 13 },
      () => ({ kind: 'type' as const, values: ['user/message' as const] }),
    )

    await expect(searchSessions(ctx, { query: 'needle', sessionFilters }))
      .resolves.toMatchObject({ items: [{ header: { id: session.id } }] })
    await expect(searchEvents(ctx, {
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters,
    })).resolves.toMatchObject({ items: [{ sessionId: session.id, seq: SessionSeq(0) }] })
  })

  it('rejects unsupported FTS5 outer-predicate counts with typed errors', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('predicate-limit'), { seed: messageEvents('needle') })
    const sessionFilters = Array.from(
      { length: 1_100 },
      () => ({ kind: 'id' as const, values: [session.id] }),
    )
    const eventFilters = Array.from(
      { length: 1_100 },
      () => ({ kind: 'type' as const, values: ['user/message' as const] }),
    )

    await expect(searchSessions(ctx, { query: 'needle', sessionFilters }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchEvents(ctx, {
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchSessions(ctx, {
      query: 'needle',
      sessionFilters: sessionFilters.slice(0, 7),
      eventFilters: eventFilters.slice(0, 8),
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchEvents(ctx, {
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters.slice(0, 14),
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('uses literal phrase tokens, stable ties, and bounded Unicode snippets', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 10, snippetChars: 5 })
    ctx.sessions.create(SessionId('a'), { seed: messageEvents('😀😀 alpha beta BRAID 😀😀', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('c'), { seed: messageEvents('alpha middle beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('d'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('operator'), { seed: messageEvents('needle OR absent', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('only'), { seed: messageEvents('needle only', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('quote'), { seed: messageEvents('say "needle" exactly', 10), meta: { createdAt: 1 } })

    const phrase = await searchSessions(ctx, { query: 'alpha beta' })
    expect(phrase.items.map(item => item.header.id)).toEqual([SessionId('b'), SessionId('d'), SessionId('a')])
    expect(phrase.items.every(item => Array.from(item.bestMatch.snippet).length <= 5)).toBe(true)
    await expect(searchSessions(ctx, { query: 'AI' })).resolves.toEqual({ items: [] })
    await expect(searchSessions(ctx, { query: 'needle OR absent' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('operator') } }] })
    await expect(searchSessions(ctx, { query: 'say "needle"' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('quote') } }] })
    await expect(searchSessions(ctx, { query: '*' })).resolves.toEqual({ items: [] })
  })

  it('counts overlapping phrase occurrences for BM25 while preserving sanitized snippets', async () => {
    const persisted = header('disjoint')
    TestPersistence.reset([{ meta: persisted, events: messageEvents('alpha alpha gap alpha alpha', 10) }])
    const ctx = await liveContext({ path: ':memory:', snippetChars: 100 })
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('overlap'), {
      seed: messageEvents('alpha alpha alpha', 10),
    })
    ctx.sessions.create(SessionId('markers'), {
      seed: messageEvents('alpha alpha ﷐﷑', 10),
    })
    const page = await searchSessions(ctx, { query: 'alpha alpha' })
    expect(page.items.map(item => [item.header.id, item.bestMatch.snippet])).toEqual([
      [SessionId('overlap'), 'alpha alpha alpha'],
      [persisted.id, 'alpha alpha gap alpha alpha'],
      [SessionId('markers'), 'alpha alpha ��'],
    ])
    const events = await searchEvents(ctx, { sessionId: SessionId('overlap'), query: 'alpha alpha' })
    expect(events.items[0]?.snippet).toBe('alpha alpha alpha')
  })

  it('ranks live and persisted matches on one source-comparable contract', async () => {
    const persisted = header('z-persisted')
    TestPersistence.reset([
      { meta: persisted, events: messageEvents('needle needle', 10) },
      ...Array.from({ length: 12 }, (_, index) => ({
        meta: header(`filler-${index}`),
        events: messageEvents('needle', 10),
      })),
    ])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('a-live'), {
      seed: messageEvents('needle needle', 10),
      meta: { createdAt: persisted.createdAt },
    })

    const result = await searchSessions(ctx, {
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: [SessionId('a-live'), persisted.id] }],
    })
    expect(result.items.map(item => item.header.id)).toEqual([SessionId('a-live'), persisted.id])
    await persistence.dispose()
  })

  it('positions snippets from FTS5 matches across diacritics and punctuation', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 14 })
    const session = ctx.sessions.create(SessionId('snippet'), {
      seed: messageEvents('long long long—café,\nnext value', 10),
    })

    const page = await searchEvents(ctx, { sessionId: session.id, query: 'CAFE' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.snippet).toContain('café')
    expect(page.items[0]!.snippet).toContain('—')
    expect(page.items[0]!.snippet).not.toContain('\n')
    expect(Array.from(page.items[0]!.snippet).length).toBeLessThanOrEqual(14)
  })

  it('continues both searches after live corpus changes and uses the newly ranked offset', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('target'), {
      seed: [
        ...messageEvents('needle one', 10),
        { ...messageEvents('needle two', 11)[0]!, seq: SessionSeq(1) },
        { ...messageEvents('needle three', 12)[0]!, seq: SessionSeq(2) },
      ],
    })
    const other = ctx.sessions.create(SessionId('other'), { seed: messageEvents('needle other', 10) })
    const sessions = { query: 'needle', limit: 1 }
    const events = { sessionId: target.id, ...sessions }
    const sessionPage = await searchSessions(ctx, sessions)
    const eventPage = await searchEvents(ctx, events)
    expect(sessionPage.items.map(item => item.header.id)).toEqual([target.id])
    expect(eventPage.items.map(item => item.seq)).toEqual([2])
    expect(sessionPage.nextCursor).toBeDefined()
    expect(eventPage.nextCursor).toBeDefined()

    other.append('turn/start', { turn: 1 })
    await expect(searchSessions(ctx, { ...sessions, cursor: sessionPage.nextCursor! }))
      .resolves.toMatchObject({ items: [{ header: { id: other.id } }] })

    const newest = ctx.sessions.create(SessionId('new-match'), { seed: messageEvents('needle newest', 20) })
    expect((await searchSessions(ctx, sessions)).items.map(item => item.header.id)).toEqual([newest.id])
    await expect(searchSessions(ctx, { ...sessions, cursor: sessionPage.nextCursor! }))
      .resolves.toMatchObject({ items: [{ header: { id: target.id } }] })
    await expect(searchEvents(ctx, { ...events, cursor: eventPage.nextCursor! }))
      .resolves.toMatchObject({ items: [{ seq: 1 }] })

    const appended = target.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'needle four' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect((await searchEvents(ctx, events)).items[0]?.seq).toBe(appended.seq)
    await expect(searchEvents(ctx, { ...events, cursor: eventPage.nextCursor! }))
      .resolves.toMatchObject({ items: [{ seq: 2 }] })
  })

  it('binds compact cursors to the normalized request, not the query length', async () => {
    const ctx = await liveContext()
    const longPhrase = 'long '.repeat(100).trim()
    const seed = [
      ...messageEvents('short ' + longPhrase, 10),
      { ...messageEvents('short ' + longPhrase, 12)[0]!, seq: SessionSeq(1) },
    ]
    const target = ctx.sessions.create(SessionId('target'), { seed })
    const other = ctx.sessions.create(SessionId('other'), { seed })
    const short = { query: 'short', limit: 1 }
    const long = { ...short, query: longPhrase }
    const sessionPage = await searchSessions(ctx, short)
    const longSessionPage = await searchSessions(ctx, long)
    const eventPage = await searchEvents(ctx, { ...short, sessionId: target.id })
    const longEventPage = await searchEvents(ctx, { ...long, sessionId: target.id })
    const sessionCursor = sessionPage.nextCursor!
    const eventCursor = eventPage.nextCursor!
    expect(sessionCursor.length).toBeLessThan(40)
    expect(longSessionPage.nextCursor).toHaveLength(sessionCursor.length)
    expect(longEventPage.nextCursor).toHaveLength(eventCursor.length)
    await expect(searchSessions(ctx, { ...short, query: '  short  ', cursor: sessionCursor }))
      .resolves.toMatchObject({ items: [{ header: { id: target.id } }] })

    const v1 = SessionSearchCursor(Buffer.from(JSON.stringify({ version: 1 })).toString('base64url'))
    const unsafeOffset = SessionSearchCursor(eventCursor.replace(/\.[^.]+$/u, '.9007199254740992'))
    for (const request of [
      { ...long, cursor: sessionCursor },
      { ...short, cursor: sessionCursor, limit: 2 },
      { ...short, cursor: sessionCursor, sessionFilters: [{ kind: 'exclude-ids', values: [other.id] }] } as const,
      { ...short, cursor: v1 },
    ]) {
      await expect(searchSessions(ctx, request)).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    }
    for (const request of [
      { ...short, sessionId: other.id, cursor: eventCursor },
      { ...short, sessionId: target.id, cursor: sessionCursor },
      { ...short, sessionId: target.id, cursor: unsafeOffset },
      { ...short, sessionId: target.id, cursor: eventCursor, filters: [{ kind: 'time', from: 12 }] } as const,
    ]) {
      await expect(searchEvents(ctx, request)).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    }
  })

  it('continues session paging after a persistence source is mounted and removed', async () => {
    TestPersistence.reset()
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    ctx.sessions.create(SessionId('first'), { seed: messageEvents('needle first', 2) })
    const second = ctx.sessions.create(SessionId('second'), { seed: messageEvents('needle second') })
    const page = await searchSessions(ctx, { query: 'needle', limit: 1 })
    expect(page.nextCursor).toBeDefined()

    const persistence = await ctx.plugin(TestPersistence)
    await persistence.dispose()

    await expect(searchSessions(ctx, { query: 'needle', limit: 1, cursor: page.nextCursor! }))
      .resolves.toMatchObject({ items: [{ header: { id: second.id } }] })
  })

  it('excludes matching ids before ranking and paging across live and stored results', async () => {
    const stored = header('excluded-stored')
    TestPersistence.reset([{ meta: stored, events: messageEvents('needle needle needle', 20) }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const live = ctx.sessions.create(SessionId('excluded-live'), { seed: messageEvents('needle needle', 20) })
    const first = ctx.sessions.create(SessionId('first'), { seed: messageEvents('needle remaining', 12) })
    const second = ctx.sessions.create(SessionId('second'), { seed: messageEvents('needle remaining', 11) })
    const excluded = { kind: 'exclude-ids', values: [stored.id, live.id] } as const
    const unfiltered = await searchSessions(ctx, { query: 'needle', limit: 1, sessionFilters: [{ kind: 'exclude-ids', values: [] }] })
    expect(unfiltered.items[0]?.header.id).toBe(stored.id)

    const request = { query: 'needle', limit: 1, sessionFilters: [excluded] }
    const page = await searchSessions(ctx, request)
    expect(page.items.map(item => item.header.id)).toEqual([first.id])
    expect(page.nextCursor).toBeDefined()
    await expect(searchSessions(ctx, { ...request, cursor: page.nextCursor! }))
      .resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ header: second.header })] }))
    const filtered = await ctx.sessionQuery.filterSessions([excluded])
    expect(new Set(filtered.map(item => item.header.id))).toEqual(new Set([first.id, second.id]))
  })

  it('rejects invalid requests, filters, cursors, and direct config', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 2, maxLimit: 3 })
    const session = ctx.sessions.create(SessionId('valid'), { seed: messageEvents('needle') })
    for (const request of [
      { sessionId: session.id, query: '' },
      { sessionId: session.id, query: 'needle', limit: 0 },
      { sessionId: session.id, query: 'needle', limit: 4 },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'seq', from: 2, to: 1 }] },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'surface', values: ['future'] }] },
      { sessionId: session.id, query: 'bad\0query' },
    ] as const) {
      await expect(searchEvents(ctx, request as never)).rejects.toBeInstanceOf(Error)
    }
    await expect(searchSessions(ctx, {
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: ['remote' as never] }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchSessions(ctx, {
      query: 'needle',
      sessionFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchSessions(ctx, {
      query: 'needle',
      eventFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchEvents(ctx, {
      sessionId: session.id,
      query: 'needle',
      filters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchEvents(ctx, {
      sessionId: session.id,
      query: 'needle',
      cursor: SessionSearchCursor('not-json'),
    }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(searchEvents(ctx, { sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    for (const config of [
      { path: '' },
      { path: ':memory:', defaultLimit: 0 },
      { path: ':memory:', maxLimit: 0 },
      { path: ':memory:', defaultLimit: 1e100 },
      { path: ':memory:', maxLimit: 1e100 },
      { path: ':memory:', snippetChars: 0 },
      { path: ':memory:', readWindowMax: -1 },
      { path: ':memory:', persistedReadConcurrency: 0 },
      { path: ':memory:', persistedReadConcurrency: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', preparedSessionCacheSize: 0 },
      { path: ':memory:', preparedSessionCacheSize: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', maxIndexedSessionBytes: 0 },
      { path: ':memory:', maxIndexedSessionBytes: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', defaultLimit: 3, maxLimit: 2 },
      { path: ':memory:', openAt: 'later' },
      { path: ':memory:', journalMode: 'memory' },
    ]) {
      const direct = new Context()
      await direct.plugin(SessionStore)
      expect(() => new SqliteSessionQueryEngine(direct, config as never))
        .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
      expect(direct.sessionQuery).toBeUndefined()
    }
  })

  it('rejects aggregate filter bindings above SQLite\'s portable variable limit', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('binding-limit'), { seed: messageEvents('needle') })
    // Each clause is below the ceiling; combined with its sibling and fixed
    // query bindings, the complete statement is not portable.
    const halfPortableLimit = 16_383
    const ids = Array.from(
      { length: halfPortableLimit },
      (_, index) => SessionId(`binding-${index}`),
    )
    const types = Array.from({ length: halfPortableLimit }, () => 'user/message' as const)
    const surfaces = Array.from({ length: halfPortableLimit }, () => 'current' as const)

    await expect(searchSessions(ctx, {
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
      eventFilters: [{ kind: 'type', values: types }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(searchEvents(ctx, {
      sessionId: session.id,
      query: 'needle',
      filters: [
        { kind: 'type', values: types },
        { kind: 'surface', values: surfaces },
      ],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('rejects one 125,000-value filter list with a typed error', async () => {
    const ctx = await liveContext()
    const ids = Array.from(
      { length: 125_000 },
      (_, index) => SessionId(`oversized-binding-${index}`),
    )

    await expect(searchSessions(ctx, {
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })
})

describe('service-owned worker warmup', () => {
  it('starts listing history on activation without a search request', async () => {
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.reset()
    TestPersistence.listStarted = () => { listed.resolve(undefined) }
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TestPersistence)
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    try {
      await Promise.race([listed.promise, delay(2000).then(() => { throw new Error('startup did not start warmup') })])
    } finally {
      await query.dispose()
    }
  })

  it('allows immediate warming responses without blocking point search', { timeout: 20_000 }, async () => {
    const target = header('point-target')
    TestPersistence.reset([{ meta: target, events: messageEvents('target needle') }])
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => listed.resolve(undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(TestPersistence)
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search', warmupWaitMs: 0 })
    const req = { query: 'target needle' }
    const controller = new AbortController()
    try {
      await expect(ctx.sessionQuery.searchSessions(req)).rejects.toMatchObject({ code: 'SESSION_QUERY_INDEX_WARMING' })
      await listed.promise
      const canceled = ctx.sessionQuery.searchEvents({ ...req, sessionId: target.id }, { signal: controller.signal })
      const point = ctx.sessionQuery.searchEvents({ ...req, sessionId: target.id })
      controller.abort()
      await expect(canceled).rejects.toMatchObject({ code: 'SESSION_QUERY_ABORTED' })
      await expect(point).resolves.toMatchObject({ session: { id: target.id }, items: [{ sessionId: target.id }] })
      await expect(ctx.sessionQuery.searchSessions(req)).rejects.toMatchObject({ code: 'SESSION_QUERY_INDEX_WARMING' })
      expect(TestPersistence.listSignals).toHaveLength(1)
      expect(TestPersistence.listSignals[0]?.aborted).toBe(false)
      gate.resolve(undefined)
      await expect(searchSessions(ctx, req)).resolves.toMatchObject({ items: [{ header: { id: target.id } }] })
      expect(TestPersistence.listSignals).toHaveLength(1)
      expect(TestPersistence.reads.get(target.id)).toBe(1)
    } finally {
      gate.resolve(undefined)
      await query.dispose()
      await persistence.dispose()
    }
  })

  it('waits for shared warmup on first search without letting one caller cancel the scan', async () => {
    const target = header('waited-target')
    TestPersistence.reset([{ meta: target, events: messageEvents('target needle') }])
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => listed.resolve(undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(TestPersistence)
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })
    const controller = new AbortController()
    const req = { query: 'target needle' }
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const result = ctx.sessionQuery.searchSessions(req).then(page => ({ page }), error => ({ error }))
      await listed.promise
      const settled = vi.fn()
      const canceled = ctx.sessionQuery.searchSessions(req, { signal: controller.signal }).then(settled, settled)
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toHaveBeenCalledWith(expectCode('SESSION_QUERY_ABORTED'))
      await canceled
      expect(TestPersistence.listSignals).toHaveLength(1)
      expect(TestPersistence.listSignals[0]?.aborted).toBe(false)
      gate.resolve(undefined)
      await expect(result).resolves.toMatchObject({ page: { items: [{ header: target }] } })
      expect(TestPersistence.listSignals).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      gate.resolve(undefined)
      await query.dispose()
      await persistence.dispose()
    }
  })

  it('returns warming when the wait budget expires while the same scan keeps working', async () => {
    const target = header('timed-out-target')
    TestPersistence.reset([{ meta: target, events: messageEvents('target needle') }])
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => listed.resolve(undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(TestPersistence)
    const waitMs = 40
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', warmupWaitMs: waitMs })
    const req = { query: 'target needle' }
    try {
      await listed.promise
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const settled = vi.fn()
      const result = ctx.sessionQuery.searchSessions(req).then(settled, settled)
      await vi.advanceTimersByTimeAsync(waitMs - 1)
      expect(settled).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await result
      expect(settled).toHaveBeenCalledWith(expectCode('SESSION_QUERY_INDEX_WARMING'))
      expect(TestPersistence.listSignals).toHaveLength(1)
      expect(TestPersistence.listSignals[0]?.aborted).toBe(false)
      vi.useRealTimers()
      gate.resolve(undefined)
      await expect(searchSessions(ctx, req)).resolves.toMatchObject({ items: [{ header: target }] })
      expect(TestPersistence.listSignals).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      gate.resolve(undefined)
      await query.dispose()
      await persistence.dispose()
    }
  })

  it('propagates the original warmup failure to all active callers', async () => {
    const target = header('failed-warmup-target')
    TestPersistence.reset([{ meta: target, events: messageEvents('target needle') }])
    const gate = Promise.withResolvers<undefined>()
    const listed = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    TestPersistence.listStarted = () => listed.resolve(undefined)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(TestPersistence)
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    const req = { query: 'target needle' }
    try {
      await listed.promise
      const failure = new SessionQueryError('persistence list failure', 'SESSION_QUERY_PERSISTENCE_FAILED')
      const waiting = [ctx.sessionQuery.searchSessions(req), ctx.sessionQuery.searchSessions(req)]
      TestPersistence.failure = failure
      gate.resolve(undefined)
      await expect(Promise.allSettled(waiting)).resolves.toEqual([
        { status: 'rejected', reason: failure },
        { status: 'rejected', reason: failure },
      ])
      TestPersistence.failure = undefined
      await expect(ctx.sessionQuery.searchSessions(req)).resolves.toMatchObject({ items: [{ header: target }] })
    } finally {
      gate.resolve(undefined)
      await query.dispose()
      await persistence.dispose()
    }
  })

  it('reopens after mid-scan disposal and reads only revisions that were not committed', { timeout: 20_000 }, async () => {
    const path = await temporaryPath()
    const first = header('warm-first')
    const second = header('warm-second')
    TestPersistence.reset([first, second].map(meta => ({ meta, events: messageEvents('resume needle') })))
    const reached = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    TestPersistence.readEffect = async (entry) => {
      if (entry.meta.id !== second.id) {
        // The fixture's read hook is one-shot; observe the durable checkpoint below instead.
        return
      }
      reached.resolve(undefined)
      await gate.promise
    }
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TestPersistence)
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path, openAt: 'first-search' })
    try {
      // Trigger a point commit first, then interrupt the bulk scan while its only missing revision is blocked.
      TestPersistence.listGate = reached.promise
      TestPersistence.readEffect = undefined
      await expect(searchEvents(ctx, { query: 'resume needle', sessionId: first.id })).resolves.toMatchObject({ session: { id: first.id } })
      TestPersistence.readEffect = async (entry) => {
        if (entry.meta.id === second.id) await gate.promise
      }
      reached.resolve(undefined)
      await vi.waitFor(() => expect(TestPersistence.reads.get(second.id)).toBe(1))
      await query.dispose()
      gate.resolve(undefined)
      await vi.waitFor(() => expect(TestPersistence.readEffect).toBeUndefined())
      const reopened = await ctx.plugin(SqliteSessionQueryEngine, { path })
      try {
        await expect(searchSessions(ctx, { query: 'resume needle' })).resolves.toMatchObject({ items: [{}, {}] })
        expect(TestPersistence.reads.get(first.id)).toBe(1)
        expect(TestPersistence.reads.get(second.id)).toBe(2)
      } finally { await reopened.dispose() }
    } finally {
      reached.resolve(undefined)
      gate.resolve(undefined)
      await query.dispose()
    }
  })

  it('keeps the Host event loop responsive through a real compressed JSONL backlog', { timeout: 45_000 }, async () => {
    const path = await temporaryPath()
    const root = await temporaryPath('logs')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const count = 80
    for (let session = 0; session < count; session++) {
      const writer = await ctx.sessionPersistence.create(header('backlog-' + session))
      const repeated = 'responsiveness needle with indexable terms '.repeat(36)
      const event = messageEvents(repeated)[0]!
      await writer.append(Array.from({ length: 160 }, (_, seq) => ({ ...event, seq: SessionSeq(seq) })))
      await writer.close()
    }
    const hostReads = vi.spyOn(ctx.sessionPersistence, 'open')
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path, openAt: 'first-search', synchronous: 'normal' })
    const lag = monitorEventLoopDelay({ resolution: 10 })
    lag.enable()
    try {
      await delay(20)
      const result = await searchSessions(ctx, { query: 'responsiveness needle', limit: count })
      expect(result.items).toHaveLength(count)
      const maxMs = lag.max / 1e6
      console.info('JSONL cold warmup max Host event-loop delay:', maxMs.toFixed(1), 'ms')
      expect(maxMs).toBeLessThan(200)
      expect(hostReads).not.toHaveBeenCalled()
    } finally {
      lag.disable()
      hostReads.mockRestore()
      await query.dispose()
      await persistence.dispose()
    }
  })
})

describe('SQLite reconciliation and source lifecycle', () => {
  it('mounts persistence dynamically, shadows with TEMP live rows, reveals, and hides on unmount', async () => {
    const shared = header('shared', 10, { cwd: '/work' })
    const durable = header('durable', 5)
    TestPersistence.reset([
      { meta: shared, events: messageEvents('persisted needle') },
      { meta: durable, events: messageEvents('durable needle') },
    ])
    const ctx = await liveContext()
    await expect(searchSessions(ctx, { query: 'durable' })).resolves.toEqual({ items: [] })
    const persistenceFiber = await ctx.plugin(TestPersistence)

    await expect(searchSessions(ctx, { query: 'durable' }))
      .resolves.toMatchObject({ items: [{ header: durable, live: false, persisted: true }] })
    const live = ctx.sessions.prepare(shared.id, { meta: { createdAt: 10, cwd: '/work' } })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'live needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(searchSessions(ctx, { query: 'persisted' })).resolves.toEqual({ items: [] })
    await expect(searchSessions(ctx, { query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    detach()
    await expect(searchSessions(ctx, { query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })

    await persistenceFiber.dispose()
    await expect(searchSessions(ctx, { query: 'durable' })).resolves.toEqual({ items: [] })
    await expect(searchEvents(ctx, { sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('does not load a persisted log while the same session is live', async () => {
    const shared = header('checkpointed-live', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    const live = ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: shared.createdAt },
    })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    const persistence = await ctx.plugin(TestPersistence)

    await expect(searchSessions(ctx, {
      query: 'live',
      sessionFilters: [{ kind: 'availability', values: ['persisted'] }],
    })).resolves.toMatchObject({
      items: [{ header: shared, live: true, persisted: true }],
    })
    expect(TestPersistence.reads.get(shared.id)).toBeUndefined()

    detach()
    await expect(searchSessions(ctx, { query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    await persistence.dispose()
  })

  it('retries when a live owner attaches during persistence observation', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      ctx.sessions.create(SessionId('attached'), { seed: messageEvents('attached needle') })
    }

    await expect(searchSessions(ctx, { query: 'attached' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('attached') } }] })
  })

  it('prefers a live owner that attaches during a persisted read and never mutates the store', async () => {
    const shared = header('attach-during-read', 10)
    const persistedEvents = messageEvents('persisted needle')
    TestPersistence.reset([{ meta: shared, events: persistedEvents }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.readEffect = () => {
      ctx.sessions.create(shared.id, {
        seed: messageEvents('live needle'),
        meta: { createdAt: shared.createdAt },
      })
    }

    await expect(searchSessions(ctx, { query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    // The cold read is observation-only: the stored log is unchanged.
    expect(TestPersistence.entries.get(shared.id)?.events).toEqual(persistedEvents)
  })

  it('retries when one live owner replaces another during persistence observation', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const first = ctx.sessions.prepare(SessionId('first'), { seed: messageEvents('first needle') })
    const detachFirst = ctx.sessions.enter(first)
    ctx.sessions.announce(first)
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      detachFirst()
      ctx.sessions.create(SessionId('second'), { seed: messageEvents('second needle') })
    }

    await expect(searchSessions(ctx, { query: 'second' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('second') } }] })
  })

  it('discards a stale list rejection when persistence unmounts during observation', async () => {
    const durable = header('racing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistenceFiber = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = searchSessions(ctx, { query: 'needle' })
    await started
    await persistenceFiber.dispose()
    TestPersistence.failure = new Error('stale backend rejection')
    release()
    await expect(search).resolves.toEqual({ items: [] })
  })

  it('retries against a replacement after the prior binding rejects', async () => {
    const durable = header('replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    let rejectPrior!: (reason: unknown) => void
    TestPersistence.listGate = new Promise<void>((_resolve, reject) => { rejectPrior = reject })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = searchSessions(ctx, { query: 'needle' })
    await started
    await prior.dispose()
    TestPersistence.listGate = undefined
    const replacement = await ctx.plugin(TestPersistence)
    rejectPrior(new Error('stale prior binding'))
    await expect(search).resolves.toMatchObject({ items: [{ header: durable }] })
    await replacement.dispose()
  })

  it('reloads a replacement source even when its opaque revisions collide', async () => {
    const durable = header('colliding-replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('old content') }])
    const revision = TestPersistence.revisions.get(durable.id)!
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    await expect(searchSessions(ctx, { query: 'old' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    await prior.dispose()

    TestPersistence.set({ meta: durable, events: messageEvents('new needle') })
    TestPersistence.revisions.set(durable.id, revision)
    const replacement = await ctx.plugin(TestPersistence)
    const page = await searchSessions(ctx, { query: 'new needle' })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    expect(page).toMatchObject({ items: [{ header: durable }] })
    await expect(searchSessions(ctx, { query: 'old' })).resolves.toEqual({ items: [] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await replacement.dispose()
  })

  it('retries when a successful observation belongs to a source unmounted during listing', async () => {
    const durable = header('successful-unmount')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.listEffect = async () => {
      lists += 1
      if (lists === 1) await persistence.dispose()
    }

    await expect(searchSessions(ctx, { query: 'needle' })).resolves.toEqual({ items: [] })
    expect(lists).toBe(1)
  })

  it('discovers new stored membership through lifecycle notifications after startup', async () => {
    const first = header('first')
    const added = header('added-during-list')
    TestPersistence.reset([{ meta: first, events: messageEvents('first needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      TestPersistence.set({ meta: added, events: messageEvents('added needle') })
      const session = ctx.sessions.prepare(added.id, { meta: { createdAt: added.createdAt } })
      const detach = ctx.sessions.enter(session)
      ctx.sessions.announce(session)
      detach()
    }

    const page = await searchSessions(ctx, { query: 'needle' })
    expect(page.items.map(item => item.header.id).sort()).toEqual([added.id, first.id].sort())
    expect(TestPersistence.reads.get(first.id)).toBe(1)
    expect(TestPersistence.reads.get(added.id)).toBe(1)
  })

  it('does not repeatedly list external snapshot changes during search', async () => {
    const durable = header('continuous-mutation')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.listEffect = () => {
      lists += 1
      TestPersistence.set({ meta: durable, events: messageEvents(`durable needle ${lists}`) })
    }

    await expect(searchSessions(ctx, { query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    await searchSessions(ctx, { query: 'needle' })
    expect(lists).toBe(1)
    expect(TestPersistence.reads.get(durable.id)).toBe(1)
  })


  it('rejects malformed snapshots and preserves typed persistence failures', async () => {
    const durable = header('invalid-snapshot')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    TestPersistence.listOverride = () => 'not-an-array' as never
    await expect(searchSessions(ctx, { query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listOverride = () => [{ header: durable, revision: 1 as never }]
    await expect(searchSessions(ctx, { query: 'needle' }))



      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listOverride = () => [
      { header: durable, revision: SessionPersistenceRevision('duplicate:1') },
      { header: durable, revision: SessionPersistenceRevision('duplicate:2') },
    ]
    await expect(searchSessions(ctx, { query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))

    TestPersistence.listOverride = undefined
    const typed = new SessionQueryError('typed persistence failure', 'SESSION_QUERY_PERSISTENCE_FAILED')
    TestPersistence.failure = typed
    await expect(searchSessions(ctx, { query: 'needle' })).rejects.toBe(typed)
  })

  it('rejects immutable header conflicts between live and persisted sources', async () => {
    const shared = header('conflict', 10, { delegationDepth: 1 })
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: 10, delegationDepth: 2 },
    })

    await expect(searchSessions(ctx, { query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })

  it('preserves unchanged persisted generations while reconciling new, changed, and deleted rows', { timeout: 20_000 }, async () => {
    const path = await temporaryPath()
    const unchanged = header('unchanged')
    const changed = header('changed')
    const deleted = header('deleted')
    TestPersistence.reset([
      { meta: unchanged, events: messageEvents('unchanged needle') },
      { meta: changed, events: messageEvents('old needle') },
      { meta: deleted, events: messageEvents('deleted needle') },
    ])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const firstPersistence = await first.plugin(TestPersistence)
    const firstSearch = await first.plugin(SqliteSessionQueryEngine, { path })
    await searchSessions(first, { query: 'needle' })
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await searchSessions(first, { query: 'needle' })
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await firstSearch.dispose()
    await firstPersistence.dispose()

    const beforeDb = new DatabaseSync(path)
    const beforeRows = beforeDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    beforeDb.close()
    const before = new Map(beforeRows.map(row => [row.id, row.generation]))

    const added = header('added')
    TestPersistence.entries.delete(deleted.id)
    TestPersistence.set({ meta: changed, events: messageEvents('changed needle') })
    TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const secondPersistence = await second.plugin(TestPersistence)
    const secondSearch = await second.plugin(SqliteSessionQueryEngine, { path })
    const result = await searchSessions(second, { query: 'needle' })
    expect(result.items.map(item => item.header.id).sort()).toEqual([added.id, changed.id, unchanged.id].sort())
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({
      unchanged: 1,
      changed: 2,
      deleted: 1,
      added: 1,
    })
    await secondSearch.dispose()
    await secondPersistence.dispose()

    const afterDb = new DatabaseSync(path)
    const afterRows = afterDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    afterDb.close()
    const after = new Map(afterRows.map(row => [row.id, row.generation]))
    expect(after.get(unchanged.id)).toBe(before.get(unchanged.id))
    expect(after.get(changed.id)).toBeGreaterThan(before.get(changed.id)!)
    expect(after.has(deleted.id)).toBe(false)
    expect(after.has(added.id)).toBe(true)
  })

  it('drops connection-local live overlays on reopen and retains persistent bases', async () => {
    const path = await temporaryPath()
    const shared = header('shared', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const persistence = await first.plugin(TestPersistence)
    const live = first.sessions.create(shared.id, { seed: messageEvents('live needle'), meta: { createdAt: 10 } })
    const search = await first.plugin(SqliteSessionQueryEngine, { path })
    await expect(searchEvents(first, { sessionId: live.id, query: 'live' })).resolves.toMatchObject({ items: [{}] })
    await search.dispose()
    await persistence.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const persistenceAgain = await second.plugin(TestPersistence)
    const searchAgain = await second.plugin(SqliteSessionQueryEngine, { path })
    await expect(searchSessions(second, { query: 'live' })).resolves.toEqual({ items: [] })
    await expect(searchSessions(second, { query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    await searchAgain.dispose()
    await persistenceAgain.dispose()
  })

  it('keeps external writes unseen until a lifecycle notification, then reuses the revision', async () => {
    const durable = header('repair')
    TestPersistence.reset([{ meta: durable, events: messageEvents('before repair') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    await expect(searchSessions(ctx, { query: 'before' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    // An external writer (resume-time torn-tail repair, or another append)
    // replaces the stored log and moves its revision.
    TestPersistence.set({ meta: durable, events: messageEvents('repaired needle') })
    await expect(searchSessions(ctx, { query: 'repaired' })).resolves.toEqual({ items: [] })
    notifyStored(ctx, durable)

    await expect(searchSessions(ctx, { query: 'repaired' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await searchSessions(ctx, { query: 'repaired' })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await persistence.dispose()
  })

  it('recovers on the next search after a persistence failure', async () => {
    TestPersistence.reset([{ meta: header('durable'), events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.failure = 'offline'
    await expect(searchSessions(ctx, { query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    const signal = new AbortController().signal
    await expect(searchSessions(ctx, { query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = new Error('still offline')
    await expect(searchSessions(ctx, { query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = undefined
    await expect(searchSessions(ctx, { query: 'needle' })).resolves.toMatchObject({ items: [{}] })

  })
})

describe('SQLite schema, cancellation, and real persistence integration', () => {
  it('creates a new database and WAL sidecars owner-only without changing its parent mode', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    const directory = dirname(path)
    await chmod(directory, 0o755)

    const ctx = await liveContext({ path })
    await searchSessions(ctx, { query: 'needle' })

    expect((await stat(directory)).mode & 0o777).toBe(0o755)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('creates a persistent rollback journal owner-only', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    const ctx = await liveContext({ path, journalMode: 'persist' })
    await searchSessions(ctx, { query: 'needle' })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-journal`)).mode & 0o777).toBe(0o600)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('preserves the mode of an existing database file', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    await writeFile(path, '', { mode: 0o644 })
    await chmod(path, 0o644)

    const ctx = await liveContext({ path, journalMode: 'delete' })
    await searchSessions(ctx, { query: 'needle' })

    expect((await stat(path)).mode & 0o777).toBe(0o644)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('surfaces filesystem failures while pre-creating the database', async () => {
    const path = `${await temporaryPath()}\0`
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)

    await expect(ctx.plugin(SqliteSessionQueryEngine, { path })).rejects.toMatchObject({
      code: 'SESSION_QUERY_INDEX_FAILED',

    })
    expect(ctx.sessionQuery).toBeUndefined()
  })

  it('resets a recognized incompatible schema but refuses unknown or foreign tables', { timeout: 20_000 }, async () => {
    const stalePath = await temporaryPath('stale.db')
    const staleOwner = await liveContext({ path: stalePath })
    await (staleOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const stale = new DatabaseSync(stalePath)
    stale.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION - 1}`)
    stale.close()
    const staleCtx = await liveContext({ path: stalePath })
    staleCtx.sessions.create(SessionId('live'), { seed: messageEvents('needle') })
    await searchSessions(staleCtx, { query: 'needle' })
    await (staleCtx.sessionQuery as SqliteSessionQueryEngine).close()
    const rebuilt = new DatabaseSync(stalePath)
    expect((rebuilt.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(SESSION_QUERY_SQLITE_SCHEMA_VERSION)
    rebuilt.close()

    const augmentedPath = await temporaryPath('augmented.db')
    const augmentedOwner = await liveContext({ path: augmentedPath })
    await (augmentedOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const augmented = new DatabaseSync(augmentedPath)
    augmented.exec('CREATE TABLE unrelated(value TEXT)')
    augmented.exec("INSERT INTO unrelated VALUES ('safe')")
    augmented.exec('PRAGMA user_version = 999')
    augmented.close()
    const augmentedCtx = new Context()
    await augmentedCtx.plugin(SessionStore)
    await augmentedCtx.plugin(SessionProjectionRegistry)
    await expect(augmentedCtx.plugin(SqliteSessionQueryEngine, { path: augmentedPath }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(augmentedCtx.sessionQuery).toBeUndefined()
    const stillAugmented = new DatabaseSync(augmentedPath)
    expect(stillAugmented.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'safe' })
    expect(stillAugmented.prepare('PRAGMA user_version').get()).toEqual({ user_version: 999 })
    stillAugmented.close()

    const currentAugmentedPath = await temporaryPath('current-augmented.db')
    const currentAugmentedOwner = await liveContext({ path: currentAugmentedPath })
    await (currentAugmentedOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const currentAugmented = new DatabaseSync(currentAugmentedPath)
    currentAugmented.exec('CREATE TABLE unrelated(value TEXT)')
    currentAugmented.exec("INSERT INTO unrelated VALUES ('safe')")
    currentAugmented.close()
    const currentAugmentedCtx = new Context()
    await currentAugmentedCtx.plugin(SessionStore)
    await currentAugmentedCtx.plugin(SessionProjectionRegistry)
    await expect(currentAugmentedCtx.plugin(SqliteSessionQueryEngine, {
      path: currentAugmentedPath,
      journalMode: 'delete',
    })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(currentAugmentedCtx.sessionQuery).toBeUndefined()
    const stillCurrentAugmented = new DatabaseSync(currentAugmentedPath)
    expect(stillCurrentAugmented.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'safe' })
    expect(stillCurrentAugmented.prepare('PRAGMA user_version').get())
      .toEqual({ user_version: SESSION_QUERY_SQLITE_SCHEMA_VERSION })
    expect(stillCurrentAugmented.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillCurrentAugmented.close()

    const foreignPath = await temporaryPath('foreign.db')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('PRAGMA journal_mode = WAL')
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.exec("INSERT INTO canonical VALUES ('safe')")
    foreign.close()
    const foreignCtx = new Context()
    await foreignCtx.plugin(SessionStore)
    await foreignCtx.plugin(SessionProjectionRegistry)
    await expect(foreignCtx.plugin(SqliteSessionQueryEngine, { path: foreignPath, journalMode: 'delete' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(foreignCtx.sessionQuery).toBeUndefined()
    const stillForeign = new DatabaseSync(foreignPath)
    expect(stillForeign.prepare('SELECT value FROM canonical').get()).toEqual({ value: 'safe' })
    expect(stillForeign.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillForeign.close()

    const wildcardPath = await temporaryPath('sqlite-wildcard.db')
    const wildcard = new DatabaseSync(wildcardPath)
    wildcard.exec('PRAGMA journal_mode = WAL')
    wildcard.exec('CREATE TABLE sqliteX(value TEXT)')
    wildcard.exec("INSERT INTO sqliteX VALUES ('safe')")
    wildcard.close()
    const wildcardCtx = new Context()
    await wildcardCtx.plugin(SessionStore)
    await wildcardCtx.plugin(SessionProjectionRegistry)
    await expect(wildcardCtx.plugin(SqliteSessionQueryEngine, {
      path: wildcardPath,
      journalMode: 'delete',
    })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(wildcardCtx.sessionQuery).toBeUndefined()
    const stillWildcard = new DatabaseSync(wildcardPath)
    expect(stillWildcard.prepare('SELECT value FROM sqliteX').get()).toEqual({ value: 'safe' })
    expect(stillWildcard.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
    expect(stillWildcard.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(stillWildcard.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillWildcard.close()

    const otherAppPath = await temporaryPath('other-app.db')
    const otherApp = new DatabaseSync(otherAppPath)
    otherApp.exec('PRAGMA application_id = 123')
    otherApp.close()
    const otherAppCtx = new Context()
    await otherAppCtx.plugin(SessionStore)
    await otherAppCtx.plugin(SessionProjectionRegistry)
    await expect(otherAppCtx.plugin(SqliteSessionQueryEngine, { path: otherAppPath }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(otherAppCtx.sessionQuery).toBeUndefined()
  })

  it('fails plugin initialization without an unhandled rejection or partial service', async () => {
    const path = await temporaryPath('never-queried.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await expect(ctx.plugin(SqliteSessionQueryEngine, { path }))
        .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
      expect(ctx.sessionQuery).toBeUndefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('defers an invalid database failure only in first-search mode', async () => {
    const path = await temporaryPath('lazy-invalid.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()

    const lazyCtx = new Context()
    await lazyCtx.plugin(SessionStore)
    await lazyCtx.plugin(SessionProjectionRegistry)
    const lazy = await lazyCtx.plugin(SqliteSessionQueryEngine, {
      path,
      openAt: 'first-search',
    })
    expect(lazyCtx.sessionQuery).toBeInstanceOf(SqliteSessionQueryEngine)
    await expect(searchSessions(lazyCtx, { query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await lazy.dispose()

    const eagerCtx = new Context()
    await eagerCtx.plugin(SessionStore)
    await eagerCtx.plugin(SessionProjectionRegistry)
    await expect(eagerCtx.plugin(SqliteSessionQueryEngine, { path }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(eagerCtx.sessionQuery).toBeUndefined()
  })


  it.each(['sessions', 'events'] as const)(
    'starts no persistence observation for a pre-aborted %s search',
    async (scope) => {
      const durable = header(`pre-aborted-${scope}`)
      TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
      const ctx = await liveContext({ path: ':memory:', openAt: 'first-search' })
      await ctx.plugin(TestPersistence)
      const controller = new AbortController()
      controller.abort(new Error(`pre-aborted ${scope}`))

      const pending = scope === 'sessions'
        ? searchSessions(ctx, { query: 'needle' }, { signal: controller.signal })
        : searchEvents(ctx,
          { sessionId: durable.id, query: 'needle' },
          { signal: controller.signal },
        )

      await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
      expect(TestPersistence.listSignals).toEqual([])
      expect(TestPersistence.readSignals).toEqual([])
    },
  )


  it('awaits optional-persistence child-fiber quiescence on disposal', async () => {
    TestPersistence.reset()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    const persistence = await ctx.plugin(TestPersistence)
    const optional = (ctx.sessionQuery as unknown as {
      optionalPersistenceFiber: Fiber
    }).optionalPersistenceFiber
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => { release = resolve })
    optional.ctx.effect(() => () => cleanup)

    let settled = false
    const disposing = search.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await disposing
    await persistence.dispose()
  })

  it('combines the real JSONL persistence backend with the real search service keylessly', async () => {
    const persistenceRoot = await temporaryPath('sessions')
    const searchPath = await temporaryPath('derived.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path: searchPath })
    const meta = header('real', 10, { cwd: '/work' })
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append(messageEvents('real JSONL needle'))
    await writer.close()

    await expect(searchSessions(ctx, { query: 'JSONL needle' }))
      .resolves.toMatchObject({ items: [{ header: meta, persisted: true, live: false }] })
    await expect(searchEvents(ctx, { sessionId: meta.id, query: 'JSONL needle' }))
      .resolves.toMatchObject({ session: meta, items: [{ sessionId: meta.id, seq: SessionSeq(0) }] })
    await expect(searchEvents(ctx, { sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await search.dispose()
    const reader = await ctx.sessionPersistence.open(meta.id, 'read')
    expect(reader.header).toMatchObject(meta)
    await expect(reader.read()).resolves.toMatchObject({ events: [{ seq: SessionSeq(0) }] })
    await reader.close()
    await persistence.dispose()
  })

  it('reconciles a reopened derived index: unchanged revisions skip reads, another store reloads', async () => {
    const persistenceRootA = await temporaryPath('sessions-a')
    const persistenceRootB = await temporaryPath('sessions-b')
    const searchPath = await temporaryPath('derived-collision.db')
    const shared = header('same-id', 10)
    const storeSession = async (ctx: Context, events: SessionEvent[]): Promise<void> => {
      const writer = await ctx.sessionPersistence.create(shared)
      await writer.append(events)
      await writer.close()
    }

    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const persistenceA = await first.plugin(JsonlSessionPersistence, { root: persistenceRootA, compression: 'none' })
    await storeSession(first, messageEvents('alpha source'))
    const openA = vi.spyOn(first.sessionPersistence, 'open')
    const searchA = await first.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(searchSessions(first, { query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(openA).not.toHaveBeenCalled()
    await searchA.dispose()
    await persistenceA.dispose()

    const reopened = new Context()
    await reopened.plugin(SessionStore)
    await reopened.plugin(SessionProjectionRegistry)
    const persistenceAAgain = await reopened.plugin(JsonlSessionPersistence, { root: persistenceRootA, compression: 'none' })
    const reopenedOpen = vi.spyOn(reopened.sessionPersistence, 'open')
    const searchAAgain = await reopened.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(searchSessions(reopened, { query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(reopenedOpen).not.toHaveBeenCalled()
    await searchAAgain.dispose()
    await persistenceAAgain.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const persistenceB = await second.plugin(JsonlSessionPersistence, { root: persistenceRootB, compression: 'none' })
    await storeSession(second, messageEvents('bravo source'))
    const openB = vi.spyOn(second.sessionPersistence, 'open')
    const searchB = await second.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(searchSessions(second, { query: 'bravo' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    await expect(searchSessions(second, { query: 'alpha' })).resolves.toEqual({ items: [] })
    expect(openB).not.toHaveBeenCalled()
    await searchB.dispose()
    await persistenceB.dispose()
  })
})

describe('SQLite dirty reconciliation', () => {
  it('does no listing, cold reading, or live projection on unchanged searches', async () => {
    const stored = header('quiet-stored')
    TestPersistence.reset([{ meta: stored, events: messageEvents('stored needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const live = ctx.sessions.create(SessionId('quiet-live'), { seed: messageEvents('live needle') })
    const snapshot = vi.spyOn(live, 'snapshotEvents')
    const stat = vi.spyOn(ctx.sessionPersistence, 'stat')
    await searchSessions(ctx, { query: 'needle' })
    stat.mockClear()
    const projections = snapshot.mock.calls.length
    const lists = TestPersistence.listSignals.length
    await searchSessions(ctx, { query: 'needle' })
    await searchEvents(ctx, { sessionId: stored.id, query: 'needle' })
    expect(snapshot).toHaveBeenCalledTimes(projections)
    expect(stat).not.toHaveBeenCalled()
    expect(TestPersistence.listSignals).toHaveLength(lists)
    expect(TestPersistence.reads.get(stored.id)).toBe(1)
    snapshot.mockRestore()
    stat.mockRestore()
  })

  it('upserts document additions, edits, and removals without rewriting unchanged FTS rows', async () => {
    const stored = header('document-delta')
    TestPersistence.reset([{ meta: stored, events: messageEvents('alpha needle') }])
    const path = await temporaryPath()
    const ctx = await liveContext({ path })
    await ctx.plugin(TestPersistence)
    await searchSessions(ctx, { query: 'needle' })
    using db = new DatabaseSync(path, { readOnly: true })
    const docs = () => db.prepare('SELECT rowid, seq, text FROM persisted_docs ORDER BY seq').all()
    const original = docs()[0]
    const extra = { ...messageEvents('beta needle')[0]!, seq: SessionSeq(1) }
    TestPersistence.set({ meta: stored, events: [...messageEvents('alpha needle'), extra] })
    notifyStored(ctx, stored)
    await searchSessions(ctx, { query: 'needle' })
    expect(docs()).toHaveLength(2)
    expect(docs()[0]).toEqual(original)
    const before = docs()
    TestPersistence.set({ meta: stored, events: [...messageEvents('alpha needle'), extra] })
    notifyStored(ctx, stored)
    await searchSessions(ctx, { query: 'needle' })
    expect(docs()).toEqual(before)
    TestPersistence.set({ meta: stored, events: messageEvents('edited needle') })
    notifyStored(ctx, stored)
    await searchSessions(ctx, { query: 'edited' })
    expect(docs()).toMatchObject([{ rowid: original?.['rowid'], seq: 0, text: 'edited needle' }])
    await expect(searchSessions(ctx, { query: 'beta' })).resolves.toEqual({ items: [] })
  })

  it('flushes the real closing writer before retiring its live tail', async () => {
    const ctx = await liveContext()
    const persistence = await ctx.plugin(JsonlSessionPersistence, {
      root: await temporaryPath('closing-sessions'), compression: 'none',
    })
    const session = ctx.sessions.prepare(SessionId('closing-tail'), { meta: { createdAt: 10 } })
    const writer = await ctx.sessionPersistence.create(session.header)
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await searchSessions(ctx, { query: 'first' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'final tail needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    detach()
    await expect(searchSessions(ctx, { query: 'final tail' }))
      .resolves.toMatchObject({ items: [{ header: { id: session.id }, live: false, persisted: true }] })
    await writer.close()
    await persistence.dispose()
  })

  it('refreshes a historical parent only for real related-child notifications', async () => {
    const root = await temporaryPath('related-sessions')
    const path = await temporaryPath()
    const ctx = await liveContext({ path })
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const parent = SessionId('historical-parent')
    const child = SessionId('historical-child')
    const parentMeta = { type: 'session', version: 3, id: parent, createdAt: 1,
      isSeeded: false, delegationDepth: 0 }
    const store = async (id: SessionIdType, childLabel?: string): Promise<void> => {
      const path = generationLogPath(root, undefined, id, 3, 'none')
      await mkdir(dirname(path), { recursive: true })
      const meta = childLabel === undefined ? { ...parentMeta, id } : {
        ...parentMeta, id, createdAt: 2, origin: 'subagent', parentSession: parent, delegationDepth: 1,
      }
      const event = { type: 'subagent/descriptor', seq: 0, time: 2,
        data: { version: 3, mode: 'continuable', provider: 'spawn', label: childLabel } }
      await writeFile(path, JSON.stringify(meta) + '\n'
        + (childLabel === undefined ? '' : JSON.stringify(event) + '\n'))
    }
    await store(parent)
    await store(child, 'old label')
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    await expect(searchEvents(ctx, { sessionId: parent, query: 'needle' }))
      .resolves.toMatchObject({ session: { id: parent }, items: [] })
    using db = new DatabaseSync(path, { readOnly: true })
    const revision = () => db.prepare('SELECT revision FROM persisted_sessions WHERE id=?').get(parent)
    const previousRevision = revision()
    const unrelated = ctx.sessions.create(SessionId('unrelated-live'), { seed: messageEvents('other needle') })
    unrelated.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'unrelated' }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
    await searchSessions(ctx, { query: 'old label' })
    await store(child, 'new label')
    const liveChild = ctx.sessions.prepare(child, { meta: { createdAt: 2, origin: 'subagent',
      parentSession: parent, delegationDepth: 1 } })
    const detach = ctx.sessions.enter(liveChild)
    ctx.sessions.announce(liveChild)
    detach()
    await searchEvents(ctx, { sessionId: parent, query: 'needle' })
    expect(revision()).not.toEqual(previousRevision)
    const reader = await ctx.sessionPersistence.open(parent, 'read')
    expect((await reader.read()).events).toMatchObject([{ type: 'subagent/catalog', data: { label: 'new label' } }])
    await reader.close()
    open.mockRestore()
    await persistence.dispose()
  })
})

describe('SQLite bounded index build', () => {
  it('skips a persisted session above maxIndexedSessionBytes, warns once, and indexes the rest', async () => {
    const oversized = header('oversized-session')
    const indexed = header('indexed-session')
    TestPersistence.reset([
      { meta: oversized, events: messageEvents('oversized needle') },
      { meta: indexed, events: messageEvents('indexed needle') },
    ])
    TestPersistence.sizes.set(oversized.id, 4096)
    TestPersistence.sizes.set(indexed.id, 16)
    const ctx = await liveContext({ path: ':memory:', maxIndexedSessionBytes: 64 })
    await ctx.plugin(TestPersistence)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    const first = await searchSessions(ctx, { query: 'needle' })
    expect(first.items.map(item => item.header.id)).toEqual([indexed.id])
    expect(TestPersistence.reads.get(oversized.id)).toBeUndefined()
    expect(TestPersistence.reads.get(indexed.id)).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(oversized.id)
    expect(String(warn.mock.calls[0]?.[0])).toContain('maxIndexedSessionBytes')

    await searchSessions(ctx, { query: 'needle' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(TestPersistence.reads.get(oversized.id)).toBeUndefined()
    expect(TestPersistence.reads.get(indexed.id)).toBe(1)
    warn.mockRestore()
  })

  it('keeps the sessions committed before a later observation failure', async () => {
    const committed = header('committed-session')
    const failing = header('failing-session')
    TestPersistence.reset([
      { meta: committed, events: messageEvents('committed needle') },
      { meta: failing, events: messageEvents('failing needle') },
    ])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.readEffect = (entry) => {
      if (entry.meta.id === committed.id) TestPersistence.failure = new Error('second read failed')
    }

    await expect(searchSessions(ctx, { query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    expect(TestPersistence.reads.get(committed.id)).toBe(1)
    expect(TestPersistence.reads.get(failing.id)).toBe(1)

    TestPersistence.failure = undefined
    const page = await searchSessions(ctx, { query: 'needle' })
    expect([...page.items.map(item => item.header.id)].sort()).toEqual([committed.id, failing.id].sort())
    // The committed row was not read again; only the session that failed before was.
    expect(TestPersistence.reads.get(committed.id)).toBe(1)
    expect(TestPersistence.reads.get(failing.id)).toBe(2)
  })

  it('reports a failed persisted commit and retries the same revision', async () => {
    const path = await temporaryPath()
    const stored = header('commit-failure')
    TestPersistence.reset([{ meta: stored, events: messageEvents('commit needle') }])
    const gate = Promise.withResolvers<undefined>()
    TestPersistence.listGate = gate.promise
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(TestPersistence)
    const query = await ctx.plugin(SqliteSessionQueryEngine, { path })
    using db = new DatabaseSync(path)
    try {
      db.exec("CREATE TRIGGER refuse_insert BEFORE INSERT ON persisted_sessions BEGIN SELECT RAISE(ABORT, 'fixture refused write'); END")
      gate.resolve(undefined)
      await expect(searchSessions(ctx, { query: 'needle' })).rejects.toMatchObject({ code: 'SESSION_QUERY_INDEX_FAILED' })
      expect(db.prepare('SELECT id FROM persisted_sessions').all()).toEqual([])
      db.exec('DROP TRIGGER refuse_insert')
      await expect(searchSessions(ctx, { query: 'needle' })).resolves.toMatchObject({ items: [{ header: { id: stored.id } }] })
    } finally {
      gate.resolve(undefined)
      await query.dispose()
    }
  })

  it('reuses one live index row while a live session is unchanged and refreshes it after an append', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const live = ctx.sessions.create(SessionId('live-fingerprint'), { seed: messageEvents('alpha needle') })
    await expect(searchEvents(ctx, { sessionId: live.id, query: 'needle' })).resolves.toMatchObject({ session: { id: live.id } })
    await expect(searchEvents(ctx, { sessionId: live.id, query: 'needle' })).resolves.toMatchObject({ session: { id: live.id } })

    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'beta needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(searchEvents(ctx, { sessionId: live.id, query: 'needle' })).resolves.toMatchObject({ session: { id: live.id } })
  })

  it('evicts a previously indexed session whose stored log crosses the bound, then rebuilds it', async () => {
    const growing = header('growing-session')
    const stable = header('stable-session')
    TestPersistence.reset([
      { meta: growing, events: messageEvents('grow needle') },
      { meta: stable, events: messageEvents('stable needle') },
    ])
    TestPersistence.sizes.set(growing.id, 16)
    TestPersistence.sizes.set(stable.id, 16)
    const path = await temporaryPath()
    const ctx = await liveContext({ path, maxIndexedSessionBytes: 64 })
    await ctx.plugin(TestPersistence)
    using db = new DatabaseSync(path, { readOnly: true })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const indexedIds = (): string[] =>
      (db.prepare('SELECT id FROM persisted_sessions ORDER BY id').all() as Array<{ id: string }>)
        .map(row => row.id)
    const generation = (): number => (
      db.prepare('SELECT global_generation FROM search_state WHERE singleton = 1').get() as { global_generation: number }
    ).global_generation

    const first = await searchSessions(ctx, { query: 'needle', limit: 1 })
    expect(first.items).toHaveLength(1)
    const cursor = first.nextCursor
    if (cursor === undefined) throw new Error('expected a cursor')
    expect(indexedIds()).toEqual([growing.id, stable.id])
    const generationBefore = generation()

    // The stored artifact crosses the bound and the stored revision keeps moving.
    TestPersistence.sizes.set(growing.id, 4096)
    TestPersistence.set({ meta: growing, events: messageEvents('grow needle') })
    notifyStored(ctx, growing)

    const evicted = await searchSessions(ctx, { query: 'needle' })
    expect(evicted.items.map(item => item.header.id)).toEqual([stable.id])
    expect(indexedIds()).toEqual([stable.id])
    expect(generation()).toBeGreaterThan(generationBefore)
    // The oversized log is never read, and its stale row can no longer answer pages.
    expect(TestPersistence.reads.get(growing.id)).toBe(1)
    await expect(searchSessions(ctx, { query: 'needle', limit: 1, cursor }))
      .resolves.toEqual({ items: [] })
    expect(warn).toHaveBeenCalledTimes(1)

    // Dropping back under the bound indexes it again.
    TestPersistence.sizes.set(growing.id, 16)
    notifyStored(ctx, growing)
    const rebuilt = await searchSessions(ctx, { query: 'needle' })
    expect([...rebuilt.items.map(item => item.header.id)].sort()).toEqual([growing.id, stable.id].sort())
    expect(indexedIds()).toEqual([growing.id, stable.id])
    warn.mockRestore()
  })

  it('removes a previously observed session after its lifecycle marks storage dirty', async () => {
    const vanishing = header('vanishing-session')
    TestPersistence.reset([{ meta: vanishing, events: messageEvents('vanish needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    await searchSessions(ctx, { query: 'needle' })
    TestPersistence.entries.delete(vanishing.id)
    notifyStored(ctx, vanishing)

    const page = await searchSessions(ctx, { query: 'needle' })
    expect(page.items).toEqual([])
  })

  it('builds a live fingerprint without serializing the whole session log into one string', async () => {
    TestPersistence.reset([{ meta: header('persisted-serialization'), events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('live-serialization'), { seed: messageEvents('live needle') })
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      await searchSessions(ctx, { query: 'needle' })
    } finally {
      stringify.mockRestore()
    }
    const wholeLogCalls = stringify.mock.calls.filter(([value]) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
      const record = value as Record<string, unknown>
      return 'header' in record && Array.isArray(record.events)
    })
    expect(wholeLogCalls).toEqual([])
  })
})

describe('shared historical BM25', () => {
  it('matches native historical session-best and complete pages after moving identical bodies into live', async () => {
    const entries = Array.from({ length: 24 }, (_, i) => ({
      meta: header(`bm25-${String(i).padStart(2, '0')}`),
      events: [
        ...messageEvents(`${'alpha '.repeat(1 + i % 5)}${'filler '.repeat(i * 3)}`, 10),
        { ...messageEvents(`alpha alpha alpha ${'other '.repeat(i * 7)}`, 20)[0]!, seq: SessionSeq(1) },
      ],
    }))
    TestPersistence.reset(entries)
    const path = await temporaryPath()
    const ctx = await liveContext({ path, defaultLimit: 5, maxLimit: 50 })
    await ctx.plugin(TestPersistence)
    const collect = async () => {
      const hits: string[] = []
      let cursor: ReturnType<typeof SessionSearchCursor> | undefined
      do {
        const page = await searchSessions(ctx, { query: 'alpha', limit: 5, ...cursor === undefined ? {} : { cursor } })
        hits.push(...page.items.map(item => `${item.header.id}:${item.bestMatch.seq}`))
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return hits
    }
    const historical = await collect()
    for (const entry of entries.filter((_, i) => i % 3 === 0)) {
      ctx.sessions.create(entry.meta.id, { seed: entry.events, meta: { createdAt: 1 } })
    }
    expect(await collect()).toEqual(historical)
    ctx.sessions.create(SessionId('irrelevant-long-live'), { seed: messageEvents('filler '.repeat(2000)) })
    expect(await collect()).toEqual(historical)
    using db = new DatabaseSync(path, { readOnly: true })
    const gold = db.prepare(`WITH hits AS MATERIALIZED (
      SELECT session_id,CAST(seq AS INTEGER) seq,CAST(time AS INTEGER) time,bm25(persisted_docs) score
      FROM persisted_docs WHERE persisted_docs MATCH '"alpha"'
    ), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY session_id ORDER BY score,time DESC,seq DESC) n FROM hits)
    SELECT session_id,seq FROM ranked WHERE n=1 ORDER BY score,time DESC,session_id,seq DESC`).all()
    expect(historical).toEqual(gold.map(row => `${String(row['session_id'])}:${String(row['seq'])}`))
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('reranks continued event pages when another historical revision changes', async () => {
    const background = header('background')
    TestPersistence.reset([{ meta: background, events: messageEvents('anchor') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const target = ctx.sessions.create(SessionId('bm25-target'), { seed: [
      ...messageEvents('novel novel ' + 'filler '.repeat(30)),
      { ...messageEvents('novel', 2)[0]!, seq: SessionSeq(1) },
    ] })
    await searchSessions(ctx, { query: 'novel' })
    const initial = await searchEvents(ctx, { sessionId: target.id, query: 'novel', limit: 1 })
    expect(initial.items[0]?.seq).toBe(1)
    ctx.sessions.create(SessionId('unrelated-live'), { seed: messageEvents('unrelated') })
    await expect(searchEvents(ctx, { sessionId: target.id, query: 'novel', limit: 1, cursor: initial.nextCursor! }))
      .resolves.toMatchObject({ items: [{ seq: 0 }] })
    TestPersistence.set({ meta: background, events: messageEvents('anchor '.repeat(1000)) })
    notifyStored(ctx, background)
    await searchSessions(ctx, { query: 'anchor' })
    await expect(searchEvents(ctx, { sessionId: target.id, query: 'novel', limit: 1, cursor: initial.nextCursor! }))
      .resolves.toMatchObject({ items: [{ seq: 1 }] })
    const revised = await searchEvents(ctx, { sessionId: target.id, query: 'novel', limit: 1 })
    expect(revised.items[0]?.seq).toBe(0)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('ranks with a live background for tokenless history and tracks appended token lengths', async () => {
    TestPersistence.reset([{ meta: header('no-tokens'), events: messageEvents('😀 !!!') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const target = ctx.sessions.create(SessionId('live-lengths'), { seed: [
      ...messageEvents('alpha alpha alpha'),
      { ...messageEvents('alpha ' + 'filler '.repeat(20), 2)[0]!, seq: SessionSeq(1) },
    ] })
    const first = await searchEvents(ctx, { sessionId: target.id, query: 'alpha', limit: 1 })
    expect(first.items[0]?.seq).toBe(0)
    target.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'alpha alpha alpha alpha' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await searchEvents(ctx, { sessionId: target.id, query: 'alpha' })
    await expect(searchEvents(ctx, { sessionId: target.id, query: 'alpha', limit: 1, cursor: first.nextCursor! }))
      .resolves.toMatchObject({ items: [{ seq: 0 }] })
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })
})

describe('BM25 source-independent ties', () => {
  it.each([1, 7, 31, 100, 1000])('uses metadata ties for identical bodies with historical length %i', async (length) => {
    const stored = header('z-identical')
    const body = 'alpha alpha alpha ' + 'filler '.repeat(13)
    TestPersistence.reset([
      { meta: stored, events: messageEvents(body, 10) },
      { meta: header('tie-background'), events: messageEvents('background '.repeat(length)) },
    ])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('a-identical'), { seed: messageEvents(body, 10), meta: { createdAt: 1 } })
    const page = await searchSessions(ctx, { query: 'alpha' })
    expect(page.items.map(item => item.header.id)).toEqual([SessionId('a-identical'), stored.id])
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })
})

describe('SQLite document-key sidecar', () => {
  const upstreamTables = [
    'persisted_docs', 'persisted_docs_config', 'persisted_docs_content', 'persisted_docs_data',
    'persisted_docs_docsize', 'persisted_docs_idx', 'persisted_sessions', 'search_state',
  ]

  async function persistedOwner(
    config: ConstructorParameters<typeof SqliteSessionQueryEngine>[1],
  ): Promise<{ ctx: Context; close: () => Promise<void> }> {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const persistence = await ctx.plugin(TestPersistence)
    const search = await ctx.plugin(SqliteSessionQueryEngine, config)
    return { ctx, close: async () => { await search.dispose(); await persistence.dispose() } }
  }

  function userTables(path: string): string[] {
    const db = new DatabaseSync(path)
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name").all() as Array<{ name: string }>
    db.close()
    return rows.map(row => row.name)
  }

  it('keeps the main index on the upstream schema and looks documents up through indexed sidecar keys', async () => {
    const path = await temporaryPath()
    TestPersistence.reset([
      { meta: header('first'), events: messageEvents('first needle') },
      { meta: header('second'), events: messageEvents('second needle') },
    ])
    const owner = await persistedOwner({ path })
    owner.ctx.sessions.create(SessionId('live'), { seed: messageEvents('live needle') })
    await searchSessions(owner.ctx, { query: 'needle' })
    using db = new DatabaseSync(path, { readOnly: true })
    db.prepare('ATTACH DATABASE ? AS keys').run(path + '.keys.db')
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT d.rowid FROM keys.persisted_doc_keys k
      CROSS JOIN persisted_docs d ON d.rowid = k.doc_rowid WHERE k.session_id = ?`).all('first') as Array<{ detail: string }>
    expect(plan[0]?.detail).toContain('USING COVERING INDEX persisted_doc_keys_session')
    await owner.close()

    expect(userTables(path)).toEqual(upstreamTables)
    const main = new DatabaseSync(path)
    expect(main.prepare('PRAGMA user_version').get()).toEqual({ user_version: SESSION_QUERY_SQLITE_SCHEMA_VERSION })
    const generation = main.prepare('SELECT global_generation FROM search_state').get() as { global_generation: number }
    const documents = main.prepare('SELECT rowid AS doc_rowid, session_id, CAST(seq AS INTEGER) AS seq FROM persisted_docs ORDER BY rowid').all()
    main.close()
    const keys = new DatabaseSync(`${path}.keys.db`)
    expect(keys.prepare('PRAGMA application_id').get()).toEqual({ application_id: SESSION_QUERY_SQLITE_KEYS_APPLICATION_ID })
    expect(keys.prepare('PRAGMA user_version').get()).toEqual({ user_version: SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION })
    expect(keys.prepare('SELECT doc_rowid, session_id, seq FROM persisted_doc_keys ORDER BY doc_rowid').all()).toEqual(documents)
    expect(documents).toHaveLength(2)
    expect(keys.prepare('SELECT main_generation FROM key_state').get()).toEqual({ main_generation: generation.global_generation })
    keys.close()
  })

  it('rebuilds a missing or stale sidecar from the main index without rereading unchanged logs', { timeout: 20_000 }, async () => {
    const path = await temporaryPath()
    const keysPath = `${path}.keys.db`
    const changed = header('changed')
    TestPersistence.reset([
      { meta: header('unchanged'), events: messageEvents('unchanged needle') },
      { meta: changed, events: messageEvents('old needle') },
    ])
    const first = await persistedOwner({ path })
    await searchSessions(first.ctx, { query: 'needle' })
    await first.close()

    const replaceAndSearch = async (text: string) => {
      TestPersistence.set({ meta: changed, events: messageEvents(`${text} needle`) })
      const owner = await persistedOwner({ path })
      await searchSessions(owner.ctx, { query: 'needle' })
      using db = new DatabaseSync(path, { readOnly: true })
      const rows = db.prepare("SELECT text FROM persisted_docs WHERE session_id = 'changed'").all()
      await owner.close()
      return rows
    }

    await rm(keysPath)
    expect(await replaceAndSearch('missing')).toEqual([{ text: 'missing needle' }])

    // Another index owner writes only the main file and advances its generation.
    const keys = new DatabaseSync(keysPath)
    keys.exec('DELETE FROM persisted_doc_keys')
    keys.close()
    const main = new DatabaseSync(path)
    main.exec('UPDATE search_state SET global_generation = global_generation + 1')
    main.close()
    expect(await replaceAndSearch('stale')).toEqual([{ text: 'stale needle' }])
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 3 })
  })

  it('honors an explicit keysPath and refuses an unusable sidecar', async () => {
    const path = await temporaryPath()
    const keysPath = join(dirname(path), 'nested', 'custom.keys.db')
    const owner = await liveContext({ path, keysPath })
    await searchSessions(owner, { query: 'needle' })
    await (owner.sessionQuery as SqliteSessionQueryEngine).close()
    expect(userTables(keysPath)).toEqual(['key_state', 'persisted_doc_keys'])
    await expect(stat(`${path}.keys.db`)).rejects.toMatchObject({ code: 'ENOENT' })

    const outdated = new DatabaseSync(keysPath)
    outdated.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION + 1}`)
    outdated.close()
    const reset = await liveContext({ path, keysPath })
    await searchSessions(reset, { query: 'needle' })
    await (reset.sessionQuery as SqliteSessionQueryEngine).close()
    const resetKeys = new DatabaseSync(keysPath)
    expect(resetKeys.prepare('PRAGMA user_version').get()).toEqual({ user_version: SESSION_QUERY_SQLITE_KEYS_SCHEMA_VERSION })
    resetKeys.close()

    await expect(liveContext({ path, keysPath: path })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    const foreignPath = await temporaryPath('foreign.keys.db')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('PRAGMA application_id = 123')
    foreign.close()
    await expect(liveContext({ path, keysPath: foreignPath })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    const augmented = new DatabaseSync(keysPath)
    augmented.exec('CREATE TABLE unrelated(value TEXT)')
    augmented.close()
    await expect(liveContext({ path, keysPath })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    const canonicalPath = await temporaryPath('canonical.keys.db')
    const canonical = new DatabaseSync(canonicalPath)
    canonical.exec('CREATE TABLE canonical(value TEXT)')
    canonical.close()
    await expect(liveContext({ path, keysPath: canonicalPath })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(() => new SqliteSessionQueryEngine(new Context(), { path, keysPath: ' ' }))
      .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
  })
})

import { watchFile, unwatchFile } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

type ResourceKind = 'none' | 'watcher' | 'fetch' | 'both'

interface Retired {
  agent: WeakRef<Agent>
  session: WeakRef<Session>
}

class SharedResources {
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer((_request, response) => { response.end('ok') })
  private watching = false
  private agents: AgentRegistry | undefined
  private change: PromiseWithResolvers<SessionId | undefined> | undefined
  private readonly onFileChange = (): void => {
    this.change?.resolve(this.agents?.currentInitiator()?.session.id)
  }
  private url = ''

  constructor(private readonly path: string) {
    this.server.keepAliveTimeout = 60_000
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
  }

  async prepare(): Promise<void> {
    await writeFile(this.path, 'watched')
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('missing TCP address')
    this.url = `http://127.0.0.1:${address.port}/`
  }

  async start(kind: ResourceKind, agents: AgentRegistry): Promise<void> {
    this.agents = agents
    if (kind === 'watcher' || kind === 'both') {
      watchFile(this.path, { persistent: false, interval: 50 }, this.onFileChange)
      this.watching = true
    }
    if (kind === 'fetch' || kind === 'both') {
      // Native fetch lazily creates an undici Client/Pool and keep-alive socket.
      const response = await fetch(this.url)
      if (await response.text() !== 'ok') throw new Error('unexpected HTTP response')
      if (this.sockets.size !== 1) throw new Error('keep-alive socket missing')
    }
  }

  assertAlive(kind: ResourceKind): void {
    if (kind === 'fetch' || kind === 'both') {
      expect(this.sockets.size).toBe(1)
      expect([...this.sockets].every(socket => !socket.destroyed)).toBe(true)
    }
  }

  async expectWatcherCallback(): Promise<void> {
    if (!this.watching) return
    const change = Promise.withResolvers<SessionId | undefined>()
    this.change = change
    const timeout = setTimeout(() => change.reject(new Error('StatWatcher did not observe the file change')), 2_000)
    try {
      const [, initiator] = await Promise.all([appendFile(this.path, 'changed'), change.promise])
      expect(initiator, 'settled watcher callback must not inherit an Agent').toBeUndefined()
    } finally {
      clearTimeout(timeout)
      this.change = undefined
    }
  }

  async dispose(): Promise<void> {
    if (this.watching) unwatchFile(this.path, this.onFileChange)
    if (this.server.listening) {
      const closed = new Promise<void>((resolve, reject) => {
        this.server.close(error => error ? reject(error) : resolve())
      })
      this.server.closeAllConnections()
      await closed
    }
  }
}

async function harness(root: string, driverResources?: SharedResources): Promise<Context> {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], new MockAdapter(driverResources ? [
      toolCallResponse('create-shared', 'create-shared-resources', {}),
      textResponse('done'),
    ] : []))
    if (driverResources) {
      ctx.tools.register(defineContentToolFixture({
        name: 'create-shared-resources',
        description: 'Create shared test resources',
        parameters: {},
        execute: async () => {
          if (!ctx.agents.currentInitiator()) throw new Error('tool has no initiating Agent')
          await driverResources.start('both', ctx.agents)
          return [{ type: 'text', text: 'ready' }]
        },
      }))
    }
    return ctx
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

async function retire(
  ctx: Context,
  sessionId: SessionId,
  resources: SharedResources,
  kind: ResourceKind,
  resume = false,
  drive = false,
): Promise<Retired> {
  const handle = resume
    ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
    : await ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      seed: [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    })
  try {
    if (drive) {
      const idle = new Promise<void>((resolve) => {
        const off = ctx.on('agent/status', ({ agent, status }) => {
          if (agent === handle.agent && status === 'idle') { off(); resolve() }
        })
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'create shared resources' }],
        source: { kind: 'user' },
      }))
      await idle
    } else {
      await ctx.agents.withInitiator(handle.agent, () => resources.start(kind, ctx.agents))
    }
    return { agent: new WeakRef(handle.agent), session: new WeakRef(handle.agent.session) }
  } finally {
    await handle.dispose()
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
  }
}

async function expectCollected(retired: readonly Retired[]): Promise<void> {
  setFlagsFromString('--expose-gc')
  const gc: () => void = runInNewContext('gc')
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      // WeakRef.deref() keeps its target alive until the current job ends.
      await setImmediate()
      gc()
      await setImmediate()
      if (retired.every(ref => ref.agent.deref() === undefined && ref.session.deref() === undefined)) return
    }
    const retained = retired.map(ref => ({
      agent: ref.agent.deref() !== undefined,
      session: ref.session.deref() !== undefined,
    }))
    expect(retained, 'retired Agent and Session must be collectible while shared resources remain open')
      .toEqual(retired.map(() => ({ agent: false, session: false })))
  } finally {
    setFlagsFromString('--no-expose-gc')
  }
}

describe('initiator retention by shared native resources', () => {
  it.each(['none', 'watcher', 'fetch'] as const)('collects retired Agent and Session with resource mode %s', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-initiator-retention-'))
    const resources = new SharedResources(join(root, 'watched'))
    let ctx: Context | undefined
    try {
      await resources.prepare()
      ctx = await harness(root)
      const retired = await retire(ctx, SessionId('retired'), resources, kind)
      resources.assertAlive(kind)
      await expectCollected([retired])
      await resources.expectWatcherCallback()
      resources.assertAlive(kind)
    } finally {
      try { await ctx?.fiber.dispose() } finally {
        try { await resources.dispose() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })

  it('collects a retired driver after its tool lazily creates shared resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-initiator-driver-'))
    const resources = new SharedResources(join(root, 'watched'))
    let ctx: Context | undefined
    try {
      await resources.prepare()
      ctx = await harness(root, resources)
      const retired = await retire(ctx, SessionId('driver'), resources, 'both', false, true)
      resources.assertAlive('both')
      await expectCollected([retired])
      await resources.expectWatcherCallback()
      resources.assertAlive('both')
    } finally {
      try { await ctx?.fiber.dispose() } finally {
        try { await resources.dispose() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })

  it('does not accumulate old instances across repeated resumes of one session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-initiator-resume-'))
    const resources: SharedResources[] = []
    let ctx: Context | undefined
    try {
      ctx = await harness(root)
      const retired: Retired[] = []
      for (let index = 0; index < 4; index += 1) {
        const shared = new SharedResources(join(root, `watched-${index}`))
        resources.push(shared)
        await shared.prepare()
        retired.push(await retire(ctx, SessionId('same-session'), shared, 'both', index !== 0))
      }
      for (const shared of resources) shared.assertAlive('both')
      await expectCollected(retired)
      await Promise.all(resources.map(shared => shared.expectWatcherCallback()))
      for (const shared of resources) shared.assertAlive('both')
    } finally {
      try { await ctx?.fiber.dispose() } finally {
        try { await Promise.all(resources.map(shared => shared.dispose())) } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    }
  })
})

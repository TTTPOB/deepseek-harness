/** Opt-in plain-Node diagnostics; no CI thresholds or real Harness state. */

import { deepStrictEqual } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { Session as InspectorSession } from 'node:inspector'
import { availableParallelism, cpus, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage, freezeMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionSeq as Seq } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision, SessionReadOnlyError, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine from '../src/index.ts'
import type { SessionEventTrace, SessionSurfaceSnapshot } from '../src/index.ts'
import { SessionCorpus } from '../src/corpus.ts'

const BASELINE = '1963494328'
const ACTIVITIES = 500
const ITERATIONS = 40
const SAMPLES = 5
const PHASES = ['cold-first', 'cold-repeat', 'live-first', 'live-append', 'live-static'] as const
const OPERATIONS = ['surface', 'trace'] as const
const BACKENDS = ['baseline', 'incremental'] as const

type Phase = typeof PHASES[number]
type Operation = typeof OPERATIONS[number]
type Backend = typeof BACKENDS[number]
type LegacyTracing = {
  currentSurfaceEvents: (id: SessionId, events: readonly SessionEvent[]) => SessionSurfaceSnapshot['events']
  traceEvent: (id: SessionId, events: readonly SessionEvent[], seq: Seq) => SessionEventTrace
}

class DiagnosticQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('search is not measured')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('search is not measured')) }
}

/** Append one complete activity; checkpoints keep the current surface bounded. */
function appendActivity(session: Session, index: number, nodes: Seq[]): void {
  const turn = index + 1
  const callId = ToolCallId(`read-${index}`)
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  nodes.push(session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'Question and context. '.repeat(24) }],
  }), { surfaceOp: 'append' }).seq)
  nodes.push(session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'synthetic', model: 'synthetic' },
    content: [{ type: 'text', text: 'Inspect the relevant file.' }, { type: 'tool-call', id: callId, name: 'read', arguments: JSON.stringify({ path: 'file.ts' }) }],
  }) }, { surfaceOp: 'append' }).seq)
  session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: JSON.stringify({ path: 'file.ts' }) })
  const result = session.append('tool/result', { turn, step: 1, message: createToolResultMessage({
    callId, isError: false, content: [{ type: 'text', text: 'Synthetic tool output. '.repeat(180) }],
  }) }, { surfaceOp: 'append' })
  const diagnostic = session.append('assistant/attempt', { turn, step: 1, stream: [] })
  const pruned = session.append('tool/result', { ...result.data, message: freezeMessage({
    ...result.data.message, content: [{ type: 'text', text: 'Selected result lines. '.repeat(8) }],
  }) }, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq, diagnostic.seq] })
  nodes.push(pruned.seq)
  nodes.push(session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Follow-up.' }] }), {
    surfaceOp: 'append', sourceEventSeqs: [pruned.seq, diagnostic.seq],
  }).seq)
  if (turn % 25 === 0) {
    const checkpoint = session.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'Checkpoint facts. '.repeat(32) }],
    }), {
      surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes.at(-1)! },
      sourceEventSeqs: [...nodes, diagnostic.seq],
    })
    nodes.splice(0, nodes.length, checkpoint.seq)
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function fixture(activities: number): { header: SessionHeader; events: readonly SessionEvent[]; nodes: Seq[] } {
  const session = Session.create(SessionId('synthetic-query-perf'))
  const nodes: Seq[] = []
  for (let index = 0; index < activities; index++) appendActivity(session, index, nodes)
  return { header: session.header, events: session.snapshotEvents(), nodes }
}

async function createRunner(
  phase: Phase, operation: Operation, backend: Backend, path: string,
  data: ReturnType<typeof fixture>, legacy: LegacyTracing, cloning?: { stage: 'source' | 'final' },
) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const provider: Pick<SessionPersistence, 'identity' | 'stat' | 'open'> = {
    identity: Symbol('synthetic-file-provider'),
    stat: () => Promise.resolve({ header: structuredClone(data.header), revision: SessionPersistenceRevision('fixed-revision') }),
    open: (_id, access) => Promise.resolve({
      id: data.header.id, header: structuredClone(data.header), access, inheritedEventCount: SessionLogOffset(0),
      read: async () => ({ eventState: 'detached' as const,
        events: validateStoredEvents(data.header, JSON.parse(await readFile(path, 'utf8')) as SessionEvent[]),
      }),
      append: () => Promise.reject(new SessionReadOnlyError(data.header.id, 'append')),
      flush: () => Promise.reject(new SessionReadOnlyError(data.header.id, 'flush')),
      close: () => Promise.resolve(), [Symbol.asyncDispose]: () => Promise.resolve(),
    }),
  }
  ctx.provide('sessionPersistence', provider as SessionPersistence)
  await ctx.plugin(DiagnosticQuery)
  const corpus = new SessionCorpus(ctx, 4)
  const live = phase.startsWith('live') ? ctx.sessions.create(data.header.id, {
    seed: data.events, meta: { createdAt: data.header.createdAt },
  }) : undefined
  const nodes = [...data.nodes]
  const query = async () => {
    if (cloning !== undefined) cloning.stage = backend === 'baseline' ? 'source' : 'final'
    if (backend === 'incremental') {
      return operation === 'surface' ? ctx.sessionQuery.readSurface(data.header.id)
        : ctx.sessionQuery.traceEvent({ sessionId: data.header.id, seq: SessionSeq(5) })
    }
    const loaded = await corpus.load(data.header.id)
    if (cloning !== undefined) cloning.stage = 'final'
    return operation === 'surface' ? {
      session: structuredClone(loaded.header), inheritedEventCount: loaded.inheritedEventCount,
      capturedThroughSeq: loaded.events.at(-1)?.seq ?? null, events: legacy.currentSurfaceEvents(data.header.id, loaded.events),
    } : { session: loaded.header, ...legacy.traceEvent(data.header.id, loaded.events, SessionSeq(5)) }
  }
  return {
    query,
    next: async (index: number) => {
      if (phase === 'live-append') appendActivity(live!, ACTIVITIES + index, nodes)
      return query()
    },
    dispose: () => ctx.fiber.dispose(),
  }
}

function collectGc(): number {
  if (globalThis.gc === undefined) throw new Error('run the bundled worker with --expose-gc')
  globalThis.gc()
  globalThis.gc()
  return process.memoryUsage().heapUsed
}

async function timeSample(phase: Phase, operation: Operation, backend: Backend, path: string,
  data: ReturnType<typeof fixture>, legacy: LegacyTracing) {
  const runner = await createRunner(phase, operation, backend, path, data, legacy)
  try {
    const beforePrime = collectGc()
    if (phase === 'cold-repeat' || phase === 'live-append' || phase === 'live-static') await runner.query()
    const before = collectGc()
    const count = phase.endsWith('first') ? 1 : ITERATIONS
    const cpu = process.cpuUsage()
    const started = performance.now()
    let last: unknown
    for (let index = 0; index < count; index++) last = await runner.next(index)
    const wallMs = performance.now() - started
    const used = process.cpuUsage(cpu)
    const heapBeforeGc = process.memoryUsage().heapUsed
    const retained = collectGc()
    // Keep exactly one final output alive through the retained measurement.
    if (last === undefined) throw new Error('measurement did not produce a response')
    return { count, wallMs, cpuMs: (used.user + used.system) / 1000,
      netHeapBeforeGcBytes: heapBeforeGc - before, retainedAddedBytes: retained - beforePrime,
      primedRetainedBytes: before - beforePrime }
  } finally { await runner.dispose() }
}

async function allocationSample(phase: Phase, operation: Operation, backend: Backend, path: string,
  data: ReturnType<typeof fixture>, legacy: LegacyTracing) {
  const runner = await createRunner(phase, operation, backend, path, data, legacy)
  const inspector = new InspectorSession()
  inspector.connect()
  try {
    if (phase === 'cold-repeat' || phase === 'live-append' || phase === 'live-static') await runner.query()
    collectGc()
    await new Promise<void>((done, fail) => {
      inspector.post('HeapProfiler.startSampling', { samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      }, (error) => { if (error === null) done(); else fail(error) })
    })
    const count = phase.endsWith('first') ? 1 : ITERATIONS
    for (let index = 0; index < count; index++) await runner.next(index)
    return await new Promise<number>((done, fail) => {
      inspector.post('HeapProfiler.stopSampling', (error, response) => {
        if (error !== null) { fail(error); return }
        let bytes = 0
        const pending = [response.profile.head]
        for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
          bytes += node.selfSize
          pending.push(...node.children)
        }
        done(bytes)
      })
    })
  } finally { inspector.disconnect(); await runner.dispose() }
}

async function cloneSample(phase: Phase, operation: Operation, backend: Backend, path: string,
  data: ReturnType<typeof fixture>, legacy: LegacyTracing) {
  const tracking = { stage: 'final' as 'source' | 'final' }
  const runner = await createRunner(phase, operation, backend, path, data, legacy, tracking)
  const nativeClone = globalThis.structuredClone
  const counts = { sourceEventClones: 0, sourceEventJsonBytes: 0, finalEventClones: 0, finalEventJsonBytes: 0,
    otherCloneCalls: 0, finalResponseJsonBytes: 0 }
  try {
    if (phase === 'cold-repeat' || phase === 'live-append' || phase === 'live-static') await runner.query()
    globalThis.structuredClone = <Value>(value: Value, options?: StructuredSerializeOptions): Value => {
      if (typeof value === 'object' && value !== null && 'seq' in value && 'type' in value) {
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (tracking.stage === 'source') { counts.sourceEventClones += 1; counts.sourceEventJsonBytes += bytes }
        else { counts.finalEventClones += 1; counts.finalEventJsonBytes += bytes }
      } else counts.otherCloneCalls += 1
      return nativeClone(value, options)
    }
    const count = phase.endsWith('first') ? 1 : ITERATIONS
    for (let index = 0; index < count; index++) {
      counts.finalResponseJsonBytes += Buffer.byteLength(JSON.stringify(await runner.next(index)))
    }
    return counts
  } finally { globalThis.structuredClone = nativeClone; await runner.dispose() }
}

async function worker(): Promise<void> {
  const [phase, operation, backend] = process.argv.slice(3) as [Phase, Operation, Backend]
  const dir = dirname(fileURLToPath(import.meta.url))
  const legacy = await import(pathToFileURL(join(dir, 'baseline-tracing.mjs')).href) as LegacyTracing
  const path = join(dir, `fixture-${process.pid}.json`)
  const data = fixture(ACTIVITIES)
  await writeFile(path, JSON.stringify(data.events))
  try {
    // Warm functions on a small independent owner, leaving the measured owner cold.
    const small = fixture(25)
    const warmPath = join(dir, `warm-${process.pid}.json`)
    await writeFile(warmPath, JSON.stringify(small.events))
    const before = await createRunner('cold-first', operation, 'baseline', warmPath, small, legacy)
    const after = await createRunner('cold-first', operation, 'incremental', warmPath, small, legacy)
    try {
      for (let index = 0; index < 3; index++) deepStrictEqual(await before.query(), await after.query())
    } finally { await before.dispose(); await after.dispose(); await rm(warmPath) }
    const timing = await timeSample(phase, operation, backend, path, data, legacy)
    const diagnostics = process.argv.includes('--diagnostics') ? {
      sampledAllocatedBytes: await allocationSample(phase, operation, backend, path, data, legacy),
      clones: await cloneSample(phase, operation, backend, path, data, legacy),
    } : undefined
    process.stdout.write(JSON.stringify({ phase, operation, backend, eventCount: data.events.length,
      logJsonBytes: Buffer.byteLength(JSON.stringify(data.events)), timing, diagnostics }) + '\n')
  } finally { await rm(path) }
}

async function main(): Promise<void> {
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const root = resolve(packageDir, '../../..')
  await mkdir(join(packageDir, 'tmp'), { recursive: true })
  const dir = await mkdtemp(join(packageDir, 'tmp/query-analysis-'))
  const original = execFileSync('git', ['show', `${BASELINE}:packages/session-query/session-query/src/tracing.ts`],
    { cwd: root, encoding: 'utf8' })
  const baselinePath = join(dir, 'baseline-tracing.ts')
  await writeFile(baselinePath, original.replaceAll("'./config.ts'", JSON.stringify(join(packageDir, 'src/config.ts')))
    .replaceAll("'./types.ts'", JSON.stringify(join(packageDir, 'src/types.ts'))))
  const { build } = await import('tsdown')
  const ts = await import('typescript')
  await build({ config: false, entry: { worker: fileURLToPath(import.meta.url), 'baseline-tracing': baselinePath },
    outDir: dir, format: 'esm', platform: 'node', target: 'node24', tsconfig: join(root, 'tsconfig.base.json'),
    deps: { alwaysBundle: [/^@deepseek-ai\//], neverBundle: ['tsdown', 'typescript'], onlyBundle: false },
    plugins: [{ name: 'diagnostic-source-runtime', transform(code, id) {
      if (id.endsWith('/llm/llm/src/attribution.ts')) {
        return code.replace("createRequire(import.meta.url)('../package.json')",
          `createRequire(import.meta.url)(${JSON.stringify(resolve(dirname(id), '../package.json'))})`)
      }
      if (!id.endsWith('.ts') || !/^\s*@[A-Za-z_$]/m.test(code)) return
      return ts.transpileModule(code, { compilerOptions: {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
      } }).outputText
    } }], dts: false, clean: false,
  })
  const samples = []
  for (const phase of PHASES) for (const operation of OPERATIONS) for (let sample = 0; sample < SAMPLES; sample++) {
    // Alternate order across samples to reduce fixed first-run bias.
    const backends = sample % 2 === 0 ? BACKENDS : [...BACKENDS].reverse()
    for (const backend of backends) {
      console.error(`${phase} ${operation} ${backend} ${sample + 1}/${SAMPLES}`)
      const result = spawnSync(process.execPath, ['--expose-gc', join(dir, 'worker.mjs'), '--sample', phase, operation, backend,
        ...sample === 0 ? ['--diagnostics'] : []], { cwd: root, encoding: 'utf8', timeout: 180000 })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0) throw new Error(`benchmark worker failed: ${result.signal ?? result.status}: ${result.stderr}`)
      samples.push(JSON.parse(result.stdout) as object)
    }
  }
  const report = { node: process.version, platform: process.platform, release: release(), arch: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: availableParallelism(), totalMemoryBytes: totalmem(), baseline: BASELINE,
    activities: ACTIVITIES, iterations: ITERATIONS, samplesPerCell: SAMPLES, samples }
  const output = join(dir, 'results.json')
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`Results: ${output}`)
}

if (process.argv[2] === '--sample') await worker()
else await main()

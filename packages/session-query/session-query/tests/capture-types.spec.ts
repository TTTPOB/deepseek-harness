/** Compile the public capture API against the real source types, without emitting files. */
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('accepts synchronous reads and rejects writes and async capture callbacks', { timeout: 60_000 }, () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const probe = resolve(import.meta.dirname, '__capture_type_probe.ts')
  const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), path => ts.sys.readFile(path))
  if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  const options: ts.CompilerOptions = {
    ...parsed.options, composite: false, incremental: false, noEmit: true,
    declaration: false, declarationMap: false, rewriteRelativeImportExtensions: false,
  }
  const source = `
import { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionCaptureReader } from '@deepseek-ai/dsh-session-query'
import type { MessageId } from '@deepseek-ai/dsh-llm'
declare const query: SessionQueryEngine
declare const completeSession: Session
const narrowed: SessionCaptureReader = completeSession
const schemaParameters: NonNullable<NonNullable<ReturnType<SessionCaptureReader['requestHeader']>>['tools']>[number]['parameters'] = { arbitrary: undefined }
void [narrowed, schemaParameters]
const id = SessionId('capture-types')
const result: Promise<{ seq: number; count: number }> = query.captureSession(id, (reader, observation) => {
  const typed: SessionCaptureReader = reader
  const node = typed.surface.nodes[0]
  const event = observation.readEvents(SessionLogOffset(0), typed.seq)[0]
  const message = event === undefined ? null : typed.deriveEventMessage(event)
  if (message) {
    const brandedId: MessageId = message.id
    const textId: string = message.id
    void [brandedId, textId]
    // @ts-expect-error -- Interpreted message content is a readonly collection.
    message.content.push({ type: 'text', text: 'changed' })
    const first = message.content[0]
    if (first?.type === 'text') {
      // @ts-expect-error -- Interpreted message blocks are deeply readonly.
      first.text = 'changed'
    }
  }
  const header = typed.requestHeader()
  const context = typed.requestContext()
  const full = typed as Session
  void [node, message, header, context, full, typed.id, typed.header, typed.inheritedEventCount,
    typed.surface.replaceGeneration, typed.surface.contentGeneration]
  return { seq: typed.seq, count: typed.surface.nodes.length }
}, { projectionMode: 'none' })
void result
// @ts-expect-error -- A capture callback must finish without yielding.
query.captureSession(id, async () => ({ value: 1 }))
// @ts-expect-error -- Thenables are asynchronous callback results too.
query.captureSession(id, () => Promise.resolve(1))
query.captureSession(id, reader => {
  // @ts-expect-error -- Session mutators are not part of the reading view.
  reader.append('turn/start', { turn: 1 })
  // @ts-expect-error -- The surface reference cannot be reassigned.
  reader.surface = { nodes: [], replaceGeneration: 0, contentGeneration: 0 }
  // @ts-expect-error -- Node collections cannot grow through the reading view.
  reader.surface.nodes.push(SessionSeq(0))
  // @ts-expect-error -- Node positions cannot be reassigned.
  reader.surface.nodes[0] = SessionSeq(0)
  // @ts-expect-error -- Generations cannot be reassigned.
  reader.surface.contentGeneration = 0
  // @ts-expect-error -- Immutable identity cannot be reassigned.
  reader.header.cwd = '/elsewhere'
  const header = reader.requestHeader()
  if (header) {
    // @ts-expect-error -- Nested request config is readonly.
    header.config.provider = 'changed'
    // @ts-expect-error -- Tool collections are readonly.
    header.tools?.push({ name: 'changed', description: '', parameters: {} })
  }
  const context = reader.requestContext()
  if (context) {
    // @ts-expect-error -- Resolved route metadata is readonly.
    context.model = 'changed'
  }
  return undefined
})
`
  const host = ts.createCompilerHost(options, true)
  const originalRead = host.readFile.bind(host)
  const originalExists = host.fileExists.bind(host)
  host.readFile = path => path === probe ? source : originalRead(path)
  host.fileExists = path => path === probe || originalExists(path)
  host.getSourceFile = (path, version) => {
    const text = host.readFile(path)
    return text === undefined ? undefined : ts.createSourceFile(path, text, version, true)
  }
  const program = ts.createProgram([probe], options, host)
  // Vendored projects have their own compiler options; this strict source probe checks Harness and consumer code.
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(diagnostic =>
    diagnostic.file === undefined || !diagnostic.file.fileName.replaceAll('\\', '/').startsWith(root + '/vendor/'))
  expect(diagnostics, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  })).toHaveLength(0)
})

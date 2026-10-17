import { describe, expect, it } from 'vitest'
import {
  Session, SessionId, SessionLogOffset, SessionSeq, SurfaceFoldAccumulator, deriveEventMessage, foldSurface,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent, SurfaceFoldReplacement } from '@deepseek-ai/dsh-session'
import { SurfaceManager } from '@deepseek-ai/dsh-session/surface'
import {
  createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage, freezeMessage, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { imageOffloadProjection } from '@deepseek-ai/dsh-compaction-image-offload/projection'

/** One prefix exercises historical headers, positional order, projections, and replacement attribution. */
function mixedHistory(): readonly SessionEvent[] {
  const session = Session.create(SessionId('accumulator-prefixes'), undefined, undefined, undefined, [imageOffloadProjection])
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
  const header = session.append('request/header', {
    reason: 'initial', header: {
      config: { provider: 'test', model: 'test' }, tools: [{ name: 'read', description: 'Read', parameters: {} }],
    },
  })
  const developer = session.append('developer/message', {
    turn: 1, step: 1, headerSeq: header.seq,
    message: createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: 'read' }] }),
  }, { surfaceOp: 'append' })
  const image = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'images' },
    ...['first', 'second'].map(name => ({
      type: 'image' as const,
      attachment: { attachmentId: `sha256:${'a'.repeat(64)}` as never, name, mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
    })),
  ] }), { surfaceOp: 'append' })
  const result = session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('read'), content: [{ type: 'text', text: 'original' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [0] }] })
  const diagnostic = session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  const rewrite = session.append('tool/result', {
    ...result.data, message: freezeMessage({ ...result.data.message, content: [{ type: 'text', text: 'pruned' }] }),
  }, {
    surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq, diagnostic.seq],
  })
  session.append('image/offload', { targets: [{ seq: image.seq, imageIndexes: [1] }] })
  const checkpoint = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] }), {
    surfaceOp: { op: 'replace', startSeq: developer.seq, endSeq: rewrite.seq },
    sourceEventSeqs: [developer.seq, image.seq, rewrite.seq, diagnostic.seq],
  })
  const revised = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'revised summary' }] }), {
    surfaceOp: { op: 'replace', startSeq: checkpoint.seq, endSeq: checkpoint.seq }, sourceEventSeqs: [checkpoint.seq, diagnostic.seq],
  })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [] }), {
    surfaceOp: 'append', sourceEventSeqs: [revised.seq, diagnostic.seq],
  })
  return session.snapshotEvents()
}

describe('SurfaceFoldAccumulator', () => {
  it('matches complete replay and the live manager at every prefix without copying event payloads', () => {
    const events = mixedHistory()
    const prefix: SessionEvent[] = []
    const accumulator = new SurfaceFoldAccumulator([imageOffloadProjection])
    const manager = new SurfaceManager(prefix, undefined, [imageOffloadProjection])
    const replacements: SurfaceFoldReplacement[] = []
    const saved: SurfaceFoldReplacement[] = []
    expect(accumulator.nextSeq).toBe(0)
    expect(accumulator.nodes).toEqual(foldSurface(prefix).nodes)

    for (const event of events) {
      prefix.push(event)
      const replacement = accumulator.append(event, prefix)
      if (replacement !== undefined) {
        replacements.push(replacement)
        saved.push({ ...replacement, shadowedSeqs: [...replacement.shadowedSeqs] })
      }
      const complete = foldSurface(prefix, [imageOffloadProjection])
      expect(accumulator.nextSeq).toBe(prefix.length)
      expect(accumulator.nodes).toEqual(complete.nodes)
      expect(accumulator.nodes).toEqual(manager.nodes)
      expect(accumulator.projectedMessages).toEqual(complete.projectedMessages)
      expect(replacements).toEqual(complete.replacements)
      expect(replacements).toEqual(saved)
      for (const seq of accumulator.nodes) {
        const original = prefix[seq]!
        expect(original).toBe(events[seq])
        const message = deriveEventMessage(original, accumulator.projectedMessages)
        expect(message).toEqual(manager.deriveEventMessage(original))
        if (!accumulator.projectedMessages.has(seq)) expect(message).toBe(deriveEventMessage(original))
      }
      if (event.type === 'image/offload') {
        const projected = accumulator.projectedMessages.get(SessionSeq(3))!
        expect(projected.content.filter(block => block.type === 'image' && block.offloaded === true))
          .toHaveLength(event.seq === 5 ? 1 : 2)
        expect(events[3]).toMatchObject({ data: { content: [
          { type: 'text' }, { type: 'image' }, { type: 'image' },
        ] } })
      }
    }
    expect(accumulator.nodes).toEqual([0, 10, 11])
    expect(replacements).toEqual([
      { seq: 7, start: 4, end: 4, shadowedSeqs: [4] },
      { seq: 9, start: 2, end: 7, shadowedSeqs: [2, 3, 7] },
      { seq: 10, start: 9, end: 9, shadowedSeqs: [9] },
    ])
    expect(deriveEventMessage(events[0]!)).toBeNull()
  })

  it('keeps the accepted prefix on missing or invalid projections and can retry the next event', () => {
    const events = mixedHistory()
    const missing = new SurfaceFoldAccumulator()
    const accumulator = new SurfaceFoldAccumulator([imageOffloadProjection])
    for (const event of events.slice(0, 5)) {
      missing.append(event, events)
      accumulator.append(event, events)
    }
    const nodes = [...accumulator.nodes]
    expect(() => missing.append(events[5]!, events)).toThrow(/requires a message projection/)
    expect(missing.nextSeq).toBe(5)
    expect(missing.nodes).toEqual(nodes)
    const invalid: SessionEvent<'image/offload'> = {
      type: 'image/offload', seq: SessionSeq(5), time: 5,
      data: { targets: [{ seq: SessionSeq(3), imageIndexes: [0] }, { seq: SessionSeq(4), imageIndexes: [0] }] },
    }
    expect(() => accumulator.append(invalid, events)).toThrow(/image index 0 does not exist/)
    expect(accumulator.nextSeq).toBe(SessionLogOffset(5))
    expect(accumulator.nodes).toEqual(nodes)
    expect(accumulator.projectedMessages.size).toBe(0)
    expect(accumulator.append(events[5]!, events)).toBeUndefined()
    expect(accumulator.nextSeq).toBe(6)
    expect(accumulator.projectedMessages.size).toBe(1)
  })
})

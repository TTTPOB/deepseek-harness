import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { mountRuntime } from './setup.ts'

describe.each(['per-call', 'persistent-in-memory'] as const)('%s raw text execution', (executionMode) => {
  it('evaluates raw text through the real process bootstrap', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const text = '"quotes\' C:\\temp ${literal} `tick`\nline\n'
    const expression = '@``\n' + text + '``'
    const program = executionMode === 'per-call' ? 'return ' + expression : expression
    expect(await runtime.run(runtime.resolve({ program, bindings: [] }))).toMatchObject({ value: text, logs: [] })
  })

  it('preserves raw-looking text inside an ordinary string through the real bootstrap', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const expression = '"a @``b`` c"'
    const program = executionMode === 'per-call' ? 'return ' + expression : expression
    expect(await runtime.run(runtime.resolve({ program, bindings: [] }))).toMatchObject({ value: 'a @``b`` c', logs: [] })
  })

  it('reports quote errors with source locations in the model-visible failure', async () => {

    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const program = 'const good = @``\ntext``;\nconst command = "ssh h x "$HOME" y";'
    const result = await runtime.run(runtime.resolve({ program, bindings: [] }))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toMatch(/^SyntaxError at 3:27: /)
    expect(result.error?.message).toContain('  3 | ')
    expect(result.error?.message).toContain('const command = "ssh h x "$HOME" y";')
  })

  it('locates the later syntax error rather than a preceding top-level await', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const result = await runtime.run(runtime.resolve({ program: 'await Promise.resolve();\nconst broken = ;', bindings: [] }))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toMatch(/^SyntaxError at 2:16: /)
    expect(result.error?.message).toContain('const broken = ;')
  })

  it('omits a location for TypeScript-only rejection accepted by JavaScript', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const result = await runtime.run(runtime.resolve({ program: 'const octal = 010;', bindings: [] }))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('Legacy octal')
    expect(result.error?.message).not.toContain('SyntaxError at')
  })

  it('returns an unterminated raw literal as a structured exception', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const result = await runtime.run(runtime.resolve({ program: '// heading\n@```not closed', bindings: [] }))
    expect(result.error).toEqual({ kind: 'exception', message: 'SyntaxError at 2:1: Unterminated raw string literal; close it with exactly 3 backticks.\n  2 | @```not closed\n    | ^' })
  })
})

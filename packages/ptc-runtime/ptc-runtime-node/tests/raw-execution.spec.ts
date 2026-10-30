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

  it('reports quote errors with source locations in the model-visible failure', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const program = 'const good = @``\ntext``;\nconst command = "ssh h x "$HOME" y";'
    const result = await runtime.run(runtime.resolve({ program, bindings: [] }))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('Location (JavaScript parse, approximate if TypeScript-only syntax is used):')
    expect(result.error?.message).toContain(executionMode === 'per-call' ? 'run_code:3' : 'ptc-repl:3')
    expect(result.error?.message).toContain('const command = "ssh h x "$HOME" y";')
  })

  it('locates the later syntax error rather than a preceding top-level await', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const result = await runtime.run(runtime.resolve({ program: 'await Promise.resolve();\nconst broken = ;', bindings: [] }))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain(executionMode === 'per-call' ? 'run_code:2' : 'ptc-repl:2')
    expect(result.error?.message).toContain('const broken = ;')
  })

  it('omits a location for TypeScript-only rejection accepted by JavaScript', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const result = await runtime.run(runtime.resolve({ program: 'const octal = 010;', bindings: [] }))
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('Legacy octal')
    expect(result.error?.message).not.toContain('Location')
  })

  it('returns an unterminated raw literal as a structured exception', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode })
    const result = await runtime.run(runtime.resolve({ program: '// heading\n@```not closed', bindings: [] }))
    expect(result.error).toEqual({ kind: 'exception', message: 'Unterminated raw string literal starting on line 2; close it with exactly 3 backticks. To write @`` as text, use \\x40`` in a string or a longer raw delimiter.' })
  })
})

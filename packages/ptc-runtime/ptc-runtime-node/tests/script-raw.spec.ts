import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { prepareProgram } from '../src/program.ts'
import { mountRuntime } from './setup.ts'

describe.each([false, true])('VM Script raw text (retained: %s)', (scriptPersistence) => {
  it('evaluates raw text and awaits the final expression after top-level await', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
    const text = '"quotes\' C:\\temp ${literal} `tick`\nline\n'
    const program = 'const text: string = @``\n' + text + '``;\nawait Promise.resolve();\nPromise.resolve(text)'
    expect(await runtime.run(runtime.resolve({ program, bindings: [] }))).toMatchObject({ value: text, logs: [] })
  })

  it('returns the native final expression without a function wrapper', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
    expect(await runtime.run(runtime.resolve({ program: 'const text: string = @``  native  ``; text.trim()', bindings: [] })))
      .toMatchObject({ value: 'native', logs: [] })
  })

  it('rejects top-level return at its original position without running earlier statements', async () => {
    const { runtime } = await mountRuntime(new Context(), { executionMode: 'vm-script', scriptPersistence })
    const program = 'console.log(@``must not run``);\n  return @``not an expression``'
    const result = await runtime.run(runtime.resolve({ program, bindings: [] }))
    expect(result.logs).toEqual([])
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toMatch(/^SyntaxError at 2:3: /)
    expect(result.error?.message).toContain('  2 |   return @``not an expression``\n    |   ^')
  })
})

describe.each(['function-body', 'repl', 'script'] as const)('%s original-source frames', (format) => {
  it.each([
    ['const f = (r: any) => r;\nconst text = @``\r\nokay``;\r\nconst command = "ssh h x "$HOME" y";', '4:27', '  4 | const command = "ssh h x "$HOME" y";\n    |                           ^'],
    ['const s = @``a\\b ${c}``; const bad = ;', '1:38', '  1 | const s = @``a\\b ${c}``; const bad = ;\n    |                                      ^'],
    ['await Promise.resolve();\nconst broken = ;', '2:16', '  2 | const broken = ;\n    |                ^'],
    ['// heading\n  @```not closed', '2:3', '  2 |   @```not closed\n    |   ^'],
  ])('locates the error in %j', (source, position, frame) => {
    expect(() => prepareProgram(source, format)).toThrow('SyntaxError at ' + position + ':')
    expect(() => prepareProgram(source, format)).toThrow(frame)
  })

  it('does not add an Acorn position to TypeScript-only rejection', () => {
    let message = ''
    try { prepareProgram('const octal = 010;', format) } catch (error: unknown) { message = String(error) }
    expect(message).toContain('Legacy octal')
    expect(message).not.toContain('SyntaxError at')
  })
})

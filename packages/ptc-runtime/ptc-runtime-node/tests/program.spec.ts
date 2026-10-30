import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { prepareProgram, preprocessRawStrings } from '../src/program.ts'

function value(source: string): unknown {
  return new Script(preprocessRawStrings(source)).runInNewContext()
}

describe('raw string literals', () => {
  it('preserves quotes, backslashes, interpolation text, backticks, indentation and trailing newlines', () => {
    const text = '"single\' C:\\tmp ${notEvaluated} `short`\n  indented\n'
    expect(value('@``' + text + '``')).toBe(text)
  })

  it('closes only on a maximal run of exactly the opening width', () => {
    const text = 'one`two```three````four'
    expect(value('@``' + text + '``')).toBe(text)
    expect(value('@`````a``b```c````d`````')).toBe('a``b```c````d')
  })

  it.each(['\n', '\r\n'])('omits exactly one immediate opening newline %j and retains source lines', (newline) => {
    const source = 'const s = @``' + newline + newline + '  content' + newline + '``;\n s'
    const transformed = preprocessRawStrings(source)
    expect(transformed.split('\n')).toHaveLength(source.split('\n').length)
    expect(value(source)).toBe(newline + '  content' + newline)
  })

  it('accepts an empty value after omitting the opening newline', () => {
    expect(value('@``\n``')).toBe('')
  })

  it('does not remove a newline after leading spaces', () => {
    expect(value('@``  \ntext``')).toBe('  \ntext')
  })

  it('preserves CRLF inside content instead of template newline normalization', () => {
    expect(value('@``a\r\nb\r\n``')).toBe('a\r\nb\r\n')
  })

  it('keeps return, member access, and surrounding ASI semantics', async () => {
    const source = 'return @``\n  value  ``.trim()'
    expect(await value('(async () => {' + source + '})()')).toBe('value')
    expect(value('let x = 1\nx = @``\nnext``.length\nx')).toBe(4)
    expect(value('(() => { return\n@``\nignored`` })()')).toBeUndefined()
    expect(value('const x = @``\nvalue``\n; x')).toBe('value')
  })

  it('converts multiple literals without changing following source line numbers', () => {
    const source = '[@``\none``, @```\ntwo``three```]\n'
    expect(value(source)).toEqual(['one', 'two``three'])
    expect(preprocessRawStrings(source).split('\n')).toHaveLength(source.split('\n').length)
  })

  it.each([
    '"@``not closed"',
    "'@``not closed'",
    '`template @``not closed`',
    '// comment @``not closed',
    '/* comment @``not closed */',
    '/@``not closed/',
  ])('recognizes reserved openers regardless of JavaScript context: %s', (source) => {
    expect(() => preprocessRawStrings(source)).toThrow('Unterminated raw string literal starting on line 1; close it with exactly 2 backticks.')
  })

  it('leaves an encoded at-sign unchanged and evaluates it as literal text', () => {
    const source = '"\\x40``"'
    expect(preprocessRawStrings(source)).toBe(source)
    expect(value(source)).toBe('@``')
  })

  it.each(['"', '`'])('recognizes a raw literal after a regex containing %s', (character) => {
    const source = 'const s = ' + JSON.stringify('a' + character + 'b') + '; s.replace(/' + character + '/g, ' + JSON.stringify('') + '); @``after regex``'
    expect(value(source)).toBe('after regex')
  })

  it('retains a shorter reserved opener as content with a longer delimiter', () => {
    expect(value('@```before @`` after```')).toBe('before @`` after')
  })

  it.each(['@decorator class Example {}', '@`single`'])('leaves non-openers unchanged: %s', (source) => {
    expect(preprocessRawStrings(source)).toBe(source)
  })

  it('reports the opening line when no exact closing run exists', () => {
    expect(() => preprocessRawStrings('// header\nconst x = @```text``')).toThrow('Unterminated raw string literal starting on line 2; close it with exactly 3 backticks.')
  })
})

describe('parse diagnostics', () => {
  it.each(['function-body', 'repl'] as const)('locates invalid quotes on the original source line in %s', (format) => {
    const program = 'const text = @``\nokay``;\nconst command = "ssh h x "$HOME" y";'
    expect(() => prepareProgram(program, format)).toThrow('Location (JavaScript parse, approximate if TypeScript-only syntax is used):\n' + (format === 'repl' ? 'ptc-repl' : 'run_code') + ':3\nconst command')
    expect(() => prepareProgram(program, format)).toThrow(/\^+\n\nSyntaxError:/)
  })

  it.each(['function-body', 'repl'] as const)('does not attach a location when JavaScript accepts a TypeScript parser rejection in %s', (format) => {
    let message = ''
    try { prepareProgram('const value = 010;', format) } catch (error: unknown) { message = String(error) }
    expect(message).toContain('Legacy octal')
    expect(message).not.toContain('Location')
  })

  it('marks JavaScript positions as approximate for TypeScript annotations', () => {
    expect(() => prepareProgram('const n: number = 1; const broken = ;', 'function-body')).toThrow('Location (JavaScript parse, approximate if TypeScript-only syntax is used):')
  })

  it('compiles diagnostics without running program side effects', () => {
    expect(() => prepareProgram('throw new Error("MUST_NOT_RUN"); const n = 010;', 'function-body')).toThrow('Legacy octal')
  })

  it('does not attach JavaScript diagnostics to raw-literal errors', () => {
    expect(() => prepareProgram('@``unfinished', 'function-body')).toThrow('Unterminated raw string literal starting on line 1; close it with exactly 2 backticks. To write @`` as text, use \\x40`` in a string or a longer raw delimiter.')
  })
})

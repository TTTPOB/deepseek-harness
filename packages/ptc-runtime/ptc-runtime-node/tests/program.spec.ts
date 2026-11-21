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
  ])('leaves raw-looking text in JavaScript tokens unchanged: %s', (source) => {
    expect(preprocessRawStrings(source)).toBe(source)
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
    expect(() => preprocessRawStrings('// header\nconst x = @```text``')).toThrow('SyntaxError at 2:11: Unterminated raw string literal; close it with exactly 3 backticks.')
  })
})

describe.each(['function-body', 'repl'] as const)('%s parse diagnostics', (format) => {
  it('locates invalid quotes after TypeScript and raw text using original columns', () => {
    const program = 'const f = (r: any) => r;\nconst text = @``\r\nokay``;\r\nconst command = "ssh h x "$HOME" y";'
    expect(() => prepareProgram(program, format)).toThrow('SyntaxError at 4:27:')
    expect(() => prepareProgram(program, format)).toThrow('  4 | const command = "ssh h x "$HOME" y";\n    |                           ^')
  })

  it('locates an error after a raw literal on the same line in original source', () => {
    expect(() => prepareProgram('const s = @``a\\b ${c}``; const bad = ;', format))
      .toThrow('SyntaxError at 1:38:')
  })

  it.each(['const value = 010;', 'enum Direction { Up, Down }'])('keeps only the strip message for TypeScript-only rejection: %s', (program) => {
    let message = ''
    try { prepareProgram(program, format) } catch (error: unknown) { message = String(error) }
    expect(message).toMatch(/Legacy octal|TypeScript enum/)
    expect(message).not.toContain('SyntaxError at')
    expect(message).not.toContain(' | ')
  })

  it('does not duplicate parser messages or add advice', () => {
    let message = ''
    try { prepareProgram('const n: number = 1;\nconst broken = ;', format) } catch (error: unknown) { message = String(error) }
    expect(message).toMatch(/^Error: SyntaxError at 2:16: /)
    expect(message).not.toContain('(2:15)')
    expect(message).not.toMatch(/approximate|Location|run_code|ptc-repl|\\x40/)
    expect(message.split('\n')).toHaveLength(3)
  })

  it('parses diagnostics without running program side effects', () => {
    expect(() => prepareProgram('throw new Error("MUST_NOT_RUN"); const n = 010;', format)).toThrow('Legacy octal')
  })

  it('reports the unterminated opener and exact closing width', () => {
    expect(() => prepareProgram('// header\r\n  @```unfinished', format)).toThrow(
      'SyntaxError at 2:3: Unterminated raw string literal; close it with exactly 3 backticks.\n  2 |   @```unfinished\n    |   ^',
    )
  })

  it('accepts top-level await and uses the selected return semantics', () => {
    expect(prepareProgram('const n: number = await Promise.resolve(1); n', format)).toContain('await Promise.resolve(1)')
    if (format === 'function-body') expect(prepareProgram('return @``ok``', format)).toContain('return `ok`')
    else expect(() => prepareProgram('return @``ok``', format)).toThrow('Return statement is not allowed here')
  })
})

describe('lexer-aware TypeScript recognition', () => {
  it.each([
    'const s = "a @``b`` c"; s',
    "const s = 'a @``b`` c'; s",
    '// @``comment\nconst n: number = 1',
    '/* @``comment`` */ const n = 1',
    'const t = `a @``b`` c`; t',
    'const r = /@``/; r',
    '@decorator class Example {}',
  ])('leaves non-raw source byte-identical: %s', (source) => {
    expect(preprocessRawStrings(source)).toBe(source)
  })

  it.each([
    'const r = /["\']/; const t = @``x``; t',
    'const x = a / 2; const y = b / 3; const t = @``q``; t',
    'const t = `a ${ @``in`` } b`; t',
    'const n: number = 1; function f<T>(x: T): T { return x }; const g = <T,>(x: T) => x; const t = @``hi`` as string; const c = { a: 1 } as const satisfies object; f(g(t))',
    'interface A { x: number }\ntype B = A & { y?: string }\nconst v: B = { x: 1 }; @``v``',
    'import type { A } from "a"; const t: A = @``v``',
    'const r = await tools.read({ file_path: @``a.txt`` }); r',
    'const md = @````\n```js\nx\n```\n````; md',
    'f(@``a``, @``b``)',
    '@decorator class Example { field = @``value`` }',
  ])('recognizes raw tokens among JavaScript and TypeScript: %s', (source) => {
    expect(preprocessRawStrings(source)).not.toContain('@``')
  })

  it('does not silently alter an ordinary quoted string', () => {
    expect(value('"a @``b`` c"')).toBe('a @``b`` c')
  })

  it('falls back when Acorn rejects syntax that type stripping accepts', () => {
    // The supplemental parser checks duplicate declarations; Node's stripper does not.
    const source = 'const x = 1; const x = 2; const t = @``ok``; return t'
    expect(preprocessRawStrings(source + '; "@``text``"')).toContain('"`text`"')
    expect(prepareProgram(source, 'function-body')).toContain('const t = `ok`')
  })

  it('uses outer-first conversion after a supplemental parser failure', () => {
    const source = 'const broken = ; const t = @``ok``'
    expect(preprocessRawStrings(source)).toBe('const broken = ; const t = `ok`')
  })
})

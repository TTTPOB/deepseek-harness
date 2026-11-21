/** Lexer-aware raw text literals and source diagnostics shared by all Node execution modes. */
import { stripTypeScriptTypes } from 'node:module'
import { Parser, getLineInfo, tokTypes, type TokenType } from 'acorn'
import { tsPlugin } from '@sveltejs/acorn-typescript'

const FUNCTION_PREFIX = 'async function __dsh_program__() {\n'
const FUNCTION_SUFFIX = '\n}'

interface RawRange { start: number; bodyStart: number; bodyEnd: number; end: number }

// Acorn's public declarations omit the tokenizer methods used by plugins.
declare class TokenParser extends Parser {
  pos: number
  curLine: number
  lineStart: number
  getTokenFromCode(code: number): void
  finishToken(type: TokenType, value: string): void
}

class UnterminatedRawString extends SyntaxError {
  constructor(readonly start: number, readonly width: number) {
    super(`Unterminated raw string literal; close it with exactly ${width} backticks.`)
  }
}

function readRawRange(source: string, start: number): RawRange {
  let index = start + 1
  while (source[index] === '`') index += 1
  const width = index - start - 1
  const bodyStart = index
  while (index < source.length) {
    if (source[index] !== '`') { index += 1; continue }
    const run = index
    while (source[index] === '`') index += 1
    if (index - run === width) return { start, bodyStart, bodyEnd: run, end: index }
  }
  throw new UnterminatedRawString(start, width)
}

function scanRawStrings(source: string, allowReturnOutsideFunction: boolean): RawRange[] {
  // TS speculative parsing can revisit a token; offsets identify each literal once.
  const ranges = new Map<number, RawRange>()
  const RawParser = Parser.extend(tsPlugin(), (Base) => {
    // The raw plugin must be outermost: the TS plugin treats other at-signs as decorators.
    return class extends (Base as typeof TokenParser) {
      override getTokenFromCode(code: number): void {
        if (code !== 64 || this.input[this.pos + 1] !== '`' || this.input[this.pos + 2] !== '`') {
          super.getTokenFromCode(code)
          return
        }
        const range = readRawRange(this.input, this.pos)
        ranges.set(range.start, range)
        const location = getLineInfo(this.input, range.end)
        this.pos = range.end
        this.curLine = location.line
        this.lineStart = range.end - location.column
        this.finishToken(tokTypes.string, this.input.slice(range.bodyStart, range.bodyEnd))
      }
    }
  })
  RawParser.parse(source, {
    ecmaVersion: 'latest', sourceType: 'script', locations: true,
    // All execution modes allow await. Sloppy script mode preserves legacy octal handling
    // by stripTypeScriptTypes; imports are left to the selected execution mode's stripper.
    allowReturnOutsideFunction, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true,
  })
  return [...ranges.values()].sort((a, b) => a.start - b.start)
}

function outerFirstRanges(source: string): RawRange[] {
  const ranges: RawRange[] = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '@' || source[index + 1] !== '`' || source[index + 2] !== '`') continue
    const range = readRawRange(source, index)
    ranges.push(range)
    index = range.end - 1
  }
  return ranges
}

function replaceRawRanges(source: string, ranges: RawRange[]): string {
  const parts: string[] = []
  let copied = 0
  for (const { start, bodyStart, bodyEnd, end } of ranges) {
    let body = source.slice(bodyStart, bodyEnd)
    let continuation = ''
    if (body.startsWith('\r\n') || body.startsWith('\n')) {
      const size = body[0] === '\r' ? 2 : 1
      continuation = '\\' + body.slice(0, size)
      body = body.slice(size)
    }
    // Template cooking normalizes CR, so encode it explicitly to preserve CRLF text.
    const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r')
    parts.push(source.slice(copied, start), '`', continuation, escaped, '`')
    copied = end
  }
  parts.push(source.slice(copied))
  return parts.join('')
}

function diagnostic(source: string, offset: number, message: string): string {
  const { line, column } = getLineInfo(source, offset)
  const label = String(line)
  const text = source.split(/\r\n|[\n\r\u2028\u2029]/)[line - 1] ?? ''
  const padding = ' '.repeat(label.length)
  return `SyntaxError at ${line}:${column + 1}: ${message}\n  ${label} | ${text}\n  ${padding} | ${' '.repeat(column)}^`
}

function prepareRawStrings(source: string, allowReturnOutsideFunction = true): { program: string; errorOffset?: number | undefined } {
  try {
    return { program: replaceRawRanges(source, scanRawStrings(source, allowReturnOutsideFunction)) }
  } catch (error: unknown) {
    if (error instanceof UnterminatedRawString) throw new SyntaxError(diagnostic(source, error.start, error.message), { cause: error })
    // Acorn is supplemental: a false rejection must not block a program Node accepts.
    const errorOffset = error instanceof SyntaxError && 'pos' in error && typeof error.pos === 'number' ? error.pos : undefined
    try {
      return { program: replaceRawRanges(source, outerFirstRanges(source)), errorOffset }
    } catch (rawError: unknown) {
      if (rawError instanceof UnterminatedRawString) {
        throw new SyntaxError(diagnostic(source, rawError.start, rawError.message), { cause: rawError })
      }
      throw rawError
    }
  }
}

/**
 * Convert raw literals in code tokens to templates, leaving other source bytes unchanged.
 * Acorn/TypeScript recognition preserves strings, comments, regex and template text; a parse
 * failure falls back to outer-first recognition. Initial LF/CRLF omission preserves LF counts and ASI.
 * @param source - Model-written TypeScript before type stripping.
 * @returns Source with recognized raw literals replaced by uninterpolated templates.
 * @throws SyntaxError with the opening position when a raw literal is unterminated.
 */
export function preprocessRawStrings(source: string): string {
  return prepareRawStrings(source).program
}

/**
 * Convert raw text and strip erasable TypeScript for the selected evaluation mode.
 * Strip failures use Acorn's original-source position when available, without its message;
 * TypeScript-only rejections retain only the strip message. No model-written code is executed.
 * @param source - Original model-written program.
 * @param format - Async function body, retained REPL statements, or VM Script statements.
 * @returns JavaScript ready for the existing bootstrap.
 * @throws Error with a task-facing parse message; unterminated raw literals include their opener position.
 */
export function prepareProgram(source: string, format: 'function-body' | 'repl' | 'script'): string {
  const { program, errorOffset } = prepareRawStrings(source, format === 'function-body')
  try {
    if (format !== 'function-body') return stripTypeScriptTypes(program)
    const stripped = stripTypeScriptTypes(FUNCTION_PREFIX + program + FUNCTION_SUFFIX)
    return stripped.slice(FUNCTION_PREFIX.length, stripped.length - FUNCTION_SUFFIX.length)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(errorOffset === undefined ? message : diagnostic(source, errorOffset, message), { cause: error })
  }
}

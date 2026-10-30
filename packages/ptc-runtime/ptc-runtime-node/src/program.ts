/** Raw text literals and task-facing parse diagnostics shared by both Node execution modes. */
import { stripTypeScriptTypes } from 'node:module'
import { Script } from 'node:vm'

const FUNCTION_PREFIX = 'async function __dsh_program__() {\n'
const FUNCTION_SUFFIX = '\n}'

/**
 * Replace @ followed by N >= 2 backticks with an uninterpolated text value.
 * Recognition is outer-first at every source position, without JavaScript lexical analysis.
 * The opener is reserved even inside strings, templates, comments and regex literals.
 * An initial LF/CRLF is omitted using a template line continuation, preserving source lines and ASI.
 * @param source - Model-written TypeScript before type stripping.
 * @returns Source with raw literals converted to ordinary templates and LF counts unchanged.
 * @throws SyntaxError when a raw literal has no maximal closing backtick run of the same length.
 */
export function preprocessRawStrings(source: string): string {
  const parts: string[] = []
  let copied = 0
  let index = 0
  while (index < source.length) {
    const char = source[index]
    if (char !== '@' || source[index + 1] !== '`' || source[index + 2] !== '`') { index += 1; continue }
    const start = index
    index += 1
    while (source[index] === '`') index += 1
    const width = index - start - 1
    const bodyStart = index
    let end = -1
    while (index < source.length) {
      if (source[index] !== '`') { index += 1; continue }
      const run = index
      while (source[index] === '`') index += 1
      if (index - run === width) { end = run; break }
    }
    if (end < 0) {
      const line = source.slice(0, start).split(/\r\n|[\n\r\u2028\u2029]/).length
      throw new SyntaxError(`Unterminated raw string literal starting on line ${line}; close it with exactly ${width} backticks.`
        + ' To write @`` as text, use \\x40`` in a string or a longer raw delimiter.')
    }
    let body = source.slice(bodyStart, end)
    let continuation = ''
    if (body.startsWith('\r\n') || body.startsWith('\n')) {
      const size = body[0] === '\r' ? 2 : 1
      continuation = '\\' + body.slice(0, size)
      body = body.slice(size)
    }
    // Template cooking normalizes CR, so encode it explicitly to preserve CRLF text.
    const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${').replace(/\r/g, '\\r')
    parts.push(source.slice(copied, start), '`', continuation, escaped, '`')
    copied = index
  }
  parts.push(source.slice(copied))
  return parts.join('')
}

function parseLocation(program: string, format: 'function-body' | 'repl'): string {
  // Both evaluation modes accept await; a bare script would hide later errors behind it.
  const code = '(async () => {\n' + program + '\n})()'
  try {
    // Compilation only: diagnostics must never execute model-written code in the host.
    new Script(code, { filename: format === 'function-body' ? 'run_code' : 'ptc-repl', lineOffset: -1 })
  } catch (error: unknown) {
    if (!(error instanceof Error) || !error.stack) return ''
    const lines = error.stack.split('\n')
    const message = lines.findIndex(line => line.startsWith('SyntaxError:'))
    if (message < 0) return ''
    return '\nLocation (JavaScript parse, approximate if TypeScript-only syntax is used):\n' + lines.slice(0, message + 1).join('\n')
  }
  return ''
}

/**
 * Preprocess raw text and strip erasable TypeScript for the selected evaluation mode.
 * TypeScript parse failures retain their message and add a compilation-only JavaScript location when available.
 * Diagnostics compile an async body in both modes so top-level await cannot mask a later error.
 * @param source - Original model-written program.
 * @param format - Async function body or retained REPL statements.
 * @returns JavaScript ready for the existing bootstrap.
 * @throws Error with a task-facing parse message; raw-literal errors include their opening line.
 */
export function prepareProgram(source: string, format: 'function-body' | 'repl'): string {
  const program = preprocessRawStrings(source)
  try {
    if (format === 'repl') return stripTypeScriptTypes(program)
    const stripped = stripTypeScriptTypes(FUNCTION_PREFIX + program + FUNCTION_SUFFIX)
    return stripped.slice(FUNCTION_PREFIX.length, stripped.length - FUNCTION_SUFFIX.length)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message + parseLocation(program, format), { cause: error })
  }
}

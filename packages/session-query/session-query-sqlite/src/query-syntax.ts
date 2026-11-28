/** Parse the search language without passing caller syntax to FTS5. */

import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { quoteFtsData, sanitizeFtsText } from './query.ts'

interface Token {
  kind: 'word' | 'phrase' | 'and' | 'or' | 'open' | 'close' | 'minus'
  text: string
}

type Node =
  | { kind: 'phrase'; expression: string; key: string }
  | { kind: 'and' | 'or'; children: Node[] }
  | { kind: 'not'; include: Node | undefined; exclude: Node }

interface Clause { node: Node; negative: boolean }

/** Safe expressions for matching and scoring on a single FTS5 text column. */
export interface SearchSyntax {
  expression: string
  positivePhrases: readonly string[]
  singlePhrase: boolean
}

/**
 * Compile a normalized user query with uppercase OR binding tighter than AND.
 * @param query - caller text, with surrounding whitespace and NUL already checked.
 * @param tokenKey - returns the indexed token sequence identity, or undefined for no tokens.
 * @returns full FTS expression and one expression per distinct positive phrase.
 */
export function parseSearchQuery(query: string, tokenKey: (text: string) => string | undefined): SearchSyntax {
  const root = new Parser(lex(query), tokenKey).parse()
  if (!hasPositive(root)) {
    throw new SessionQueryError('session-search query needs a positive term', 'SESSION_QUERY_EXCLUSION_ONLY')
  }
  const phrases = new Map<string, string>()
  const expression = compile(root, phrases)
  return { expression, positivePhrases: [...phrases.values()], singlePhrase: root.kind === 'phrase' }
}

function lex(query: string): Token[] {
  const tokens: Token[] = []
  for (const match of query.matchAll(/\s+|"(?:[^"]|"")*"|[()"]|[^\s()"]+/gu)) {
    const [text] = match
    switch (text) {
      case '"': invalid('has an unmatched double quote'); break
      case '(': tokens.push({ kind: 'open', text }); break
      case ')': tokens.push({ kind: 'close', text }); break
      case 'AND': tokens.push({ kind: 'and', text }); break
      case 'OR': tokens.push({ kind: 'or', text }); break
      default:
        if (/^\s/u.test(text)) break
        if (text.startsWith('"')) tokens.push({ kind: 'phrase', text: text.slice(1, -1).replaceAll('""', '"') })
        else if (text.startsWith('-') && (text.length > 1 || /^["(]/u.test(query[match.index + 1] ?? ''))) {
          tokens.push({ kind: 'minus', text: '-' })
          if (text.length > 1) tokens.push({ kind: 'word', text: text.slice(1) })
        } else tokens.push({ kind: 'word', text })
    }
  }
  return tokens
}

class Parser {
  private offset = 0

  constructor(private readonly tokens: readonly Token[], private readonly tokenKey: (text: string) => string | undefined) {}

  parse(): Node {
    const node = this.and(false)
    if (node === undefined) invalid('contains no searchable text')
    return node
  }

  private and(group: boolean): Node | undefined {
    const include: Node[] = []
    const exclude: Node[] = []
    for (;;) {
      const kind = this.tokens[this.offset]?.kind
      if (kind === 'close' || kind === undefined) {
        if ((kind === 'close') !== group) invalid('has an unmatched parenthesis')
        if (group) this.offset++
        break
      }
      if (kind === 'and') {
        this.offset++
        continue
      }
      const part = this.or()
      if (part !== undefined) (part.negative ? exclude : include).push(part.node)
    }
    const positive = include.length === 0 ? undefined : combine('and', include)
    return exclude.length === 0 ? positive : { kind: 'not', include: positive, exclude: combine('or', exclude) }
  }

  private or(): Clause | undefined {
    const first = this.clause()
    if (this.tokens[this.offset]?.kind !== 'or') return first
    const branches = first === undefined ? [] : [first]
    while (this.tokens[this.offset]?.kind === 'or') {
      this.offset++
      const branch = this.clause()
      if (branch !== undefined) branches.push(branch)
    }
    if (branches.length === 0) return undefined
    if (branches.length === 1) return branches[0]
    return {
      node: combine('or', branches.map(({ node, negative }) => negative
        ? { kind: 'not', include: undefined, exclude: node } : node)),
      negative: false,
    }
  }

  private clause(): Clause | undefined {
    const negative = this.tokens[this.offset]?.kind === 'minus'
    if (negative) this.offset++
    const token = this.tokens[this.offset++]
    if (token?.kind === 'open') {
      const node = this.and(true)
      return node === undefined ? undefined : { node, negative }
    }
    if (token?.kind !== 'word' && token?.kind !== 'phrase') invalid('requires an operand on both sides of OR')
    const prefix = token.kind === 'word' && token.text.endsWith('*')
    const text = sanitizeFtsText(prefix ? token.text.slice(0, -1) : token.text)
    const key = this.tokenKey(text)
    if (key === undefined) return undefined
    return {
      node: { kind: 'phrase', expression: quoteFtsData(text) + (prefix ? '*' : ''), key: `${Number(prefix)}${key}` },
      negative,
    }
  }
}

function combine(kind: 'and' | 'or', children: Node[]): Node {
  const [first, second] = children
  return first !== undefined && second === undefined ? first : { kind, children }
}

function compile(node: Node, phrases: Map<string, string> | undefined): string {
  switch (node.kind) {
    case 'phrase':
      if (phrases !== undefined && !phrases.has(node.key)) phrases.set(node.key, node.expression)
      return node.expression
    case 'and': case 'or':
      return `(${node.children.map(child => compile(child, phrases)).join(node.kind === 'and' ? ' AND ' : ' OR ')})`
    case 'not':
      if (node.include === undefined) invalid('needs a positive term in each AND group and OR branch')
      return `(${compile(node.include, phrases)} NOT ${compile(node.exclude, undefined)})`
  }
}

function invalid(issue: string): never {
  throw new SessionQueryError(`session-search query ${issue}`, 'SESSION_QUERY_INVALID_QUERY')
}

function hasPositive(node: Node): boolean {
  switch (node.kind) {
    case 'phrase': return true
    case 'and': case 'or': return node.children.some(hasPositive)
    case 'not': return node.include !== undefined && hasPositive(node.include)
  }
}

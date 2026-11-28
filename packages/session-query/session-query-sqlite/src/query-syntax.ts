/** Parse the search language without passing caller syntax to FTS5. */

import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { quoteFtsData, sanitizeFtsText } from './query.ts'

// Keeps the compiled query within FTS5's parser stack, even with mixed operators.
const MAX_GROUP_DEPTH = 16

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
 * @throws {SessionQueryError} Invalid syntax, including empty or overly nested groups, or an exclusion-only query.
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
    const node = this.and(0)
    if (node === undefined) invalid('contains no searchable text')
    return node
  }

  private and(depth: number): Node | undefined {
    const group = depth > 0
    let hasOperand = false
    const include: Node[] = []
    const exclude: Node[] = []
    for (;;) {
      const kind = this.tokens[this.offset]?.kind
      if (kind === 'close' || kind === undefined) {
        if ((kind === 'close') !== group) invalid('has an unmatched parenthesis')
        if (group) {
          if (!hasOperand) invalid('contains an empty parenthesized group')
          this.offset++
        }
        break
      }
      if (kind === 'and') {
        this.offset++
        continue
      }
      const part = this.or(depth)
      hasOperand = true
      if (part !== undefined) (part.negative ? exclude : include).push(part.node)
    }
    const positive = include.length === 0 ? undefined : combine('and', include)
    return exclude.length === 0 ? positive : { kind: 'not', include: positive, exclude: combine('or', exclude) }
  }

  private or(depth: number): Clause | undefined {
    const first = this.clause(depth)
    if (this.tokens[this.offset]?.kind !== 'or') return first
    const branches = first === undefined ? [] : [first]
    while (this.tokens[this.offset]?.kind === 'or') {
      this.offset++
      const branch = this.clause(depth)
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

  private clause(depth: number): Clause | undefined {
    const negative = this.tokens[this.offset]?.kind === 'minus'
    if (negative) this.offset++
    const token = this.tokens[this.offset++]
    if (token?.kind === 'open') {
      if (depth === MAX_GROUP_DEPTH) invalid(`supports at most ${MAX_GROUP_DEPTH} levels of parentheses`)
      const node = this.and(depth + 1)
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

// FTS5's precedence is NOT > AND > OR, unlike the input query's AND and OR.
const ftsPrecedence = { or: 1, and: 2, not: 3 }

function compile(node: Node, phrases: Map<string, string> | undefined, minimum = 0): string {
  if (node.kind === 'phrase') {
    if (phrases !== undefined && !phrases.has(node.key)) phrases.set(node.key, node.expression)
    return node.expression
  }
  const precedence = ftsPrecedence[node.kind]
  let expression: string
  if (node.kind === 'not') {
    if (node.include === undefined) invalid('needs a positive term in each AND group and OR branch')
    expression = `${compile(node.include, phrases, precedence)} NOT ${compile(node.exclude, undefined, precedence + 1)}`
  } else {
    // Equal-precedence children join the same AND or OR chain.
    expression = node.children.map(child => compile(child, phrases, precedence)).join(node.kind === 'and' ? ' AND ' : ' OR ')
  }
  return precedence < minimum ? `(${expression})` : expression
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

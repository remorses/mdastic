// Compile unsafe syntax patterns into cached, scope-specific escape rules.
// Built-ins scan candidates; custom patterns retain regex matching semantics.
import type { Config } from './syntax.ts'
import { ASCII_SIZE, AsciiFlag, Char, ascii } from './scan.ts'

const enum SyntaxMask {
  Gfm = 1,
  Mdx = 2,
  Yaml = 4,
  Toml = 8,
  Math = 16,
  SingleDollar = 32,
}
const enum EscapeFlag {
  Before = 1,
  After = 2,
  Match = 4,
}
const HEX_ESCAPE_WIDTH = 4
const PERCENT_WIDTH = 2
export const enum CharacterKind {
  Whitespace = 1,
  Punctuation = 2,
}

export interface Unsafe {
  character: string
  before?: string
  after?: string
  atBreak?: boolean
  inConstruct?: string | string[]
  notInConstruct?: string | string[]
  beforeNode?: string | string[]
  afterNode?: string | string[]
  unicode?: boolean
}

export interface SafeConfig {
  before?: string
  after?: string
  encode?: string[]
  beforeNode?: { type: string }
  afterNode?: { type: string }
}

interface Condition {
  characters?: Uint8Array
  end: boolean
  digits: boolean
  literal?: string
}

interface Rule {
  pattern: Unsafe
  before?: Condition
  after?: Condition
  index: number
}

export interface ScopedRules {
  characters: (Rule[] | undefined)[]
  expression: RegExp
  percentEncode: boolean
}
interface ScopeNode {
  next: Map<string, ScopeNode>
  rules?: ScopedRules
}
export interface RuleTable {
  characters: (Rule[] | undefined)[]
  scopes: ScopeNode
  breaks: RegExp[]
  next: Int32Array
  custom?: { pattern: Unsafe; expression: RegExp }[]
}

const configRules = new WeakMap<Config, RuleTable>()
// resolveConfig makes fresh objects, so equivalent syntax sets also share the tables.
const defaultRules = new Map<number, RuleTable>()
const conditions = new Map<string, Condition>()

// Character classes are expanded once; the text scan never runs a regular expression.
function condition(source: string): Condition {
  const cached = conditions.get(source)
  if (cached) return cached
  const result: Condition = { end: false, digits: source === '\\d+' }
  if (!result.digits) {
    let value = source
    if (value.startsWith('(?:') && value.endsWith(')')) value = value.slice(3, -1)
    if (value.endsWith('|$')) {
      result.end = true
      value = value.slice(0, -2)
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      const expression = new RegExp('^(?:' + value + ')$')
      result.characters = new Uint8Array(ASCII_SIZE)
      for (let code = 0; code < ASCII_SIZE; code++) {
        if (expression.test(String.fromCharCode(code))) result.characters[code] = 1
      }
    } else {
      result.literal = value.replace(/\\(.)/g, unescapeLiteral)
    }
  }
  conditions.set(source, result)
  return result
}

function unescapeLiteral(_: string, character: string) {
  return character === 'n' ? '\n' : character === 'r' ? '\r' : character === 't' ? '\t' : character
}

export function prepareRules(config: Config, patterns: Unsafe[], custom = false): RuleTable {
  const cached = !custom && configRules.get(config)
  if (cached) return cached
  const key =
    (config.gfm ? SyntaxMask.Gfm : 0) |
    (config.mdx ? SyntaxMask.Mdx : 0) |
    (config.frontmatter?.yaml ? SyntaxMask.Yaml : 0) |
    (config.frontmatter?.toml ? SyntaxMask.Toml : 0) |
    (config.math ? SyntaxMask.Math : 0) |
    (config.math?.singleDollarTextMath ? SyntaxMask.SingleDollar : 0)
  let table = !custom ? defaultRules.get(key) : undefined
  if (!table) {
    table = {
      characters: [],
      next: new Int32Array(patterns.length),
      scopes: { next: new Map() },
      breaks: patterns.filter((pattern) => pattern.atBreak).map(compilePattern),
    }
    // Syntax-equivalent built-ins share tables; user patterns must bypass that cache.
    if (custom) {
      table.custom = patterns.map((pattern) => ({
        pattern,
        expression: compilePattern(pattern),
      }))
      return table
    }
    for (let index = 0; index < patterns.length; index++) {
      const pattern = patterns[index]
      const code = pattern.character.charCodeAt(0)
      const rule: Rule = {
        pattern,
        index,
        before: pattern.before ? condition(pattern.before) : undefined,
        after: pattern.after ? condition(pattern.after) : undefined,
      }
      ;(table.characters[code] ??= []).push(rule)
    }
    defaultRules.set(key, table)
  }
  configRules.set(config, table)
  return table
}

const expressions = new WeakMap<Unsafe, RegExp>()
export function compilePattern(pattern: Unsafe): RegExp {
  let expression = expressions.get(pattern)
  if (!expression) {
    const before =
      (pattern.atBreak ? '[\\r\\n][\\t ]*' : '') +
      (pattern.before ? '(?:' + pattern.before + ')' : '')
    const character = pattern.character.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
    expression = new RegExp(
      (pattern.beforeNode ? '^' : before ? '(' + before + ')' : '') +
        character +
        (pattern.afterNode ? '$' : pattern.after ? '(?:' + pattern.after + ')' : ''),
      pattern.unicode ? 'gu' : 'g',
    )
    expressions.set(pattern, expression)
  }
  expression.lastIndex = 0
  return expression
}

function scopedRules(table: RuleTable, stack: string[]): ScopedRules {
  let node = table.scopes
  for (const name of stack) {
    let child = node.next.get(name)
    if (!child) {
      child = { next: new Map() }
      node.next.set(name, child)
    }
    node = child
  }
  // Construct scope determines which unsafe candidates the native regex can skip to.
  let result = node.rules
  if (!result) {
    const characters = table.characters.map((rules) =>
      rules?.filter((rule) => patternInScope(stack, rule.pattern)),
    )
    const codes: string[] = []
    const alternatives: string[] = []
    for (let code = 0; code < characters.length; code++) {
      const rules = characters[code]
      if (!rules?.length) continue
      const character = '\\u' + code.toString(16).padStart(HEX_ESCAPE_WIDTH, '0')
      if (rules.some((rule) => !rule.before && !rule.after && !rule.pattern.atBreak)) {
        codes.push(character)
      } else {
        const conditions: string[] = []
        for (const { pattern } of rules) {
          const before =
            (pattern.atBreak ? '[\\r\\n][\\t ]*' : '') +
            (pattern.before ? '(?:' + pattern.before + ')' : '')
          conditions.push(
            (before ? '(?<=' + before + character + ')' : '') +
              (pattern.after ? '(?=' + pattern.after + ')' : ''),
          )
        }
        alternatives.push(character + '(?:' + conditions.join('|') + ')')
      }
    }
    if (codes.length) alternatives.unshift('[' + codes.join('') + ']')
    result = {
      characters,
      expression: new RegExp(alternatives.join('|') || '(?!)', 'g'),
      percentEncode: stack.includes('autolink'),
    }
    node.rules = result
  }
  return result
}

export function patternInScope(stack: string[], pattern: Unsafe): boolean {
  return (
    inScope(stack, pattern.inConstruct, true) && !inScope(stack, pattern.notInConstruct, false)
  )
}

function inScope(
  stack: string[],
  names: string | string[] | undefined,
  absent: boolean,
): boolean {
  if (typeof names === 'string') return stack.includes(names)
  if (!names?.length) return absent
  for (const name of names) if (stack.includes(name)) return true
  return false
}

function matchBefore(value: string, position: number, test: Condition): number {
  if (test.digits) {
    let start = position
    while (
      start &&
      value.charCodeAt(start - 1) >= Char.Digit0 &&
      value.charCodeAt(start - 1) <= Char.Digit9
    )
      start--
    return start === position ? -1 : start
  }
  if (test.characters)
    return position && test.characters[value.charCodeAt(position - 1)] ? position - 1 : -1
  const literal = test.literal || ''
  return position >= literal.length && value.startsWith(literal, position - literal.length)
    ? position - literal.length
    : -1
}

function matchAfter(value: string, position: number, test: Condition): number {
  if (test.end && position === value.length) return position
  if (test.characters) return test.characters[value.charCodeAt(position)] ? position + 1 : -1
  const literal = test.literal || ''
  return value.startsWith(literal, position) ? position + literal.length : -1
}

export function punctuation(code: number): boolean {
  return (
    (code >= Char.Exclamation && code <= Char.Slash) ||
    (code >= Char.Colon && code <= Char.At) ||
    (code >= Char.LeftBracket && code <= Char.Backtick) ||
    (code >= Char.LeftBrace && code <= Char.Tilde)
  )
}

function escapeBackslashes(value: string, after = ''): string {
  let start = 0
  let result = ''
  for (let index = value.indexOf('\\'); index !== -1; index = value.indexOf('\\', index + 1)) {
    if (
      punctuation(index + 1 < value.length ? value.charCodeAt(index + 1) : after.charCodeAt(0))
    ) {
      result += value.slice(start, index) + '\\'
      start = index
    }
  }
  return result + value.slice(start)
}

const unicodePunctuation = /\p{P}|\p{S}/u
const unicodeWhitespace = /\s/

export function classifyCharacter(code: number): CharacterKind | undefined {
  if (code < ASCII_SIZE) {
    const flags = ascii[code]
    return flags & AsciiFlag.Whitespace
      ? CharacterKind.Whitespace
      : flags & AsciiFlag.Punctuation
        ? CharacterKind.Punctuation
        : undefined
  }
  if (code !== code) return undefined
  const character = String.fromCharCode(code)
  if (unicodeWhitespace.test(character)) return CharacterKind.Whitespace
  if (unicodePunctuation.test(character)) return CharacterKind.Punctuation
}

function nodeInScope(types: string | string[] | undefined, node: { type: string } | undefined) {
  if (!types) return true
  if (!node) return false
  return typeof types === 'string' ? types === node.type : types.includes(node.type)
}

function attentionMarker(code: number) {
  return code === Char.Asterisk || code === Char.Underscore
}

export function safe(
  state: {
    rules: RuleTable
    stack: string[]
    customHandlers?: boolean
    scopedRules?: ScopedRules
  },
  input: string | null | undefined,
  config: SafeConfig,
): string {
  // ── Select cached scope and bypass matching for ordinary text ──
  const prefix = config.before || ''
  const suffix = config.after || ''
  const value = prefix + (input || '') + suffix
  const table = state.rules
  const scope = state.scopedRules || scopedRules(table, state.stack)
  if (!state.customHandlers) state.scopedRules = scope
  const { characters, expression, percentEncode } = scope
  expression.lastIndex = 0
  let candidate = table.custom ? null : expression.exec(value)
  if (!table.custom && !candidate)
    return percentEncode ? input || '' : escapeBackslashes(input || '', suffix)
  const next = table.next
  next.fill(0)
  const matches: number[] = []
  const positions: number[] = []
  const offset = prefix.length
  const end = value.length - suffix.length
  // ── Custom patterns keep regex-style nonoverlapping matches ──
  if (table.custom) {
    for (const { pattern, expression } of table.custom) {
      if (
        !patternInScope(state.stack, pattern) ||
        !nodeInScope(pattern.beforeNode, config.beforeNode) ||
        !nodeInScope(pattern.afterNode, config.afterNode)
      )
        continue
      const from = pattern.beforeNode ? offset : 0
      const subject = value.slice(from, pattern.afterNode ? end : undefined)
      expression.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = expression.exec(subject))) {
        const before = Boolean(pattern.before || pattern.atBreak)
        const position = from + match.index + (before ? match[1].length : 0)
        const flags =
          EscapeFlag.Match |
          (before ? EscapeFlag.Before : 0) |
          (pattern.after ? EscapeFlag.After : 0)
        // Intersect restrictions: an unconditional rule wins over conditional rules.
        matches[position] = matches[position] ? matches[position] & flags : flags
      }
    }
    for (let index = 0; index < matches.length; index++)
      if (matches[index]) positions.push(index)
  }
  // ── Built-in matches use compiled conditions and one next cursor per rule ──
  for (; candidate; candidate = expression.exec(value)) {
    const position = candidate.index
    const rules = characters[value.charCodeAt(position)]
    if (!rules) continue
    let flags = 0
    for (const rule of rules) {
      let start = rule.before ? matchBefore(value, position, rule.before) : position
      if (start < 0) continue
      if (rule.pattern.atBreak) {
        while (
          start &&
          (value.charCodeAt(start - 1) === Char.Space ||
            value.charCodeAt(start - 1) === Char.Tab)
        )
          start--
        if (
          !start ||
          (value.charCodeAt(start - 1) !== Char.LineFeed &&
            value.charCodeAt(start - 1) !== Char.CarriageReturn)
        )
          continue
        start--
      }
      // Preserve the same nonoverlap boundary as repeated RegExp.exec calls.
      if (start < next[rule.index]) continue
      const end = rule.after ? matchAfter(value, position + 1, rule.after) : position + 1
      if (end < 0) continue
      next[rule.index] = end
      const match =
        EscapeFlag.Match |
        (rule.pattern.before || rule.pattern.atBreak ? EscapeFlag.Before : 0) |
        (rule.pattern.after ? EscapeFlag.After : 0)
      flags = flags ? flags & match : match
    }
    if (flags) {
      matches[position] = flags
      positions.push(position)
    }
  }
  // ── Suppress redundant adjacent conditional escapes and emit the result ──
  let start = offset
  let result = ''
  for (let index = 0; index < positions.length; index++) {
    const position = positions[index]
    if (position < start || position >= end) continue
    if (
      value.charCodeAt(position) === Char.Underscore &&
      position > 0 &&
      classifyCharacter(value.charCodeAt(position - 1)) === undefined &&
      !matches[position - 1] &&
      !(position - 1 === offset && attentionMarker(value.charCodeAt(offset - 1)))
    ) {
      let sequenceEnd = position + 1
      while (sequenceEnd < end && value.charCodeAt(sequenceEnd) === Char.Underscore) sequenceEnd++
      const skip = sequenceEnd - position - 1
      if (
        positions[index + skip] === sequenceEnd - 1 &&
        sequenceEnd < value.length &&
        classifyCharacter(value.charCodeAt(sequenceEnd)) === undefined &&
        !matches[sequenceEnd] &&
        !(sequenceEnd === end - 1 && attentionMarker(value.charCodeAt(end)))
      ) {
        index += skip
        continue
      }
    }
    const flags = matches[position]
    if (
      (position + 1 < end &&
        flags & EscapeFlag.After &&
        matches[position + 1] === EscapeFlag.Match) ||
      (flags & EscapeFlag.Before &&
        position - 1 >= offset &&
        matches[position - 1] === EscapeFlag.Match)
    )
      continue
    if (start !== position) {
      const slice = value.slice(start, position)
      result += percentEncode ? slice : escapeBackslashes(slice, '\\')
    }
    start = position + 1
    const code = value.charCodeAt(position)
    if (percentEncode)
      result += '%' + code.toString(16).toUpperCase().padStart(PERCENT_WIDTH, '0')
    else if (punctuation(code) && !config.encode?.includes(value[position]))
      result += '\\' + value[position]
    else result += '&#x' + code.toString(16).toUpperCase() + ';'
  }
  const rest = value.slice(start, end)
  return result + (percentEncode ? rest : escapeBackslashes(rest, suffix))
}

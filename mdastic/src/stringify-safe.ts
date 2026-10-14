// Compile unsafe syntax patterns into cached, scope-specific escape rules.
// Built-ins scan candidates; custom patterns retain regex matching semantics.
import type { Config } from './syntax.ts'
import { ASCII_SIZE, Char } from './scan.ts'

const enum SyntaxMask {
  Gfm = 1,
  Mdx = 2,
  Yaml = 4,
  Toml = 8,
}
const enum EscapeFlag {
  Before = 1,
  After = 2,
  Match = 4,
}
const HEX_ESCAPE_WIDTH = 4

export interface Unsafe {
  character: string
  before?: string
  after?: string
  atBreak?: boolean
  inConstruct?: string | string[]
  notInConstruct?: string | string[]
}

export interface SafeConfig {
  before?: string
  after?: string
  encode?: string[]
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
}
export interface RuleTable {
  characters: (Rule[] | undefined)[]
  scopes: Map<string, ScopedRules>
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
      result.literal = value.replace(/\\(.)/g, '$1')
    }
  }
  conditions.set(source, result)
  return result
}

export function prepareRules(config: Config, patterns: Unsafe[], custom = false): RuleTable {
  const cached = !custom && configRules.get(config)
  if (cached) return cached
  const key =
    (config.gfm ? SyntaxMask.Gfm : 0) |
    (config.mdx ? SyntaxMask.Mdx : 0) |
    (config.frontmatter?.yaml ? SyntaxMask.Yaml : 0) |
    (config.frontmatter?.toml ? SyntaxMask.Toml : 0)
  let table = !custom ? defaultRules.get(key) : undefined
  if (!table) {
    table = {
      characters: [],
      next: new Int32Array(patterns.length),
      scopes: new Map(),
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
    const character = pattern.character.replace(/[|\\{}()[\]^$+*?.-]/g, '\\$&')
    expression = new RegExp(
      (before ? '(' + before + ')' : '') +
        character +
        (pattern.after ? '(?:' + pattern.after + ')' : ''),
      'g',
    )
    expressions.set(pattern, expression)
  }
  expression.lastIndex = 0
  return expression
}

function scopedRules(table: RuleTable, stack: string[]): ScopedRules {
  const key = stack.join('/')
  // Construct scope determines which unsafe candidates the native regex can skip to.
  let result = table.scopes.get(key)
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
        for (const { pattern } of rules) {
          const before = (pattern.atBreak ? '[\\r\\n][\\t ]*' : '') + (pattern.before || '')
          alternatives.push(
            (before ? '(?<=' + before + ')' : '') +
              character +
              (pattern.after ? '(?=' + pattern.after + ')' : ''),
          )
        }
      }
    }
    if (codes.length) alternatives.unshift('[' + codes.join('') + ']')
    result = {
      characters,
      expression: new RegExp(alternatives.join('|') || '(?!)', 'g'),
    }
    table.scopes.set(key, result)
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
  const { characters, expression } = scope
  expression.lastIndex = 0
  let candidate = table.custom ? null : expression.exec(value)
  if (!table.custom && !candidate) return escapeBackslashes(input || '', suffix)
  const next = table.next
  next.fill(0)
  const matches: number[] = []
  const positions: number[] = []
  // ── Custom patterns keep regex-style nonoverlapping matches ──
  if (table.custom) {
    for (const { pattern, expression } of table.custom) {
      if (!patternInScope(state.stack, pattern)) continue
      expression.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = expression.exec(value))) {
        const before = 'before' in pattern || Boolean(pattern.atBreak)
        const position = match.index + (before ? match[1].length : 0)
        const flags =
          EscapeFlag.Match |
          (before ? EscapeFlag.Before : 0) |
          ('after' in pattern ? EscapeFlag.After : 0)
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
        ('before' in rule.pattern || rule.pattern.atBreak ? EscapeFlag.Before : 0) |
        ('after' in rule.pattern ? EscapeFlag.After : 0)
      flags = flags ? flags & match : match
    }
    if (flags) {
      matches[position] = flags
      positions.push(position)
    }
  }
  // ── Suppress redundant adjacent conditional escapes and emit the result ──
  let start = prefix.length
  const end = value.length - suffix.length
  let result = ''
  for (const position of positions) {
    if (position < start || position >= end) continue
    const flags = matches[position]
    if (
      (position + 1 < end &&
        flags & EscapeFlag.After &&
        matches[position + 1] === EscapeFlag.Match) ||
      (flags & EscapeFlag.Before && position && matches[position - 1] === EscapeFlag.Match)
    )
      continue
    if (start !== position) result += escapeBackslashes(value.slice(start, position), '\\')
    start = position
    const code = value.charCodeAt(position)
    if (punctuation(code) && !config.encode?.includes(value[position])) result += '\\'
    else {
      result += '&#x' + code.toString(16).toUpperCase() + ';'
      start++
    }
  }
  return result + escapeBackslashes(value.slice(start, end), suffix)
}

// CommonMark serializer ported from mdast-util-to-markdown 2.2.3 (MIT, Titus Wormer).
// Core handlers coordinate construct scopes and sibling context for exact escaping.
/*
Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import {
  safe,
  patternInScope,
  prepareRules,
  compilePattern,
  classifyCharacter,
  punctuation,
  CharacterKind,
  type Unsafe,
  type SafeConfig,
  type RuleTable,
  type ScopedRules,
} from './stringify-safe.ts'
import { entities as characterEntities } from './entities.ts'
import type { Config } from './syntax.ts'
import { Char, TAB_SIZE, alpha, digit } from './scan.ts'
import { htmlBlocks } from './block.ts'

const MIN_FENCE_LENGTH = 3
const MAX_HEADING_DEPTH = 6
const MIN_THEMATIC_MARKERS = 3
const enum HtmlKind {
  Raw = 1,
  Comment = 2,
  Instruction = 3,
  Declaration = 4,
  Cdata = 5,
  Basic = 6,
  Complete = 7,
}
const enum Surrogate {
  HighStart = 0xd800,
  HighEnd = 0xdbff,
  LowStart = 0xdc00,
  LowEnd = 0xdfff,
}
import type { Nodes } from './types.ts'
import type * as M from './types.ts'
import {
  gfmToMarkdown,
  mdxToMarkdown,
  frontmatterToMarkdown,
  mathToMarkdown,
} from './stringify-extensions.ts'
export interface StringifyOptions {
  bullet?: '*' | '+' | '-' | null
  bulletOther?: '*' | '+' | '-' | null
  bulletOrdered?: '.' | ')' | null
  closeAtx?: boolean | null
  emphasis?: '*' | '_' | null
  fence?: '`' | '~' | null
  fences?: boolean | null
  incrementListMarker?: boolean | null
  listItemIndent?: 'one' | 'tab' | 'mixed' | null
  quote?: '"' | "'" | null
  resourceLink?: boolean | null
  rule?: '*' | '-' | '_' | null
  ruleRepetition?: number | null
  ruleSpaces?: boolean | null
  setext?: boolean | null
  strong?: '*' | '_' | null
  tightDefinitions?: boolean | null
  tableCellPadding?: boolean | null
  tablePipeAlign?: boolean | null
  stringLength?: ((value: string) => number) | null
  firstLineBlank?: boolean | null
  printWidth?: number | null
  quoteSmart?: boolean | null
  tightSelfClosing?: boolean | null
  handlers?: Record<string, Handler> | null
  join?: Join[] | null
  unsafe?: Unsafe[] | null
  extensions?: StringifyOptions[] | null
}

export interface Info {
  before: string
  after: string
  now: { line: number; column: number }
  lineShift: number
}
export type TrackerInfo = Pick<Info, 'now' | 'lineShift'>
type Tracker = {
  current(): TrackerInfo
  shift(size: number): void
  move(value?: string | null): string
}
// Extension handlers can add their own node shapes.
// Handler arguments intentionally match mdast-util-to-markdown's extension API.
export type Handler = ((node: any, parent: any, state: State, info: Info) => string) & {
  peek?: Handler
  attention?: Attention
}
export interface AttentionSpec {
  construct: string
  markers: string[]
  sizes: number[]
}
export type Attention = (node: any, state: State) => AttentionSpec
export type Join = (left: any, right: any, parent: any, state: State) => number | boolean | void
export interface State {
  associationId(node: { identifier?: string; label?: string | null }): string
  containerPhrasing(parent: any, info: Info): string
  containerFlow(parent: any, info: TrackerInfo): string
  createTracker(info: TrackerInfo): Tracker
  compilePattern(pattern: Unsafe): RegExp
  enter(name: string): () => void
  handlers: Record<string, Handler>
  handle: Handler & { handlers: Record<string, Handler> }
  indentLines(
    value: string,
    map: (line: string, index: number, blank: boolean) => string,
  ): string
  indexStack: number[]
  join: Join[]
  options: StringifyOptions
  safe(value: string | null | undefined, config: SafeConfig): string
  stack: string[]
  unsafe: Unsafe[]
  rules: RuleTable
  customHandlers: boolean
  scopedRules?: ScopedRules
  bulletCurrent?: string
  bulletLastUsed?: string
}
type Setup = Pick<State, 'handlers' | 'join' | 'options' | 'unsafe'>
function configure(base: Setup, extension: StringifyOptions): Setup {
  for (const child of extension.extensions || []) configure(base, child)
  for (const key of Object.keys(extension) as (keyof StringifyOptions)[]) {
    switch (key) {
      case 'extensions':
        break
      case 'unsafe':
        base.unsafe.push(...(extension.unsafe || []))
        break
      case 'join':
        base.join.push(...(extension.join || []))
        break
      case 'handlers':
        Object.assign(base.handlers, extension.handlers)
        break
      default:
        Object.assign(base.options, { [key]: extension[key] })
    }
  }
  return base
}
function blockquote(node: M.Blockquote, _: any, state: State, info: Info) {
  const exit = state.enter('blockquote')
  const tracker = state.createTracker(info)
  tracker.move('> ')
  tracker.shift(2)
  const value = state.indentLines(state.containerFlow(node, tracker.current()), quoteLine)
  exit()
  return value
}
function quoteLine(line: string, _: any, blank: boolean) {
  return '>' + (blank ? '' : ' ') + line
}
function hardBreak(_: any, _1: any, state: State, info: Info) {
  let index = -1
  while (++index < state.unsafe.length) {
    const pattern = state.unsafe[index]
    if (
      pattern.character === '\n' &&
      !pattern.before &&
      !pattern.after &&
      patternInScope(state.stack, pattern)
    ) {
      return /[\t ]/.test(info.before) ? '' : ' '
    }
  }
  return '\\\n'
}
export function longestStreak(value: string, marker: string): number {
  let longest = 0
  const code = marker.charCodeAt(0)
  for (
    let index = value.indexOf(marker);
    index !== -1;
    index = value.indexOf(marker, index + 1)
  ) {
    const start = index
    while (value.charCodeAt(index + 1) === code) index++
    const streak = index - start + 1
    if (streak > longest) longest = streak
  }
  return longest
}
function formatCodeAsIndented(node: M.Code, state: State) {
  return Boolean(
    state.options.fences === false &&
      node.value &&
      !node.lang &&
      /[^ \r\n]/.test(node.value) &&
      !/^[\t ]*(?:[\r\n]|$)|(?:^|[\r\n])[\t ]*$/.test(node.value),
  )
}
function checkFence(state: State) {
  const marker = state.options.fence || '`'
  if (marker !== '`' && marker !== '~') {
    throw new Error(
      'Cannot serialize code with `' +
        marker +
        '` for `options.fence`, expected `` ` `` or `~`',
    )
  }
  return marker
}
function code(node: M.Code, _: any, state: State, info: Info) {
  const marker = checkFence(state)
  const raw = node.value || ''
  const suffix = marker === '`' ? 'GraveAccent' : 'Tilde'
  if (formatCodeAsIndented(node, state)) {
    const exitIndented = state.enter('codeIndented')
    const indentedCode = state.indentLines(raw, indentCodeLine)
    exitIndented()
    return indentedCode
  }
  const tracker = state.createTracker(info)
  const sequence = marker.repeat(Math.max(longestStreak(raw, marker) + 1, MIN_FENCE_LENGTH))
  const exit = state.enter('codeFenced')
  let value = tracker.move(sequence)
  if (node.lang) {
    const subexit = state.enter(`codeFencedLang${suffix}`)
    value += tracker.move(
      state.safe(node.lang, {
        before: value,
        after: ' ',
        encode: ['`'],
      }),
    )
    subexit()
  }
  if (node.lang && node.meta) {
    const subexit = state.enter(`codeFencedMeta${suffix}`)
    value += tracker.move(' ')
    value += tracker.move(
      state.safe(node.meta, {
        before: value,
        after: '\n',
        encode: ['`'],
      }),
    )
    subexit()
  }
  value += tracker.move('\n')
  if (raw) {
    value += tracker.move(raw + '\n')
  }
  value += tracker.move(sequence)
  exit()
  return value
}
function indentCodeLine(line: string, _: any, blank: boolean) {
  return (blank ? '' : '    ') + line
}
function checkQuote(state: State) {
  const marker = state.options.quote || '"'
  if (marker !== '"' && marker !== "'") {
    throw new Error(
      'Cannot serialize title with `' + marker + '` for `options.quote`, expected `"`, or `\'`',
    )
  }
  return marker
}
function definition(node: M.Definition, _: any, state: State, info: Info) {
  const quote = checkQuote(state)
  const suffix = quote === '"' ? 'Quote' : 'Apostrophe'
  const exit = state.enter('definition')
  let subexit = state.enter('label')
  const tracker = state.createTracker(info)
  let value = tracker.move('[')
  value += tracker.move(
    state.safe(state.associationId(node), {
      before: value,
      after: ']',
    }),
  )
  value += tracker.move(']: ')
  subexit()
  if (!node.url || /[\0- \u007F]/.test(node.url)) {
    subexit = state.enter('destinationLiteral')
    value += tracker.move('<')
    value += tracker.move(state.safe(node.url, { before: value, after: '>' }))
    value += tracker.move('>')
  } else {
    subexit = state.enter('destinationRaw')
    value += tracker.move(
      state.safe(node.url, {
        before: value,
        after: node.title ? ' ' : '\n',
      }),
    )
  }
  subexit()
  if (node.title) {
    subexit = state.enter(`title${suffix}`)
    value += tracker.move(' ' + quote)
    value += tracker.move(
      state.safe(node.title, {
        before: value,
        after: quote,
      }),
    )
    value += tracker.move(quote)
    subexit()
  }
  exit()
  return value
}
function checkEmphasis(state: State) {
  const marker = state.options.emphasis || '*'
  if (marker !== '*' && marker !== '_') {
    throw new Error(
      'Cannot serialize emphasis with `' +
        marker +
        '` for `options.emphasis`, expected `*`, or `_`',
    )
  }
  return marker
}
function encodeCharacterReference(code: number) {
  return '&#x' + code.toString(16).toUpperCase() + ';'
}
function encodeInfo(outside: number, inside: number, marker: string) {
  // Encode boundary letters/whitespace only as needed for attention flanking.
  const outsideKind = classifyCharacter(outside)
  const insideKind = classifyCharacter(inside)
  if (outsideKind === void 0) {
    return insideKind === void 0
      ? marker === '_'
        ? { inside: true, outside: true }
        : { inside: false, outside: false }
      : insideKind === CharacterKind.Whitespace
        ? { inside: true, outside: true }
        : { inside: false, outside: true }
  }
  if (outsideKind === CharacterKind.Whitespace) {
    return insideKind === void 0
      ? { inside: false, outside: false }
      : insideKind === CharacterKind.Whitespace
        ? { inside: true, outside: true }
        : { inside: false, outside: false }
  }
  return insideKind === void 0
    ? { inside: false, outside: false }
    : insideKind === CharacterKind.Whitespace
      ? { inside: true, outside: false }
      : { inside: false, outside: false }
}
const knownSequences = new Map<AttentionSpec, string[]>()
emphasis.attention = emphasisAttention
emphasis.peek = emphasisPeek
function emphasis(node: M.Emphasis, _: any, state: State, info: Info) {
  const exit = state.enter('phrasing')
  const item = attentionItem(node, emphasisAttention, state, state.createTracker(info))
  const value = item ? serializeItems([item], info.before, info.after) : ''
  exit()
  return value
}
const emphasisAsterisk = attentionSpec('emphasis', ['*', '_'], [1])
const emphasisUnderscore = attentionSpec('emphasis', ['_', '*'], [1])
function emphasisAttention(_: any, state: State) {
  return checkEmphasis(state) === '*' ? emphasisAsterisk : emphasisUnderscore
}
function emphasisPeek(_: any, _1: any, state: State) {
  return state.options.emphasis || '*'
}
interface TraversableNode {
  type: string
  value?: string
  alt?: string | null
  children?: TraversableNode[]
}
function toString(node: TraversableNode): string {
  if (node.value) return node.value || ''
  if (node.alt) return node.alt || ''
  return node.children ? node.children.map(toString).join('') : ''
}
function hasBreak(node: TraversableNode): boolean {
  return (
    Boolean(node.value && /\r?\n|\r/.test(node.value)) ||
    node.type === 'break' ||
    Boolean(node.children?.some(hasBreak))
  )
}
export function formatHeadingAsSetext(node: M.Heading, state: State) {
  const literalWithBreak = hasBreak(node)
  return Boolean(
    (!node.depth || node.depth < 3) &&
      toString(node) &&
      (state.options.setext || literalWithBreak),
  )
}
function heading(node: M.Heading, _: any, state: State, info: Info) {
  const rank = Math.max(Math.min(MAX_HEADING_DEPTH, node.depth || 1), 1)
  const tracker = state.createTracker(info)
  if (formatHeadingAsSetext(node, state)) {
    const exitSetext = state.enter('headingSetext')
    const exitPhrasing = state.enter('phrasing')
    const headingText = state.containerPhrasing(node, {
      ...tracker.current(),
      before: '\n',
      after: '\n',
    })
    exitPhrasing()
    exitSetext()
    return (
      headingText +
      '\n' +
      (rank === 1 ? '=' : '-').repeat(
        headingText.length -
          (Math.max(headingText.lastIndexOf('\r'), headingText.lastIndexOf('\n')) + 1),
      )
    )
  }
  const sequence = '#'.repeat(rank)
  const exit = state.enter('headingAtx')
  const subexit = state.enter('phrasing')
  tracker.move(sequence + ' ')
  let value = state.containerPhrasing(node, {
    before: '# ',
    after: '\n',
    ...tracker.current(),
  })
  if (/^[\t ]/.test(value)) {
    value = encodeCharacterReference(value.charCodeAt(0)) + value.slice(1)
  }
  value = value ? sequence + ' ' + value : sequence
  if (state.options.closeAtx) {
    value += ' ' + sequence
  }
  subexit()
  exit()
  return value
}
html.peek = htmlPeek
function html(node: M.Html) {
  return node.value || ''
}
function htmlPeek() {
  return '<'
}
image.peek = imagePeek
function image(node: M.Image, _: any, state: State, info: Info) {
  const quote = checkQuote(state)
  const suffix = quote === '"' ? 'Quote' : 'Apostrophe'
  const exit = state.enter('image')
  let subexit = state.enter('label')
  const tracker = state.createTracker(info)
  let value = tracker.move('![')
  value += tracker.move(state.safe(node.alt, { before: value, after: ']' }))
  value += tracker.move('](')
  subexit()
  if ((!node.url && node.title) || /[\0- \u007F]/.test(node.url)) {
    subexit = state.enter('destinationLiteral')
    value += tracker.move('<')
    value += tracker.move(state.safe(node.url, { before: value, after: '>' }))
    value += tracker.move('>')
  } else {
    subexit = state.enter('destinationRaw')
    value += tracker.move(
      state.safe(node.url, {
        before: value,
        after: node.title ? ' ' : ')',
      }),
    )
  }
  subexit()
  if (node.title) {
    subexit = state.enter(`title${suffix}`)
    value += tracker.move(' ' + quote)
    value += tracker.move(
      state.safe(node.title, {
        before: value,
        after: quote,
      }),
    )
    value += tracker.move(quote)
    subexit()
  }
  value += tracker.move(')')
  exit()
  return value
}
function imagePeek() {
  return '!'
}
imageReference.peek = imageReferencePeek
function imageReference(node: M.ImageReference, _: any, state: State, info: Info) {
  const type = node.referenceType
  const exit = state.enter('imageReference')
  let subexit = state.enter('label')
  const tracker = state.createTracker(info)
  let value = tracker.move('![')
  const alt = state.safe(node.alt, {
    before: value,
    after: ']',
  })
  value += tracker.move(alt + '][')
  subexit()
  // Reference labels escape independently of their enclosing phrasing scope.
  const stack = state.stack
  state.stack = stack.filter(notPhrasing)
  subexit = state.enter('reference')
  const reference = state.safe(state.associationId(node), {
    before: value,
    after: ']',
  })
  subexit()
  state.stack = stack
  exit()
  if (type === 'full' || !alt || alt !== reference) {
    value += tracker.move(reference + ']')
  } else if (type === 'shortcut') {
    value = value.slice(0, -1)
  } else {
    value += tracker.move(']')
  }
  return value
}
function notPhrasing(name: string) {
  return name !== 'phrasing'
}
function imageReferencePeek() {
  return '!'
}
inlineCode.peek = inlineCodePeek
export function inlineCode(node: M.InlineCode, _: any, state: State) {
  let value = node.value || ''
  const sequence = spanFence(value, '`', 1)
  if (
    /[^ \r\n]/.test(value) &&
    ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^`|`$/.test(value))
  ) {
    value = ' ' + value + ' '
  }
  return sequence + breaksToSpaces(value, state) + sequence
}
// Shortest run of `marker`, at least `min` long, that no run in the value matches.
export function spanFence(value: string, marker: string, min: number): string {
  const code = marker.charCodeAt(0)
  const streaks = new Set<number>()
  for (let index = value.indexOf(marker); index !== -1; index = value.indexOf(marker, index + 1)) {
    const start = index
    while (value.charCodeAt(index + 1) === code) index++
    streaks.add(index - start + 1)
  }
  let width = min
  while (streaks.has(width)) width++
  return marker.repeat(width)
}
// Eols followed by block syntax become spaces; spans cannot escape them.
export function breaksToSpaces(value: string, state: State): string {
  if (!value.includes('\n') && !value.includes('\r')) return value
  for (const expression of state.rules.breaks) {
    expression.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = expression.exec(value))) {
      let position = match.index
      if (value.charCodeAt(position) === 10 && value.charCodeAt(position - 1) === 13) {
        position--
      }
      value = value.slice(0, position) + ' ' + value.slice(match.index + 1)
    }
  }
  return value
}
function inlineCodePeek() {
  return '`'
}
function formatLinkAsAutolink(node: M.Link, state: State) {
  const raw = toString(node)
  return Boolean(
    !state.options.resourceLink &&
      node.url &&
      !node.title &&
      node.children &&
      node.children.length === 1 &&
      node.children[0].type === 'text' &&
      (raw === node.url || 'mailto:' + raw === node.url) &&
      /^[a-z][+\-.a-z]+:/i.test(node.url) &&
      !/[\0- <>\u007F]/.test(node.url),
  )
}
link.peek = linkPeek
function link(node: M.Link, _: any, state: State, info: Info) {
  const quote = checkQuote(state)
  const suffix = quote === '"' ? 'Quote' : 'Apostrophe'
  const tracker = state.createTracker(info)
  if (formatLinkAsAutolink(node, state)) {
    // Autolinks reset scope so enclosing constructs do not escape the URL text.
    const stack = state.stack
    state.stack = stack.filter(notPhrasing)
    const exit = state.enter('autolink')
    let autolinkValue = tracker.move('<')
    autolinkValue += tracker.move(
      state.containerPhrasing(node, {
        before: autolinkValue,
        after: '>',
        ...tracker.current(),
      }),
    )
    autolinkValue += tracker.move('>')
    exit()
    state.stack = stack
    return autolinkValue
  }
  const exit = state.enter('link')
  let subexit = state.enter('label')
  let value = tracker.move('[')
  const text = state.containerPhrasing(node, {
    before: value,
    after: '](',
    ...tracker.current(),
  })
  value += tracker.move(text)
  subexit()
  value += tracker.move('](')
  const enclose = /[\0- \u007F]/.test(node.url)
  const last = info.before.charAt(info.before.length - 1)
  let title = node.title || undefined
  if (!title && !enclose && (last === '\n' || last === '\r')) {
    let index = 0
    while (index < text.length && text.charCodeAt(index) !== Char.RightBracket) {
      index += text.charCodeAt(index) === Char.Backslash ? 2 : 1
    }
    if (text.charCodeAt(index + 1) === Char.Colon) title = ''
  }
  if ((!node.url && typeof title === 'string') || enclose) {
    subexit = state.enter('destinationLiteral')
    value += tracker.move('<')
    value += tracker.move(state.safe(node.url, { before: value, after: '>' }))
    value += tracker.move('>')
  } else {
    subexit = state.enter('destinationRaw')
    value += tracker.move(
      state.safe(node.url, {
        before: value,
        after: typeof title === 'string' ? ' ' : ')',
      }),
    )
  }
  subexit()
  if (typeof title === 'string') {
    subexit = state.enter(`title${suffix}`)
    value += tracker.move(' ' + quote)
    value += tracker.move(
      state.safe(title, {
        before: value,
        after: quote,
      }),
    )
    value += tracker.move(quote)
    subexit()
  }
  value += tracker.move(')')
  exit()
  return value
}
function linkPeek(node: M.Link, _: any, state: State) {
  return formatLinkAsAutolink(node, state) ? '<' : '['
}
linkReference.peek = linkReferencePeek
function linkReference(node: M.LinkReference, _: any, state: State, info: Info) {
  const type = node.referenceType
  const exit = state.enter('linkReference')
  let subexit = state.enter('label')
  const tracker = state.createTracker(info)
  let value = tracker.move('[')
  const labelText = state.containerPhrasing(node, {
    before: value,
    after: ']',
    ...tracker.current(),
  })
  value += tracker.move(labelText + '][')
  subexit()
  const stack = state.stack
  state.stack = stack.filter(notPhrasing)
  subexit = state.enter('reference')
  const reference = state.safe(state.associationId(node), {
    before: value,
    after: ']',
    ...tracker.current(),
  })
  subexit()
  state.stack = stack
  exit()
  if (type === 'full' || !labelText || labelText !== reference) {
    value += tracker.move(reference + ']')
  } else if (type === 'shortcut') {
    value = value.slice(0, -1)
  } else {
    value += tracker.move(']')
  }
  return value
}
function linkReferencePeek() {
  return '['
}
function checkBullet(state: State) {
  const marker = state.options.bullet || '*'
  if (marker !== '*' && marker !== '+' && marker !== '-') {
    throw new Error(
      'Cannot serialize items with `' +
        marker +
        '` for `options.bullet`, expected `*`, `+`, or `-`',
    )
  }
  return marker
}
function checkBulletOther(state: State) {
  const bullet = checkBullet(state)
  const bulletOther = state.options.bulletOther
  if (!bulletOther) {
    return bullet === '*' ? '-' : '*'
  }
  if (bulletOther !== '*' && bulletOther !== '+' && bulletOther !== '-') {
    throw new Error(
      'Cannot serialize items with `' +
        bulletOther +
        '` for `options.bulletOther`, expected `*`, `+`, or `-`',
    )
  }
  if (bulletOther === bullet) {
    throw new Error(
      'Expected `bullet` (`' +
        bullet +
        '`) and `bulletOther` (`' +
        bulletOther +
        '`) to be different',
    )
  }
  return bulletOther
}
function checkBulletOrdered(state: State) {
  const marker = state.options.bulletOrdered || '.'
  if (marker !== '.' && marker !== ')') {
    throw new Error(
      'Cannot serialize items with `' +
        marker +
        '` for `options.bulletOrdered`, expected `.` or `)`',
    )
  }
  return marker
}
function checkRule(state: State) {
  const marker = state.options.rule || '*'
  if (marker !== '*' && marker !== '-' && marker !== '_') {
    throw new Error(
      'Cannot serialize rules with `' +
        marker +
        '` for `options.rule`, expected `*`, `-`, or `_`',
    )
  }
  return marker
}
function listBlock(node: M.List, parent: any, state: State, info: Info) {
  const exit = state.enter('list')
  const bulletCurrent = state.bulletCurrent
  let bullet = node.ordered ? checkBulletOrdered(state) : checkBullet(state)
  const bulletOther = node.ordered ? (bullet === '.' ? ')' : '.') : checkBulletOther(state)
  let useDifferentMarker =
    parent && state.bulletLastUsed ? bullet === state.bulletLastUsed : false
  if (!node.ordered) {
    // Different bullets keep empty nested lists from becoming thematic breaks.
    const firstListItem = node.children ? node.children[0] : void 0
    if (
      (bullet === '*' || bullet === '-') &&
      firstListItem &&
      (!firstListItem.children || !firstListItem.children[0]) &&
      state.stack[state.stack.length - 1] === 'list' &&
      state.stack[state.stack.length - 2] === 'listItem' &&
      state.stack[state.stack.length - 3] === 'list' &&
      state.stack[state.stack.length - 4] === 'listItem' &&
      state.indexStack[state.indexStack.length - 1] === 0 &&
      state.indexStack[state.indexStack.length - 2] === 0 &&
      state.indexStack[state.indexStack.length - 3] === 0
    ) {
      useDifferentMarker = true
    }
    // A thematic-break child can also force a different list marker.
    if (checkRule(state) === bullet && firstListItem) {
      let index = -1
      while (++index < node.children.length) {
        const item = node.children[index]
        if (
          item &&
          item.type === 'listItem' &&
          item.children &&
          item.children[0] &&
          item.children[0].type === 'thematicBreak'
        ) {
          useDifferentMarker = true
          break
        }
      }
    }
  }
  if (useDifferentMarker) {
    bullet = bulletOther
  }
  state.bulletCurrent = bullet
  const value = state.containerFlow(node, info)
  state.bulletLastUsed = bullet
  state.bulletCurrent = bulletCurrent
  exit()
  return value
}
function checkListItemIndent(state: State) {
  const style = state.options.listItemIndent || 'one'
  if (style !== 'tab' && style !== 'one' && style !== 'mixed') {
    throw new Error(
      'Cannot serialize items with `' +
        style +
        '` for `options.listItemIndent`, expected `tab`, `one`, or `mixed`',
    )
  }
  return style
}
export function listItem(node: M.ListItem, parent: any, state: State, info: Info) {
  const listItemIndent = checkListItemIndent(state)
  let bullet = state.bulletCurrent || checkBullet(state)
  if (parent && parent.type === 'list' && parent.ordered) {
    bullet =
      (typeof parent.start === 'number' && parent.start > -1 ? parent.start : 1) +
      (state.options.incrementListMarker === false ? 0 : parent.children.indexOf(node)) +
      bullet
  }
  let size = bullet.length + 1
  if (
    listItemIndent === 'tab' ||
    (listItemIndent === 'mixed' &&
      ((parent && parent.type === 'list' && parent.spread) || node.spread))
  ) {
    size = Math.ceil(size / TAB_SIZE) * TAB_SIZE
  }
  const tracker = state.createTracker(info)
  tracker.move(bullet + ' '.repeat(size - bullet.length))
  tracker.shift(size)
  const exit = state.enter('listItem')
  const value = state.indentLines(state.containerFlow(node, tracker.current()), indentItemLine)
  exit()
  return value
  function indentItemLine(line: string, index: number, blank: boolean) {
    if (index) {
      return (blank ? '' : ' '.repeat(size)) + line
    }
    return (blank ? bullet : bullet + ' '.repeat(size - bullet.length)) + line
  }
}
export function paragraph(node: M.Paragraph, _: any, state: State, info: Info) {
  const exit = state.enter('paragraph')
  const subexit = state.enter('phrasing')
  const value = state.containerPhrasing(node, info)
  subexit()
  exit()
  return value
}
const phrasingTypes = new Set([
  'break',
  'delete',
  'emphasis',
  'footnote',
  'footnoteReference',
  'image',
  'imageReference',
  'inlineCode',
  'inlineMath',
  'link',
  'linkReference',
  'mdxJsxTextElement',
  'mdxTextExpression',
  'strong',
  'text',
  'textDirective',
])
function root(node: M.Root, _: any, state: State, info: Info) {
  const hasPhrasing = node.children.some((node) => phrasingTypes.has(node.type))
  if (!hasPhrasing) return state.containerFlow(node, info)
  const exit = state.enter('phrasing')
  const value = state.containerPhrasing(node, info)
  exit()
  return value
}
function checkStrong(state: State) {
  const marker = state.options.strong || '*'
  if (marker !== '*' && marker !== '_') {
    throw new Error(
      'Cannot serialize strong with `' +
        marker +
        '` for `options.strong`, expected `*`, or `_`',
    )
  }
  return marker
}
strong.attention = strongAttention
strong.peek = strongPeek
function strong(node: M.Strong, _: any, state: State, info: Info) {
  const exit = state.enter('phrasing')
  const item = attentionItem(node, strongAttention, state, state.createTracker(info))
  const value = item ? serializeItems([item], info.before, info.after) : ''
  exit()
  return value
}
const strongAsterisk = attentionSpec('strong', ['*', '_'], [2])
const strongUnderscore = attentionSpec('strong', ['_', '*'], [2])
function strongAttention(_: any, state: State) {
  return checkStrong(state) === '*' ? strongAsterisk : strongUnderscore
}
function strongPeek(_: any, _1: any, state: State) {
  return state.options.strong || '*'
}
text.peek = textPeek
function textPeek(node: M.Text, parent: any, state: State, info: Info) {
  const value = node.value || ''
  const code = value.charCodeAt(0)
  if (!state.rules.custom && code !== 92 && !state.rules.characters[code])
    return highSurrogate(code) ? value.slice(0, 2) : value.charAt(0)
  // Built-in rules inspect at most one following character; include the neighbor's context too.
  if (!state.rules.custom)
    return safe(state, value.slice(0, 2), {
      before: info.before,
      after: value.length > 2 ? value.charAt(2) : info.after,
    }).charAt(0)
  return text(node, parent, state, info)
}
function text(node: M.Text, parent: any, state: State, info: Info) {
  if (!state.rules.custom) return state.safe(node.value, info)
  const siblings = parent ? parent.children : []
  const index = state.indexStack[state.indexStack.length - 1]
  return state.safe(node.value, {
    ...info,
    afterNode: siblings[index + 1],
    beforeNode: siblings[index - 1],
  })
}
function checkRuleRepetition(state: State) {
  const repetition = state.options.ruleRepetition || MIN_THEMATIC_MARKERS
  if (repetition < MIN_THEMATIC_MARKERS) {
    throw new Error(
      'Cannot serialize rules with repetition `' +
        repetition +
        '` for `options.ruleRepetition`, expected `3` or more',
    )
  }
  return repetition
}
function thematicBreak(_: any, _1: any, state: State) {
  const value = (checkRule(state) + (state.options.ruleSpaces ? ' ' : '')).repeat(
    checkRuleRepetition(state),
  )
  return state.options.ruleSpaces ? value.slice(0, -1) : value
}
const handle: Record<string, Handler> = {
  blockquote,
  break: hardBreak,
  code,
  definition,
  emphasis,
  hardBreak,
  heading,
  html,
  image,
  imageReference,
  inlineCode,
  link,
  linkReference,
  list: listBlock,
  listItem,
  paragraph,
  root,
  strong,
  text,
  thematicBreak,
}
const join = [joinDefaults]
function joinDefaults(left: any, right: any, parent: any, state: State) {
  if (
    right.type === 'code' &&
    formatCodeAsIndented(right, state) &&
    (left.type === 'list' || (left.type === right.type && formatCodeAsIndented(left, state)))
  ) {
    return false
  }
  if (typeof parent.spread === 'boolean') {
    if (parent.spread) return 1
    if (left.type === 'html') {
      const kind = htmlKind(left.value)
      if (kind === undefined || kind === HtmlKind.Basic || kind === HtmlKind.Complete) return 1
    }
    if (left.type === 'blockquote' && right.type === 'blockquote') return 1
    if (
      (left.type === 'definition' || left.type === 'paragraph') &&
      right.type === 'list' &&
      ((right.ordered && typeof right.start === 'number' && right.start !== 1) ||
        (right.children.length > 0 && right.children[0].children.length === 0))
    ) {
      return 1
    }
    if (
      left.type === 'paragraph' &&
      right.type === 'thematicBreak' &&
      checkRule(state) === '-' &&
      !state.options.ruleSpaces
    ) {
      return 1
    }
    let tail = left
    while (
      (tail.type === 'blockquote' || tail.type === 'list' || tail.type === 'listItem') &&
      tail.children.length > 0
    ) {
      tail = tail.children[tail.children.length - 1]
    }
    if (tail.type !== 'definition' && tail.type !== 'paragraph') return 0
    if (right.type === 'code' && formatCodeAsIndented(right, state)) return 1
    if (right.type === 'html') {
      const kind = htmlKind(right.value)
      if (kind === undefined || kind === HtmlKind.Complete) return 1
    }
    if (
      (left.type === 'paragraph' || left !== tail) &&
      (right.type === 'definition' ||
        (right.type === 'heading' && formatHeadingAsSetext(right, state)) ||
        right.type === 'paragraph')
    ) {
      return 1
    }
    return 0
  }
}
const fullPhrasingSpans: string[] = [
  'autolink',
  'destinationLiteral',
  'destinationRaw',
  'reference',
  'titleQuote',
  'titleApostrophe',
]
const unsafe: Unsafe[] = [
  { character: '	', after: '[\\r\\n]', inConstruct: 'phrasing' },
  { character: '	', before: '[\\r\\n]', inConstruct: 'phrasing' },
  {
    character: '	',
    inConstruct: ['codeFencedLangGraveAccent', 'codeFencedLangTilde'],
  },
  {
    character: '\r',
    inConstruct: [
      'codeFencedLangGraveAccent',
      'codeFencedLangTilde',
      'codeFencedMetaGraveAccent',
      'codeFencedMetaTilde',
      'destinationLiteral',
      'headingAtx',
    ],
  },
  {
    character: '\n',
    inConstruct: [
      'codeFencedLangGraveAccent',
      'codeFencedLangTilde',
      'codeFencedMetaGraveAccent',
      'codeFencedMetaTilde',
      'destinationLiteral',
      'headingAtx',
    ],
  },
  { character: '\r', before: '[\\r\\n]', inConstruct: 'phrasing' },
  { character: '\r', after: '\\r', inConstruct: 'phrasing' },
  { character: '\n', before: '\\n', inConstruct: 'phrasing' },
  { character: '\n', after: '[\\r\\n]', inConstruct: 'phrasing' },
  { character: ' ', after: '[\\r\\n]', inConstruct: 'phrasing' },
  { character: ' ', before: '[\\r\\n]', inConstruct: 'phrasing' },
  {
    character: ' ',
    inConstruct: ['codeFencedLangGraveAccent', 'codeFencedLangTilde'],
  },
  {
    character: '!',
    after: '\\[',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { character: '"', inConstruct: 'titleQuote' },
  { atBreak: true, character: '#' },
  { character: '#', inConstruct: 'headingAtx', after: '(?:[\r\n]|$)' },
  {
    character: '&',
    after: '[#A-Za-z]',
    inConstruct: [
      'codeFencedLangGraveAccent',
      'codeFencedLangTilde',
      'codeFencedMetaGraveAccent',
      'codeFencedMetaTilde',
      'destinationLiteral',
      'destinationRaw',
      'phrasing',
      'titleApostrophe',
      'titleQuote',
    ],
  },
  { character: "'", inConstruct: 'titleApostrophe' },
  { character: '(', inConstruct: 'destinationRaw' },
  {
    before: '\\]',
    character: '(',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { atBreak: true, before: '\\d+', character: ')' },
  { character: ')', inConstruct: 'destinationRaw' },
  { atBreak: true, character: '*', after: '(?:[ 	\r\n*])' },
  {
    character: '*',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { atBreak: true, character: '+', after: '(?:[ 	\r\n])' },
  { atBreak: true, character: '-', after: '(?:[ 	\r\n-])' },
  { atBreak: true, before: '\\d+', character: '.', after: '(?:[ 	\r\n]|$)' },
  { atBreak: true, character: '<', after: '[!/?A-Za-z]' },
  {
    character: '<',
    after: '[!/?A-Za-z]',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { character: '<', inConstruct: 'destinationLiteral' },
  { atBreak: true, character: '=' },
  { atBreak: true, character: '>' },
  { character: '>', inConstruct: 'destinationLiteral' },
  { atBreak: true, character: '[' },
  {
    character: '[',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { character: '[', inConstruct: ['label', 'reference'] },
  { character: '\\', after: '[\\r\\n]', inConstruct: 'phrasing' },
  { character: ']', inConstruct: ['label', 'reference'] },
  { atBreak: true, character: '_' },
  {
    character: '_',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { atBreak: true, character: '`' },
  {
    character: '`',
    inConstruct: ['codeFencedLangGraveAccent', 'codeFencedMetaGraveAccent'],
  },
  {
    character: '`',
    inConstruct: 'phrasing',
    notInConstruct: fullPhrasingSpans,
  },
  { atBreak: true, character: '~' },
  { character: '<', inConstruct: 'autolink' },
  { character: '>', inConstruct: 'autolink' },
  { character: '\u007F', inConstruct: 'autolink' },
]
for (let code = 0; code <= Char.Space; code++) {
  unsafe.push({ character: String.fromCharCode(code), inConstruct: 'autolink' })
}
function decodeString(value: string): string {
  // Same CommonMark invalid-code-point rules as scan.ts; this path also handles labels.
  return value.replace(
    /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi,
    (whole, escape: string, reference: string) => {
      if (escape) return escape
      if (reference[0] !== '#')
        return Object.hasOwn(characterEntities, reference)
          ? characterEntities[reference]
          : whole
      const code =
        reference[1].toLowerCase() === 'x'
          ? parseInt(reference.slice(2), 16)
          : parseInt(reference.slice(1), 10)
      return code < 9 ||
        code === 11 ||
        (code > 13 && code < 32) ||
        (code > 126 && code < 160) ||
        (code > 55295 && code < 57344) ||
        (code > 64975 && code < 65008) ||
        (code & 65535) === 65535 ||
        (code & 65535) === 65534 ||
        code > 1114111
        ? '\uFFFD'
        : String.fromCodePoint(code)
    },
  )
}
function association(node: { label?: string | null; identifier?: string }) {
  if (node.label || !node.identifier) {
    return node.label || ''
  }
  return decodeString(node.identifier)
}
const strictMarkers = new Map([
  ['*', false],
  ['_', true],
])
interface AttentionResult {
  children: Item[]
  sequences: string[]
}
type Item = AttentionResult | string
interface Token {
  value: string
  attention: AttentionResult | undefined
}
interface Run {
  tokens: Token[]
  markers: Token[]
  start: number
  end: number
  open: boolean
  close: boolean
  split: boolean
}
interface Mistake {
  attention: AttentionResult[]
  index: number
}
interface Improvement {
  chosen: Map<AttentionResult, string>
  tokens: Token[]
  mistake: Mistake | undefined
}
function highSurrogate(code: number) {
  return code >= Surrogate.HighStart && code <= Surrogate.HighEnd
}
function lowSurrogate(code: number) {
  return code >= Surrogate.LowStart && code <= Surrogate.LowEnd
}
function firstCharacter(value: string) {
  return highSurrogate(value.charCodeAt(0)) && lowSurrogate(value.charCodeAt(1))
    ? value.slice(0, 2)
    : value.charAt(0)
}
function lastCharacter(value: string) {
  const last = value.length - 1
  return lowSurrogate(value.charCodeAt(last)) && highSurrogate(value.charCodeAt(last - 1))
    ? value.slice(-2)
    : value.slice(-1)
}
function candidates(tokens: Token[], involved: Token[], runOf: Map<Token, Run>) {
  const related = new Set<AttentionResult | undefined>()
  for (const token of tokens) {
    const siblings = runOf.get(token)
    if (siblings && token.attention && involved.some((d) => d.attention === token.attention)) {
      for (const sibling of siblings.tokens) related.add(sibling.attention)
    }
  }
  const ordered: AttentionResult[] = []
  for (const token of tokens) {
    if (token.attention && related.delete(token.attention)) ordered.push(token.attention)
  }
  ordered.reverse()
  return ordered
}
function check(tokens: Token[], before: string, after: string): Mistake | undefined {
  const runs: Run[] = []
  const wrong = new Map<Token, Token[]>()
  const runOf = new Map<Token, Run>()
  let index = 0
  while (index < tokens.length) {
    if (!tokens[index].attention) {
      index++
      continue
    }
    const marker = tokens[index].value.charAt(0)
    const strict = strictMarkers.get(marker)
    let end = index + 1
    while (
      end < tokens.length &&
      tokens[end].attention &&
      tokens[end].value.charAt(0) === marker
    ) {
      end++
    }
    const head = index ? tokens[index - 1].value : before
    const previous = classifyCharacter(head.charCodeAt(head.length - 1))
    const next = classifyCharacter((end < tokens.length ? tokens[end].value : after).charCodeAt(0))
    const open = !next || (next === CharacterKind.Punctuation && Boolean(previous))
    const close = !previous || (previous === CharacterKind.Punctuation && Boolean(next))
    const run: Run = {
      tokens: tokens.slice(index, end),
      markers: [],
      start: 0,
      end: 0,
      open: strict ? open && (Boolean(previous) || !close) : open,
      close: strict ? close && (Boolean(next) || !open) : close,
      split: strict !== undefined,
    }
    for (const token of run.tokens) {
      wrong.set(token, [...run.tokens])
      runOf.set(token, run)
      let size = token.value.length
      while (size--) run.markers.push(token)
    }
    run.end = run.markers.length
    runs.push(run)
    index = end
  }
  pair(runs, wrong)
  index = -1
  while (++index < tokens.length) {
    const involved = wrong.get(tokens[index])
    if (involved) return { attention: candidates(tokens, involved, runOf), index }
  }
}
function containerPhrasing(parent: any, state: State, info: Info) {
  return serializeItems(phrasingItems(parent, state, info), info.before, info.after)
}
function encode(tokens: Token[], start: boolean) {
  const token = tokens[start ? 0 : tokens.length - 1]
  if (!token || token.attention) return
  const character = start ? firstCharacter(token.value) : lastCharacter(token.value)
  const code = character.codePointAt(0)
  if (code === undefined) return
  const reference = encodeCharacterReference(code)
  if (start) {
    token.value = reference + token.value.slice(character.length)
  } else {
    let value = token.value.slice(0, token.value.length - character.length)
    let escapes = 0
    while (value.charCodeAt(value.length - 1 - escapes) === Char.Backslash) escapes++
    if (escapes % 2) value += '\\'
    token.value = value + reference
  }
}
function improve(
  items: Item[],
  chosen: Map<AttentionResult, string>,
  mistake: Mistake,
  before: string,
  after: string,
): Improvement | undefined {
  for (const attention of mistake.attention) {
    const current = chosen.get(attention) || attention.sequences[0]
    for (const sequence of attention.sequences) {
      if (sequence === current) continue
      const trial = new Map(chosen)
      trial.set(attention, sequence)
      const tokens = render(items, trial, before, after)
      const next = check(tokens, before, after)
      if (!next || next.index > mistake.index) return { chosen: trial, mistake: next, tokens }
    }
  }
}
function pair(runs: Run[], wrong: Map<Token, Token[]>) {
  const openersByMarker = new Map<string, Run[]>()
  for (const closer of runs) {
    const marker = closer.tokens[0].value.charAt(0)
    let openers = openersByMarker.get(marker)
    if (!openers) {
      openers = []
      openersByMarker.set(marker, openers)
    }
    let open = closer.close ? openers.length : 0
    while (open-- && closer.start < closer.end) {
      const opener = openers[open]
      const openerSize = opener.end - opener.start
      const closerSize = closer.end - closer.start
      if (
        closer.split
          ? (opener.close || closer.open) && closerSize % 3 && !((openerSize + closerSize) % 3)
          : openerSize !== opener.markers.length || openerSize !== closerSize
      ) {
        continue
      }
      const size = closer.split ? (openerSize > 1 && closerSize > 1 ? 2 : 1) : closerSize
      const opening = opener.markers.slice(opener.end - size, opener.end)
      const closing = closer.markers.slice(closer.start, closer.start + size)
      const openToken = opening[0]
      const closeToken = closing[0]
      if (
        openToken === opening[size - 1] &&
        openToken.value.length === size &&
        closeToken === closing[size - 1] &&
        closeToken.value.length === size &&
        openToken.attention === closeToken.attention
      ) {
        wrong.delete(openToken)
        wrong.delete(closeToken)
      } else {
        const involved = [...new Set([...opening, ...closing])]
        for (const token of involved) {
          const list = wrong.get(token)
          if (list) list.push(...involved)
        }
      }
      opener.end -= size
      closer.start += size
      if (opener.start === opener.end) openers.splice(open, 1)
      open = openers.length
    }
    if (closer.open && closer.start < closer.end) openers.push(closer)
  }
}
export function attentionSpec(construct: string, markers: string[], sizes: number[]) {
  const spec: AttentionSpec = { construct, markers, sizes }
  knownSequences.set(spec, attentionSequences(construct, markers, sizes))
  return spec
}
function attentionSequences(type: string, markers: string[], sizes: number[]) {
  if (markers.length === 0) {
    throw new Error(
      'Cannot serialize `' + type + '` as attention without markers, expected one or more markers',
    )
  }
  if (sizes.length === 0) {
    throw new Error(
      'Cannot serialize `' + type + '` as attention without sizes, expected one or more sizes',
    )
  }
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error(
        'Cannot serialize `' +
          type +
          '` as attention with `' +
          size +
          '` as size, expected positive integer',
      )
    }
  }
  const sequences: string[] = []
  for (const marker of markers) {
    if (marker.length !== 1) {
      throw new Error(
        'Cannot serialize `' +
          type +
          '` as attention with `' +
          marker +
          '` as marker, expected a single ascii character',
      )
    }
    if (!punctuation(marker.charCodeAt(0))) {
      throw new Error(
        'Cannot serialize `' +
          type +
          '` as attention with `' +
          marker +
          '` as marker, expected ascii punctuation',
      )
    }
    for (const size of sizes) sequences.push(marker.repeat(size))
  }
  return sequences
}
function phrasingItems(parent: any, state: State, info: Info): Item[] {
  // ── Peek neighbors, serialize each child, keep attention open to choose sequences later ──
  const indexStack = state.indexStack
  const children = parent.children || []
  const results: Item[] = []
  let index = -1
  let before = info.before
  indexStack.push(-1)
  let tracker = state.createTracker(info)
  const childInfo: Info = { before: '', after: '', now: info.now, lineShift: info.lineShift }
  while (++index < children.length) {
    const child = children[index]
    let after: string
    indexStack[indexStack.length - 1] = index
    if (index + 1 < children.length) {
      let nextHandler = state.handle.handlers[children[index + 1].type]
      if (nextHandler && nextHandler.peek) nextHandler = nextHandler.peek
      const current = tracker.current()
      after = nextHandler
        ? firstCharacter(
            nextHandler(children[index + 1], parent, state, {
              before: '',
              after: '',
              now: current.now,
              lineShift: current.lineShift,
            }),
          )
        : ''
    } else {
      after = info.after
    }
    let value: string
    if (child.type === 'text' && !state.customHandlers) {
      const current = tracker.current()
      childInfo.now = current.now
      childInfo.lineShift = current.lineShift
      childInfo.before = before
      childInfo.after = after
      value = state.rules.custom
        ? text(child, parent, state, childInfo)
        : safe(state, child.value, childInfo)
    } else {
      // A newline before inline HTML would reparse as flow HTML; replace it with a space.
      const previous = results[results.length - 1]
      if (
        child.type === 'html' &&
        typeof previous === 'string' &&
        (before === '\r' || before === '\n') &&
        htmlKind(child.value) !== HtmlKind.Complete
      ) {
        results[results.length - 1] = previous.replace(/(\r?\n|\r)$/, ' ')
        before = ' '
        tracker = state.createTracker(info)
        if (tracker !== untracked) tracker.move(serializeItems(results, info.before, info.after))
      }
      const handler = state.handle.handlers[child.type]
      if (handler && handler.attention) {
        const item = attentionItem(child, handler.attention, state, tracker)
        if (!item) continue
        results.push(item)
        before = lastCharacter(item.sequences[0])
        continue
      }
      const current = tracker.current()
      childInfo.now = current.now
      childInfo.lineShift = current.lineShift
      childInfo.before = before
      childInfo.after = after
      value = state.handle(
        child,
        parent,
        state,
        state.customHandlers ? { ...childInfo } : childInfo,
      )
    }
    if (!value) continue
    tracker.move(value)
    results.push(value)
    before = lastCharacter(value)
  }
  indexStack.pop()
  return results
}
function attentionItem(
  node: any,
  attention: Attention,
  state: State,
  tracker: Tracker,
): AttentionResult | undefined {
  const spec = attention(node, state)
  const sequences =
    knownSequences.get(spec) || attentionSequences(node.type, spec.markers, spec.sizes)
  const sequence = sequences[0]
  const exit = state.enter(spec.construct)
  const inside = state.createTracker(tracker.current())
  inside.move(sequence)
  const current = inside.current()
  const children = phrasingItems(node, state, {
    before: sequence,
    after: sequence,
    now: current.now,
    lineShift: current.lineShift,
  })
  exit()
  if (children.length === 0) return
  if (tracker !== untracked) {
    tracker.move(sequence)
    tracker.move(serializeItems(children, sequence, sequence))
    tracker.move(sequence)
  }
  return { children, sequences }
}
function fix(
  items: Item[],
  chosen: Map<AttentionResult, string>,
  before: string,
  after: string,
): Token[] | undefined {
  let tokens = render(items, chosen, before, after)
  let mistake = check(tokens, before, after)
  while (mistake) {
    const next = improve(items, chosen, mistake, before, after)
    if (!next) return
    chosen = next.chosen
    tokens = next.tokens
    mistake = next.mistake
  }
  return tokens
}
function guess(
  items: Item[],
  chosen: Map<AttentionResult, string>,
  before: string,
  after: string,
) {
  let previous = before
  let index = -1
  while (++index < items.length) {
    const item = items[index]
    if (typeof item === 'string') {
      previous = ''
      continue
    }
    const next = index === items.length - 1 ? after : ''
    let sequence = item.sequences[0]
    for (const value of item.sequences) {
      const marker = value.charAt(0)
      if (
        (marker !== previous.charAt(0) && marker !== next.charAt(0)) ||
        (items.length === 1 && strictMarkers.has(marker) && value.length > before.length)
      ) {
        sequence = value
        break
      }
    }
    if (sequence !== item.sequences[0]) chosen.set(item, sequence)
    guess(item.children, chosen, sequence, sequence)
    previous = sequence
  }
}
function render(
  items: Item[],
  chosen: Map<AttentionResult, string>,
  before: string,
  after: string,
): Token[] {
  const tokens: Token[] = []
  let encodeAfter: string | undefined
  let previous = lastCharacter(before)
  let index = -1
  while (++index < items.length) {
    const item = items[index]
    if (typeof item === 'string') {
      const token: Token = { value: item, attention: undefined }
      if (encodeAfter && encodeAfter === firstCharacter(item)) encode([token], true)
      encodeAfter = undefined
      tokens.push(token)
      if (token.value) previous = lastCharacter(token.value)
      continue
    }
    const sequence = chosen.get(item) || item.sequences[0]
    const marker = sequence.charAt(0)
    const next = items[index + 1]
    const outsideBefore = previous
    const outsideAfter = firstCharacter(
      next === undefined
        ? after
        : typeof next === 'string'
          ? next
          : chosen.get(next) || next.sequences[0],
    )
    const inside = render(item.children, chosen, sequence, sequence)
    const head = inside[0].value
    const open = encodeInfo(
      outsideBefore.charCodeAt(outsideBefore.length - 1),
      head.charCodeAt(0),
      marker,
    )
    if (open.inside) encode(inside, true)
    const tail = lastCharacter(inside[inside.length - 1].value)
    const close = encodeInfo(outsideAfter.charCodeAt(0), tail.charCodeAt(tail.length - 1), marker)
    if (close.inside) encode(inside, false)
    if (open.outside && outsideBefore !== '\n' && outsideBefore !== '\r') encode(tokens, false)
    if (close.outside) encodeAfter = outsideAfter
    tokens.push({ value: sequence, attention: item }, ...inside, { value: sequence, attention: item })
    previous = sequence.charAt(sequence.length - 1)
  }
  return tokens
}
function serializeItems(items: Item[], before: string, after: string): string {
  let index = -1
  while (++index < items.length) if (typeof items[index] !== 'string') break
  if (index === items.length) return items.join('')
  const guessed = new Map<AttentionResult, string>()
  guess(items, guessed, before, after)
  const tokens =
    (guessed.size > 0 ? fix(items, guessed, before, after) : undefined) ||
    fix(items, new Map(), before, after) ||
    render(items, new Map(), before, after)
  let result = ''
  for (const token of tokens) result += token.value
  return result
}
const htmlRawNames = new Set(['pre', 'script', 'style', 'textarea'])
function htmlKind(value: string): HtmlKind | undefined {
  if (value.charCodeAt(0) !== Char.LessThan) return
  const next = value.charCodeAt(1)
  if (next === Char.Exclamation) {
    const code = value.charCodeAt(2)
    if (code === Char.Hyphen) return HtmlKind.Comment
    if (code === Char.LeftBracket) return HtmlKind.Cdata
    if (alpha(code)) return HtmlKind.Declaration
    return
  }
  if (next === Char.Question) return HtmlKind.Instruction
  const closing = next === Char.Slash
  const start = closing ? 2 : 1
  let end = start
  let code = value.charCodeAt(end)
  if (!alpha(code)) return
  while (code === Char.Hyphen || alpha(code) || digit(code)) code = value.charCodeAt(++end)
  const name = value.slice(start, end).toLowerCase()
  if (!closing && code !== Char.Slash && htmlRawNames.has(name)) return HtmlKind.Raw
  return htmlBlocks.has(name) ? HtmlKind.Basic : HtmlKind.Complete
}
function containerFlow(parent: any, state: State, info: Info) {
  const indexStack = state.indexStack
  const children = parent.children || []
  const tracker = state.createTracker(info)
  const results: string[] = []
  const childInfo: Info = {
    before: '\n',
    after: '\n',
    now: info.now,
    lineShift: info.lineShift,
  }
  let index = -1
  indexStack.push(-1)
  while (++index < children.length) {
    const child = children[index]
    indexStack[indexStack.length - 1] = index
    const current = tracker.current()
    childInfo.now = current.now
    childInfo.lineShift = current.lineShift
    results.push(
      tracker.move(
        state.handle(child, parent, state, state.customHandlers ? { ...childInfo } : childInfo),
      ),
    )
    if (child.type !== 'list') {
      state.bulletLastUsed = void 0
    }
    if (index < children.length - 1) {
      results.push(tracker.move(between(child, children[index + 1], parent, state)))
    }
  }
  indexStack.pop()
  return results.join('')
}
function between(left: any, right: any, parent: any, state: State) {
  // Join numbers count extra newlines; false requires an HTML-comment separator.
  let index = state.join.length
  while (index--) {
    const result = state.join[index](left, right, parent, state)
    if (result === true || result === 1) {
      break
    }
    if (typeof result === 'number') {
      return '\n'.repeat(1 + result)
    }
    if (result === false) {
      return '\n\n<!---->\n\n'
    }
  }
  return '\n\n'
}
function indentLines(
  value: string,
  mapLine: (line: string, index: number, blank: boolean) => string,
): string {
  let result = ''
  let start = 0
  let line = 0
  let lf = value.indexOf('\n')
  let cr = value.indexOf('\r')
  while (lf !== -1 || cr !== -1) {
    const index = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
    const segment = value.slice(start, index)
    result += mapLine(segment, line, !segment)
    const end = index === cr && lf === cr + 1 ? index + 2 : index + 1
    result += value.slice(index, end)
    start = end
    if (lf !== -1 && lf < end) lf = value.indexOf('\n', end)
    if (cr !== -1 && cr < end) cr = value.indexOf('\r', end)
    line++
  }
  const segment = value.slice(start)
  return result + mapLine(segment, line, !segment)
}
function track(config: Partial<TrackerInfo> = {}): Tracker {
  const options = config || {}
  const now = options.now || { line: 1, column: 1 }
  let lineShift = options.lineShift || 0
  let line = now.line || 1
  let column = now.column || 1
  return { move, current, shift }
  function current() {
    return { now: { line, column }, lineShift }
  }
  function shift(value: number) {
    lineShift += value
  }
  function move(input?: string | null) {
    const value = input || ''
    let tail = 0
    let lines = 0
    let lf = value.indexOf('\n')
    let cr = value.indexOf('\r')
    while (lf !== -1 || cr !== -1) {
      const index = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
      lines++
      tail = index + (index === cr && lf === cr + 1 ? 2 : 1)
      if (lf !== -1 && lf < tail) lf = value.indexOf('\n', tail)
      if (cr !== -1 && cr < tail) cr = value.indexOf('\r', tail)
    }
    line += lines
    column = lines ? 1 + value.length - tail + lineShift : column + value.length
    return value
  }
}
// Only MDX wrapping and user handlers read positions; escaping uses before/after.
const untrackedInfo: TrackerInfo = { now: { line: 1, column: 1 }, lineShift: 0 }
const untracked: Tracker = {
  current: () => untrackedInfo,
  shift: () => {},
  move: (value) => value || '',
}
function needsTracking(options: StringifyOptions): boolean {
  return (
    Boolean(options.handlers && Object.keys(options.handlers).length) ||
    Boolean(options.join?.length) ||
    Boolean(options.extensions?.some(needsTracking))
  )
}
function stringifyTree(
  tree: Nodes,
  options: StringifyOptions,
  config: Config,
  customUnsafe: boolean,
  tracking: boolean,
  customHandlers: boolean,
) {
  const setup = configure(
    {
      handlers: { ...handle },
      join: [...join],
      options: {},
      unsafe: [...unsafe],
    },
    options,
  )
  const state: State = {
    ...setup,
    customHandlers,
    associationId: association,
    rules: prepareRules(config, setup.unsafe, customUnsafe),
    containerPhrasing: containerPhrasingBound,
    containerFlow: containerFlowBound,
    createTracker: tracking ? track : () => untracked,
    compilePattern,
    enter,
    handle: Object.assign((node, parent, state, info) => dispatch(node, parent, state, info), {
      handlers: setup.handlers,
    }),
    indentLines,
    indexStack: [],
    safe: safeBound,
    stack: [],
  }
  if (state.options.tightDefinitions) {
    state.join.push(joinDefinition)
  }
  let result = state.handle(
    phrasingTypes.has(tree.type) ? { type: 'root', children: [tree] } : tree,
    void 0,
    state,
    { before: '\n', after: '\n', now: { line: 1, column: 1 }, lineShift: 0 },
  )
  if (
    result &&
    result.charCodeAt(result.length - 1) !== 10 &&
    result.charCodeAt(result.length - 1) !== 13
  ) {
    result += '\n'
  }
  return result
  function enter(name: string) {
    state.scopedRules = undefined
    state.stack.push(name)
    return exit
  }
  function exit() {
    state.scopedRules = undefined
    state.stack.pop()
  }
}
function invalid(value: unknown): never {
  throw new Error('Cannot handle value `' + value + '`, expected node')
}
function dispatch(node: any, parent: any, state: State, info: Info): string {
  if (!node || typeof node.type !== 'string') return invalid(node)
  const handler = state.handlers[node.type]
  if (handler !== handle[node.type]) {
    return handler ? handler(node, parent, state, info) : unknown(node)
  }
  // Direct built-in calls avoid megamorphic dispatch while retaining user overrides.
  switch (node.type) {
    case 'blockquote':
      return blockquote(node, parent, state, info)
    case 'break':
    case 'hardBreak':
      return hardBreak(node, parent, state, info)
    case 'code':
      return code(node, parent, state, info)
    case 'definition':
      return definition(node, parent, state, info)
    case 'emphasis':
      return emphasis(node, parent, state, info)
    case 'heading':
      return heading(node, parent, state, info)
    case 'html':
      return html(node)
    case 'image':
      return image(node, parent, state, info)
    case 'imageReference':
      return imageReference(node, parent, state, info)
    case 'inlineCode':
      return inlineCode(node, parent, state)
    case 'link':
      return link(node, parent, state, info)
    case 'linkReference':
      return linkReference(node, parent, state, info)
    case 'list':
      return listBlock(node, parent, state, info)
    case 'listItem':
      return listItem(node, parent, state, info)
    case 'paragraph':
      return paragraph(node, parent, state, info)
    case 'root':
      return root(node, parent, state, info)
    case 'strong':
      return strong(node, parent, state, info)
    case 'text':
      return text(node, parent, state, info)
    case 'thematicBreak':
      return thematicBreak(node, parent, state)
    default:
      return unknown(node)
  }
}
function unknown(value: any): never {
  const node = value
  throw new Error('Cannot handle unknown node `' + node.type + '`')
}
function joinDefinition(left: any, right: any) {
  if (left.type === 'definition' && left.type === right.type) {
    return 0
  }
}
function containerPhrasingBound(this: State, parent: any, info: Info) {
  return containerPhrasing(parent, this, info)
}
function containerFlowBound(this: State, parent: any, info: Info) {
  return containerFlow(parent, this, info)
}
function safeBound(this: State, value: string | null | undefined, config: SafeConfig) {
  return safe(this, value, config)
}
export function toMarkdown(tree: Nodes, config: Config, options: StringifyOptions = {}) {
  const extensions: StringifyOptions[] = []
  if (config.mdx) extensions.push(mdxToMarkdown(options))
  if (config.frontmatter)
    extensions.push(
      frontmatterToMarkdown([
        ...(config.frontmatter.yaml ? ['yaml'] : []),
        ...(config.frontmatter.toml ? ['toml'] : []),
      ]),
    )
  if (config.gfm) extensions.push(gfmToMarkdown(options))
  if (config.math) extensions.push(mathToMarkdown(config.math.singleDollarTextMath))
  if (config.headingId)
    extensions.push({
      handlers: {
        idString(node) {
          return (
            '{#' +
            node.value.replace(/[&{}\\\r\n\t|]/g, (c: string) => '&#' + c.charCodeAt(0) + ';') +
            '}'
          )
        },
      },
    })
  extensions.push(...(options.extensions || []))
  const customHandlers = needsTracking(options)
  return stringifyTree(
    tree,
    { ...options, extensions },
    config,
    hasCustomUnsafe(options),
    customHandlers || Boolean(config.mdx && Number.isFinite(options.printWidth)),
    customHandlers,
  )
}
function hasCustomUnsafe(options: StringifyOptions): boolean {
  return Boolean(options.unsafe?.length || options.extensions?.some(hasCustomUnsafe))
}

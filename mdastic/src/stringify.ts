// CommonMark serializer ported from mdast-util-to-markdown 2.1.2 (MIT, Titus Wormer).
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
  type Unsafe,
  type SafeConfig,
  type RuleTable,
  type ScopedRules,
} from './stringify-safe.ts'
import { entities as characterEntities } from './entities.ts'
import type { Config } from './syntax.ts'
import type { Nodes } from './types.ts'
import type * as M from './types.ts'
import {
  gfmToMarkdown,
  mdxToMarkdown,
  frontmatterToMarkdown,
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
export type Handler = ((
  node: any,
  parent: any,
  state: State,
  info: Info,
) => string) & { peek?: Handler }
export type Join = (
  left: any,
  right: any,
  parent: any,
  state: State,
) => number | boolean | void
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
  attentionEncodeSurroundingInfo?: { before: boolean; after: boolean }
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
  const value = state.indentLines(
    state.containerFlow(node, tracker.current()),
    quoteLine,
  )
  exit()
  return value
}
function quoteLine(line: string, _: any, blank: boolean) {
  return '>' + (blank ? '' : ' ') + line
}
function hardBreak(_: any, _1: any, state: State, info: Info) {
  let index = -1
  while (++index < state.unsafe.length) {
    if (
      state.unsafe[index].character === '\n' &&
      patternInScope(state.stack, state.unsafe[index])
    ) {
      return /[ \t]/.test(info.before) ? '' : ' '
    }
  }
  return '\\\n'
}
function longestStreak(value: string, marker: string): number {
  let longest = 0
  const code = marker.charCodeAt(0)
  for (let index = value.indexOf(marker); index !== -1; index = value.indexOf(marker, index + 1)) {
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
    const exit2 = state.enter('codeIndented')
    const value2 = state.indentLines(raw, indentCodeLine)
    exit2()
    return value2
  }
  const tracker = state.createTracker(info)
  const sequence = marker.repeat(Math.max(longestStreak(raw, marker) + 1, 3))
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
      'Cannot serialize title with `' +
        marker +
        '` for `options.quote`, expected `"`, or `\'`',
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
    value += tracker.move(
      state.safe(node.url, { before: value, after: '>' }),
    )
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
function encodeCharacterReference(code2: number) {
  return '&#x' + code2.toString(16).toUpperCase() + ';'
}
function markdownLineEndingOrSpace(code2: number) {
  return code2 < 0 || code2 === 32
}
const unicodePunctuation = regexCheck(/\p{P}|\p{S}/u)
const unicodeWhitespace = regexCheck(/\s/)
function regexCheck(regex: RegExp) {
  return check
  function check(code2: number) {
    return (
      code2 > -1 && regex.test(String.fromCharCode(code2))
    )
  }
}
function classifyCharacter(code2: number) {
  if (
    markdownLineEndingOrSpace(code2) ||
    unicodeWhitespace(code2)
  ) {
    return 1
  }
  if (unicodePunctuation(code2)) {
    return 2
  }
}
function encodeInfo(outside: number, inside: number, marker: string) {
  const outsideKind = classifyCharacter(outside)
  const insideKind = classifyCharacter(inside)
  if (outsideKind === void 0) {
    return insideKind === void 0
      ? marker === '_'
        ? { inside: true, outside: true }
        : { inside: false, outside: false }
      : insideKind === 1
        ? { inside: true, outside: true }
        : { inside: false, outside: true }
  }
  if (outsideKind === 1) {
    return insideKind === void 0
      ? { inside: false, outside: false }
      : insideKind === 1
        ? { inside: true, outside: true }
        : { inside: false, outside: false }
  }
  return insideKind === void 0
    ? { inside: false, outside: false }
    : insideKind === 1
      ? { inside: true, outside: false }
      : { inside: false, outside: false }
}
emphasis.peek = emphasisPeek
function emphasis(node: M.Emphasis, _: any, state: State, info: Info) {
  const marker = checkEmphasis(state)
  const exit = state.enter('emphasis')
  const tracker = state.createTracker(info)
  const before = tracker.move(marker)
  let between2 = tracker.move(
    state.containerPhrasing(node, {
      after: marker,
      before,
      ...tracker.current(),
    }),
  )
  const betweenHead = between2.charCodeAt(0)
  const open = encodeInfo(
    info.before.charCodeAt(info.before.length - 1),
    betweenHead,
    marker,
  )
  if (open.inside) {
    between2 = encodeCharacterReference(betweenHead) + between2.slice(1)
  }
  const betweenTail = between2.charCodeAt(between2.length - 1)
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail, marker)
  if (close.inside) {
    between2 = between2.slice(0, -1) + encodeCharacterReference(betweenTail)
  }
  const after = tracker.move(marker)
  exit()
  state.attentionEncodeSurroundingInfo = {
    after: close.outside,
    before: open.outside,
  }
  return before + between2 + after
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
function formatHeadingAsSetext(node: M.Heading, state: State) {
  const literalWithBreak = hasBreak(node)
  return Boolean(
    (!node.depth || node.depth < 3) &&
      toString(node) &&
      (state.options.setext || literalWithBreak),
  )
}
function heading(node: M.Heading, _: any, state: State, info: Info) {
  const rank = Math.max(Math.min(6, node.depth || 1), 1)
  const tracker = state.createTracker(info)
  if (formatHeadingAsSetext(node, state)) {
    const exit2 = state.enter('headingSetext')
    const subexit2 = state.enter('phrasing')
    const value2 = state.containerPhrasing(node, {
      ...tracker.current(),
      before: '\n',
      after: '\n',
    })
    subexit2()
    exit2()
    return (
      value2 +
      '\n' +
      (rank === 1 ? '=' : '-').repeat(
        value2.length -
          (Math.max(value2.lastIndexOf('\r'), value2.lastIndexOf('\n')) + 1),
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
  value += tracker.move(
    state.safe(node.alt, { before: value, after: ']' }),
  )
  value += tracker.move('](')
  subexit()
  if ((!node.url && node.title) || /[\0- \u007F]/.test(node.url)) {
    subexit = state.enter('destinationLiteral')
    value += tracker.move('<')
    value += tracker.move(
      state.safe(node.url, { before: value, after: '>' }),
    )
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
function imageReference(
  node: M.ImageReference,
  _: any,
  state: State,
  info: Info,
) {
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
  const stack = state.stack
  state.stack = []
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
function imageReferencePeek() {
  return '!'
}
inlineCode.peek = inlineCodePeek
export function inlineCode(node: M.InlineCode, _: any, state: State) {
  let value = node.value || ''
  const streaks = new Set<number>()
  for (let index = value.indexOf('`'); index !== -1; index = value.indexOf('`', index + 1)) {
    const start = index
    while (value.charCodeAt(index + 1) === 96) index++
    streaks.add(index - start + 1)
  }
  let width = 1
  while (streaks.has(width)) width++
  const sequence = '`'.repeat(width)
  if (
    /[^ \r\n]/.test(value) &&
    ((/^[ \r\n]/.test(value) && /[ \r\n]$/.test(value)) || /^`|`$/.test(value))
  ) {
    value = ' ' + value + ' '
  }
  if (!value.includes('\n') && !value.includes('\r')) return sequence + value + sequence
  for (const expression of state.rules.breaks) {
    expression.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = expression.exec(value))) {
      let position = match.index
      if (
        value.charCodeAt(position) === 10 &&
        value.charCodeAt(position - 1) === 13
      ) {
        position--
      }
      value = value.slice(0, position) + ' ' + value.slice(match.index + 1)
    }
  }
  return sequence + value + sequence
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
      /^[a-z][a-z+.-]+:/i.test(node.url) &&
      !/[\0- <>\u007F]/.test(node.url),
  )
}
link.peek = linkPeek
function link(node: M.Link, _: any, state: State, info: Info) {
  const quote = checkQuote(state)
  const suffix = quote === '"' ? 'Quote' : 'Apostrophe'
  const tracker = state.createTracker(info)
  let exit: () => void
  let subexit: () => void
  if (formatLinkAsAutolink(node, state)) {
    const stack = state.stack
    state.stack = []
    exit = state.enter('autolink')
    let value2 = tracker.move('<')
    value2 += tracker.move(
      state.containerPhrasing(node, {
        before: value2,
        after: '>',
        ...tracker.current(),
      }),
    )
    value2 += tracker.move('>')
    exit()
    state.stack = stack
    return value2
  }
  exit = state.enter('link')
  subexit = state.enter('label')
  let value = tracker.move('[')
  value += tracker.move(
    state.containerPhrasing(node, {
      before: value,
      after: '](',
      ...tracker.current(),
    }),
  )
  value += tracker.move('](')
  subexit()
  if ((!node.url && node.title) || /[\0- \u007F]/.test(node.url)) {
    subexit = state.enter('destinationLiteral')
    value += tracker.move('<')
    value += tracker.move(
      state.safe(node.url, { before: value, after: '>' }),
    )
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
function linkPeek(node: M.Link, _: any, state: State) {
  return formatLinkAsAutolink(node, state) ? '<' : '['
}
linkReference.peek = linkReferencePeek
function linkReference(
  node: M.LinkReference,
  _: any,
  state: State,
  info: Info,
) {
  const type = node.referenceType
  const exit = state.enter('linkReference')
  let subexit = state.enter('label')
  const tracker = state.createTracker(info)
  let value = tracker.move('[')
  const text2 = state.containerPhrasing(node, {
    before: value,
    after: ']',
    ...tracker.current(),
  })
  value += tracker.move(text2 + '][')
  subexit()
  const stack = state.stack
  state.stack = []
  subexit = state.enter('reference')
  const reference = state.safe(state.associationId(node), {
    before: value,
    after: ']',
    ...tracker.current(),
  })
  subexit()
  state.stack = stack
  exit()
  if (type === 'full' || !text2 || text2 !== reference) {
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
  const bulletOther = node.ordered
    ? bullet === '.'
      ? ')'
      : '.'
    : checkBulletOther(state)
  let useDifferentMarker =
    parent && state.bulletLastUsed ? bullet === state.bulletLastUsed : false
  if (!node.ordered) {
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
export function listItem(
  node: M.ListItem,
  parent: any,
  state: State,
  info: Info,
) {
  const listItemIndent = checkListItemIndent(state)
  let bullet = state.bulletCurrent || checkBullet(state)
  if (parent && parent.type === 'list' && parent.ordered) {
    bullet =
      (typeof parent.start === 'number' && parent.start > -1
        ? parent.start
        : 1) +
      (state.options.incrementListMarker === false
        ? 0
        : parent.children.indexOf(node)) +
      bullet
  }
  let size = bullet.length + 1
  if (
    listItemIndent === 'tab' ||
    (listItemIndent === 'mixed' &&
      ((parent && parent.type === 'list' && parent.spread) || node.spread))
  ) {
    size = Math.ceil(size / 4) * 4
  }
  const tracker = state.createTracker(info)
  tracker.move(bullet + ' '.repeat(size - bullet.length))
  tracker.shift(size)
  const exit = state.enter('listItem')
  const value = state.indentLines(
    state.containerFlow(node, tracker.current()),
    map4,
  )
  exit()
  return value
  function map4(line: string, index: number, blank: boolean) {
    if (index) {
      return (blank ? '' : ' '.repeat(size)) + line
    }
    return (blank ? bullet : bullet + ' '.repeat(size - bullet.length)) + line
  }
}
function paragraph(node: M.Paragraph, _: any, state: State, info: Info) {
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
  'link',
  'linkReference',
  'strong',
  'text',
  'mdxJsxTextElement',
  'mdxTextExpression',
])
function root(node: M.Root, _: any, state: State, info: Info) {
  const hasPhrasing = node.children.some((node) => phrasingTypes.has(node.type))
  const container = hasPhrasing ? state.containerPhrasing : state.containerFlow
  return container.call(state, node, info)
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
strong.peek = strongPeek
function strong(node: M.Strong, _: any, state: State, info: Info) {
  const marker = checkStrong(state)
  const exit = state.enter('strong')
  const tracker = state.createTracker(info)
  const before = tracker.move(marker + marker)
  let between2 = tracker.move(
    state.containerPhrasing(node, {
      after: marker,
      before,
      ...tracker.current(),
    }),
  )
  const betweenHead = between2.charCodeAt(0)
  const open = encodeInfo(
    info.before.charCodeAt(info.before.length - 1),
    betweenHead,
    marker,
  )
  if (open.inside) {
    between2 = encodeCharacterReference(betweenHead) + between2.slice(1)
  }
  const betweenTail = between2.charCodeAt(between2.length - 1)
  const close = encodeInfo(info.after.charCodeAt(0), betweenTail, marker)
  if (close.inside) {
    between2 = between2.slice(0, -1) + encodeCharacterReference(betweenTail)
  }
  const after = tracker.move(marker + marker)
  exit()
  state.attentionEncodeSurroundingInfo = {
    after: close.outside,
    before: open.outside,
  }
  return before + between2 + after
}
function strongPeek(_: any, _1: any, state: State) {
  return state.options.strong || '*'
}
text.peek = textPeek
function textPeek(node: M.Text, parent: any, state: State, info: Info) {
  const value = node.value || ''
  const code = value.charCodeAt(0)
  if (!state.rules.custom && code !== 92 && !state.rules.characters[code])
    return value.charAt(0)
  // Built-in rules inspect at most one following character; include the neighbor's context too.
  if (!state.rules.custom)
    return safe(state, value.slice(0, 2), {
      before: info.before,
      after: value.length > 2 ? value.charAt(2) : info.after,
    }).charAt(0)
  return text(node, parent, state, info)
}
function text(node: M.Text, _: any, state: State, info: Info) {
  return state.safe(node.value, info)
}
function checkRuleRepetition(state: State) {
  const repetition = state.options.ruleRepetition || 3
  if (repetition < 3) {
    throw new Error(
      'Cannot serialize rules with repetition `' +
        repetition +
        '` for `options.ruleRepetition`, expected `3` or more',
    )
  }
  return repetition
}
function thematicBreak(_: any, _1: any, state: State) {
  const value = (
    checkRule(state) + (state.options.ruleSpaces ? ' ' : '')
  ).repeat(checkRuleRepetition(state))
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
    (left.type === 'list' ||
      (left.type === right.type && formatCodeAsIndented(left, state)))
  ) {
    return false
  }
  if (typeof parent.spread === 'boolean') {
    if (
      left.type === 'paragraph' &&
      (left.type === right.type ||
        right.type === 'definition' ||
        (right.type === 'heading' && formatHeadingAsSetext(right, state)))
    ) {
      return
    }
    return parent.spread ? 1 : 0
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
  { character: '&', after: '[#A-Za-z]', inConstruct: 'phrasing' },
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
]
function decodeString(value: string): string {
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
function containerPhrasing(parent: any, state: State, info: Info) {
  const indexStack = state.indexStack
  const children = parent.children || []
  const results: string[] = []
  let index = -1
  let before = info.before
  let encodeAfter: string | undefined
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
        ? nextHandler(children[index + 1], parent, state, {
            before: '', after: '', now: current.now, lineShift: current.lineShift,
          }).charAt(0)
        : ''
    } else {
      after = info.after
    }
    if (
      results.length > 0 &&
      (before === '\r' || before === '\n') &&
      child.type === 'html'
    ) {
      results[results.length - 1] = results[results.length - 1].replace(
        /(\r?\n|\r)$/,
        ' ',
      )
      before = ' '
      tracker = state.createTracker(info)
      tracker.move(results.join(''))
    }
    const current = tracker.current()
    childInfo.now = current.now
    childInfo.lineShift = current.lineShift
    childInfo.before = before
    childInfo.after = after
    let value = child.type === 'text' && !state.customHandlers
      ? safe(state, child.value, childInfo)
      : state.handle(child, parent, state, state.customHandlers ? { ...childInfo } : childInfo)
    if (encodeAfter && encodeAfter === value.slice(0, 1)) {
      value =
        encodeCharacterReference(encodeAfter.charCodeAt(0)) + value.slice(1)
    }
    const encodingInfo = state.attentionEncodeSurroundingInfo
    state.attentionEncodeSurroundingInfo = void 0
    encodeAfter = void 0
    if (encodingInfo) {
      if (
        results.length > 0 &&
        encodingInfo.before &&
        before === results[results.length - 1].slice(-1)
      ) {
        results[results.length - 1] =
          results[results.length - 1].slice(0, -1) +
          encodeCharacterReference(before.charCodeAt(0))
      }
      if (encodingInfo.after) encodeAfter = after
    }
    tracker.move(value)
    results.push(value)
    before = value.slice(-1)
  }
  indexStack.pop()
  return results.join('')
}
function containerFlow(parent: any, state: State, info: Info) {
  const indexStack = state.indexStack
  const children = parent.children || []
  const tracker = state.createTracker(info)
  const results: string[] = []
  const childInfo: Info = { before: '\n', after: '\n', now: info.now, lineShift: info.lineShift }
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
      results.push(
        tracker.move(between(child, children[index + 1], parent, state)),
      )
    }
  }
  indexStack.pop()
  return results.join('')
}
function between(left: any, right: any, parent: any, state: State) {
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
  map4: (line: string, index: number, blank: boolean) => string,
): string {
  let result = ''
  let start = 0
  let line = 0
  let lf = value.indexOf('\n')
  let cr = value.indexOf('\r')
  while (lf !== -1 || cr !== -1) {
    const index = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr)
    const segment = value.slice(start, index)
    result += map4(segment, line, !segment)
    const end =
      index === cr && lf === cr + 1 ? index + 2 : index + 1
    result += value.slice(index, end)
    start = end
    if (lf !== -1 && lf < end) lf = value.indexOf('\n', end)
    if (cr !== -1 && cr < end) cr = value.indexOf('\r', end)
    line++
  }
  const segment = value.slice(start)
  return result + map4(segment, line, !segment)
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
  return Boolean(options.handlers && Object.keys(options.handlers).length) ||
    Boolean(options.join?.length) ||
    Boolean(options.extensions?.some(needsTracking))
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
    handle: Object.assign(
      (node, parent, state, info) => dispatch(node, parent, state, info),
      { handlers: setup.handlers },
    ),
    indentLines,
    indexStack: [],
    safe: safeBound,
    stack: [],
  }
  if (state.options.tightDefinitions) {
    state.join.push(joinDefinition)
  }
  let result = state.handle(tree, void 0, state, {
    before: '\n',
    after: '\n',
    now: { line: 1, column: 1 },
    lineShift: 0,
  })
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
function safeBound(
  this: State,
  value: string | null | undefined,
  config: SafeConfig,
) {
  return safe(this, value, config)
}
export function toMarkdown(
  tree: Nodes,
  config: Config,
  options: StringifyOptions = {},
) {
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
  extensions.push(...(options.extensions || []))
  return stringifyTree(
    tree,
    { ...options, extensions },
    config,
    hasCustomUnsafe(options),
    needsTracking(options) || Boolean(config.mdx && Number.isFinite(options.printWidth)),
    needsTracking(options),
  )
}
function hasCustomUnsafe(options: StringifyOptions): boolean {
  return Boolean(
    options.unsafe?.length || options.extensions?.some(hasCustomUnsafe),
  )
}

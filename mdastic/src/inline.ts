// Recognize inline tokens, then resolve attention runs in the shared node arena.
// Views map container-stripped text back to original source offsets.
import type { Config } from './syntax.ts'
import {
  alpha,
  ASCII_SIZE,
  AsciiFlag,
  Char,
  ascii,
  decode,
  digit,
  isPunctuation,
  isWhitespace,
  normalizeIdentifier,
  space,
  TAB_SIZE,
} from './scan.ts'
import { append, Kind, node, tree } from './tree.ts'
import { rawLiteralLink } from './autolink.ts'

export interface DefinitionData {
  identifier: string
  label: string
  url: string
  title: string | null
}
export interface InlineContext {
  config: Config
  definitions: Map<string, DefinitionData>
  footnotes: Set<string>
  inline?: (
    view: View,
    start: number,
    end: number,
    context: InlineContext,
  ) => { end: number; node: number } | undefined
  inlineMarkers?: boolean
}
export interface View {
  // Contiguous views use base + index; stripped views map each virtual UTF-16 unit.
  source: string
  base: number
  map?: Int32Array
  // map includes an EOF slot; partial-tab spaces point back to their consumed tab.
  table?: boolean
  lazy?: Set<number>
  boundary?: number
}
export function offset(view: View, i: number): number {
  return view.map ? view.map[i] : view.base + i
}

// Email candidates use the ASCII table; other views jump with native regex search.
const inlineStops = new Uint8Array(ASCII_SIZE)
for (const c of [
  Char.LineFeed,
  Char.CarriageReturn,
  Char.Exclamation,
  Char.Asterisk,
  Char.LessThan,
  Char.LeftBracket,
  Char.Backslash,
  Char.RightBracket,
  Char.Underscore,
  Char.Backtick,
  Char.LeftBrace,
  Char.Tilde,
])
  inlineStops[c] = 1
const linkStops = inlineStops.slice()
for (const c of [Char.UpperH, Char.LowerH, Char.UpperW, Char.LowerW]) linkStops[c] = 1
const emailStops = linkStops.slice()
for (let c = 0; c < ASCII_SIZE; c++) {
  if (
    ascii[c] & AsciiFlag.Alphanumeric ||
    c === Char.Plus ||
    c === Char.Hyphen ||
    c === Char.Dot
  )
    emailStops[c] = 1
}
const mathEmailStops = emailStops.slice()
mathEmailStops[Char.Dollar] = 1
const markdownMarkers = /[\n\r!*<[\]\\_`{~]/g
const gfmMarkers = /[\n\r!*<[\]\\_`{~]|https?:\/\/|www\./gi
const mathMarkers = /[\n\r!$*<[\]\\_`{~]/g
const gfmMathMarkers = /[\n\r!$*<[\]\\_`{~]|https?:\/\/|www\./gi

const enum DelimiterFlag {
  CanOpen = 1,
  CanClose = 2,
}
const INITIAL_DELIMITER_CAPACITY = 1024
const MAX_DESTINATION_PAREN_DEPTH = 32
const MIN_AUTOLINK_SCHEME_LENGTH = 2
const MAX_AUTOLINK_SCHEME_LENGTH = 32
const MAX_EMAIL_LABEL_LENGTH = 63
const MAX_CONTINUATION_INDENT = 3

// Recursive spans reserve [begin, end); successful scopes restore their starting count.
let delimiterCount = 0
let delimiterCapacity = INITIAL_DELIMITER_CAPACITY
let delimiterNode = new Int32Array(delimiterCapacity)
let delimiterParent = new Int32Array(delimiterCapacity)
let delimiterStart = new Int32Array(delimiterCapacity)
let delimiterLength = new Int32Array(delimiterCapacity)
let delimiterChar = new Uint8Array(delimiterCapacity)
let delimiterFlags = new Uint8Array(delimiterCapacity)
// Shortest `$` run that opens inline math; 0 when math is off.
let mathRun = 0
const mathClosers = new Map<string, Map<number, number[]>>()
// Candidate scanners for this parse; math adds `$`.
let markdownCandidates = markdownMarkers
let gfmCandidates = gfmMarkers
let emailCandidates = emailStops

export function resetInline(config: Config): void {
  delimiterCount = 0
  mathClosers.clear()
  mathRun = config.math ? (config.math.singleDollarTextMath ? 1 : 2) : 0
  markdownCandidates = mathRun ? mathMarkers : markdownMarkers
  gfmCandidates = mathRun ? gfmMathMarkers : gfmMarkers
  emailCandidates = mathRun ? mathEmailStops : emailStops
}

function delimiter(
  n: number,
  parent: number,
  start: number,
  length: number,
  char: number,
  flags: number,
): void {
  if (delimiterCount === delimiterCapacity) {
    delimiterCapacity *= 2
    const nodes = new Int32Array(delimiterCapacity)
    nodes.set(delimiterNode)
    delimiterNode = nodes
    const parents = new Int32Array(delimiterCapacity)
    parents.set(delimiterParent)
    delimiterParent = parents
    const starts = new Int32Array(delimiterCapacity)
    starts.set(delimiterStart)
    delimiterStart = starts
    const lengths = new Int32Array(delimiterCapacity)
    lengths.set(delimiterLength)
    delimiterLength = lengths
    const chars = new Uint8Array(delimiterCapacity)
    chars.set(delimiterChar)
    delimiterChar = chars
    const flagsArray = new Uint8Array(delimiterCapacity)
    flagsArray.set(delimiterFlags)
    delimiterFlags = flagsArray
  }
  delimiterNode[delimiterCount] = n
  delimiterParent[delimiterCount] = parent
  delimiterStart[delimiterCount] = start
  delimiterLength[delimiterCount] = length
  delimiterChar[delimiterCount] = char
  delimiterFlags[delimiterCount++] = flags
}

function unlink(parent: number, n: number): void {
  const before = tree.prev[n]
  const after = tree.next[n]
  if (before) tree.next[before] = after
  else tree.child[parent] = after
  if (after) tree.prev[after] = before
  else tree.last[parent] = before
}

function resolveDelimiters(
  view: View,
  parent: number,
  begin: number,
  end: number,
  strikeFirst: boolean,
): void {
  // Micromark uses tokenization order at the top level, tilde-first inside spans.
  resolveFamily(view, parent, begin, end, strikeFirst)
  resolveFamily(view, parent, begin, end, !strikeFirst)
}

function resolveFamily(
  view: View,
  parent: number,
  begin: number,
  end: number,
  tilde: boolean,
): void {
  for (let close = begin; close < end; close++) {
    if (
      delimiterParent[close] !== parent ||
      (delimiterChar[close] === Char.Tilde) !== tilde ||
      !(delimiterFlags[close] & DelimiterFlag.CanClose)
    )
      continue
    while (delimiterLength[close]) {
      let open = close - 1
      for (; open >= begin; open--) {
        if (
          delimiterParent[open] !== parent ||
          !delimiterLength[open] ||
          !(delimiterFlags[open] & DelimiterFlag.CanOpen) ||
          delimiterChar[open] !== delimiterChar[close]
        )
          continue
        const a = delimiterLength[open]
        const b = delimiterLength[close]
        // Tildes need equal runs; emphasis follows CommonMark's rule of three.
        if (delimiterChar[open] === Char.Tilde) {
          if (a !== b) continue
        } else if (
          (delimiterFlags[open] & DelimiterFlag.CanClose ||
            delimiterFlags[close] & DelimiterFlag.CanOpen) &&
          (a + b) % 3 === 0 &&
          (a % 3 !== 0 || b % 3 !== 0)
        )
          continue
        break
      }
      if (open < begin) break
      const use =
        delimiterChar[open] === Char.Tilde
          ? delimiterLength[open]
          : delimiterLength[open] >= 2 && delimiterLength[close] >= 2
            ? 2
            : 1
      const left = delimiterNode[open]
      const right = delimiterNode[close]
      const leftEnd = delimiterStart[open] + delimiterLength[open]
      const rightStart = delimiterStart[close]
      const wrapper = node(
        delimiterChar[open] === Char.Tilde
          ? Kind.Delete
          : use === 2
            ? Kind.Strong
            : Kind.Emphasis,
        offset(view, leftEnd - use),
        offset(view, rightStart + use),
      )
      // Wrap the sibling range, consume its markers, then transfer nested run ownership.
      tree.child[wrapper] = tree.next[left]
      tree.last[wrapper] = tree.prev[right]
      tree.prev[tree.child[wrapper]] = 0
      tree.next[tree.last[wrapper]] = 0
      tree.next[left] = wrapper
      tree.prev[wrapper] = left
      tree.next[wrapper] = right
      tree.prev[right] = wrapper
      delimiterLength[open] -= use
      delimiterLength[close] -= use
      delimiterStart[close] += use
      tree.end[left] = offset(view, leftEnd - use)
      tree.start[right] = offset(view, rightStart + use)
      tree.value[left] = view.source.slice(delimiterStart[open], leftEnd - use)
      tree.value[right] = view.source.slice(
        rightStart + use,
        rightStart + use + delimiterLength[close],
      )
      for (let d = open + 1; d < close; d++)
        if (delimiterParent[d] === parent) delimiterParent[d] = wrapper
      resolveDelimiters(view, wrapper, open + 1, close, true)
      if (!delimiterLength[open]) unlink(parent, left)
      if (!delimiterLength[close]) unlink(parent, right)
    }
  }
}

export function destination(
  source: string,
  start: number,
  end: number,
): { end: number; value: string } | undefined {
  // mdast stores decoded destinations; URI encoding belongs to HTML serialization.
  let i = start
  if (source.charCodeAt(i) === Char.LessThan) {
    i++
    const begin = i
    for (; i < end; i++) {
      const c = source.charCodeAt(i)
      if (c === Char.GreaterThan) return { end: i + 1, value: decode(source.slice(begin, i)) }
      if (c === Char.LessThan || c === Char.LineFeed || c === Char.CarriageReturn) return
      if (c === Char.Backslash && isPunctuation(source.charCodeAt(i + 1))) i++
    }
    return
  }
  let depth = 0
  for (; i < end; i++) {
    const c = source.charCodeAt(i)
    if ((c !== 0 && c <= Char.Space) || c === Char.Delete) break
    if (c === Char.Backslash && isPunctuation(source.charCodeAt(i + 1))) {
      i++
      continue
    }
    if (c === Char.LeftParen) {
      if (++depth > MAX_DESTINATION_PAREN_DEPTH) return
    } else if (c === Char.RightParen) {
      if (!depth) break
      depth--
    }
  }
  if (depth) return
  return { end: i, value: decode(source.slice(start, i)) }
}

export function title(
  source: string,
  start: number,
  end: number,
): { end: number; value: string } | undefined {
  const open = source.charCodeAt(start)
  if (open !== Char.DoubleQuote && open !== Char.SingleQuote && open !== Char.LeftParen) return
  const close = open === Char.LeftParen ? Char.RightParen : open
  for (let i = start + 1; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c === close)
      return { end: i + 1, value: decode(trimContinuation(source.slice(start + 1, i))) }
    if (c === 92 && isPunctuation(source.charCodeAt(i + 1))) i++
    if (c === 13 && source.charCodeAt(i + 1) === 10) {
      i++
      continue
    }
    if (
      (c === 10 || c === 13) &&
      (source.charCodeAt(i + 1) === 10 || source.charCodeAt(i + 1) === 13)
    )
      return
  }
}

function skipWhitespace(source: string, i: number, end: number): number {
  while (
    i < end &&
    (space(source.charCodeAt(i)) || source.charCodeAt(i) === 10 || source.charCodeAt(i) === 13)
  )
    i++
  return i
}

function trimContinuation(value: string, limit = Infinity): string {
  let result = ''
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c !== 10 && c !== 13) continue
    if (c === 13 && value.charCodeAt(i + 1) === 10) i++
    let end = i + 1
    let indent = 0
    while (space(value.charCodeAt(end)) && indent < limit) {
      indent += value.charCodeAt(end) === Char.Tab ? TAB_SIZE - (indent % TAB_SIZE) : 1
      end++
    }
    if (end > i + 1) {
      result += value.slice(start, i + 1) + (indent > limit ? ' '.repeat(indent - limit) : '')
      start = end
      i = end - 1
    }
  }
  return result + value.slice(start)
}

function resource(
  source: string,
  start: number,
  end: number,
): { end: number; url: string; title: string | null } | undefined {
  let i = skipWhitespace(source, start + 1, end)
  const dest = destination(source, i, end)
  if (!dest) return
  i = skipWhitespace(source, dest.end, end)
  let label: string | null = null
  if (i > dest.end && source.charCodeAt(i) !== 41) {
    const t = title(source, i, end)
    if (!t) return
    label = t.value || null
    i = skipWhitespace(source, t.end, end)
  }
  if (source.charCodeAt(i) === 41) return { end: i + 1, url: dest.value, title: label }
}

function bracketEnd(
  source: string,
  start: number,
  end: number,
  view?: View,
  context?: InlineContext,
): number {
  let depth = 0
  for (let i = start; i < end; i++) {
    const c = source.charCodeAt(i)
    // Brackets inside expressions and JSX tags do not participate in Markdown labels.
    if ((c === Char.LeftBrace || c === Char.LessThan) && view && context?.inline) {
      const match = context.inline(view, i, end, context)
      if (match) {
        i = match.end - 1
        continue
      }
    }
    if (c === 92 && isPunctuation(source.charCodeAt(i + 1))) {
      i++
      continue
    }
    if (c === 60) {
      const stop = autolink(source, i, end)?.end ?? htmlEnd(source, i, end)
      if (stop > i) {
        i = stop - 1
        continue
      }
    }
    if (c === 96 || (c === Char.Dollar && mathRun)) {
      let run = i + 1
      while (source.charCodeAt(run) === c) run++
      const close = spanEnd(source, run, end, run - i, c)
      if (close >= 0) {
        i = close + run - i - 1
        continue
      }
      // An unmatched run stays whole; its suffix cannot open a shorter span.
      i = run - 1
    }
    if (c === 91) depth++
    else if (c === 93) {
      if (!depth) return i
      depth--
      // Resource destinations and titles are not part of the enclosing label.
      if (source.charCodeAt(i + 1) === Char.LeftParen) {
        const match = resource(source, i + 1, end)
        if (match) i = match.end - 1
      }
    }
  }
  return -1
}

function codeEnd(source: string, start: number, end: number, length: number, char = 96): number {
  for (let i = start; i < end; ) {
    if (source.charCodeAt(i) !== char) {
      i++
      continue
    }
    let j = i + 1
    while (source.charCodeAt(j) === char) j++
    if (j - i === length) return i
    i = j
  }
  return -1
}

// Closing run of a code or math span; math needs an opening run of at least `mathRun`.
function spanEnd(source: string, start: number, end: number, length: number, char: number): number {
  if (char !== Char.Dollar) return codeEnd(source, start, end, length, char)
  if (length < mathRun) return -1
  // Index each view's dollar runs once; unmatched lengths must not rescan its suffix.
  let runs = mathClosers.get(source)
  if (!runs) {
    runs = new Map()
    for (let i = source.indexOf('$'); i !== -1; ) {
      let j = i + 1
      while (source.charCodeAt(j) === Char.Dollar) j++
      const width = j - i
      const positions = runs.get(width)
      if (positions) positions.push(i)
      else runs.set(width, [i])
      i = source.indexOf('$', j)
    }
    mathClosers.set(source, runs)
  }
  const positions = runs.get(length)
  if (!positions) return -1
  let low = 0
  let high = positions.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (positions[mid] < start) low = mid + 1
    else high = mid
  }
  const close = positions[low]
  return close < end ? close : -1
}

function codeValue(source: string, start: number, end: number): string {
  // CommonMark trims one edge space only when the code span is not entirely spaces.
  let allSpaces = true
  for (let i = start; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c !== 32 && c !== 10 && c !== 13) allSpaces = false
  }
  const first = source.charCodeAt(start)
  const last = source.charCodeAt(end - 1)
  if (
    !allSpaces &&
    (first === 32 || first === 10 || first === 13) &&
    (last === 32 || last === 10 || last === 13)
  ) {
    start += first === 13 && source.charCodeAt(start + 1) === 10 ? 2 : 1
    end -= last === 10 && source.charCodeAt(end - 2) === 13 ? 2 : 1
  }
  return source.slice(start, end)
}

function attributeValueEnd(source: string, at: number, end: number, loose: boolean): number {
  let i = at
  for (;;) {
    const c = source.charCodeAt(i)
    if (i >= end || c === 60 || c === 61 || c === 62 || c === 96) return -1
    if (c === 34 || c === 39) {
      const stop = source.indexOf(source[i], i + 1)
      return stop < 0 || stop >= end ? -1 : stop + 1
    }
    const begin = i
    // Micromark quirk: only the first unquoted character can be a slash.
    if (!loose) i++
    while (
      i < end &&
      !isWhitespace(source.charCodeAt(i)) &&
      !'"\'=/<>`'.includes(source[i])
    )
      i++
    if (i === begin) return -1
    if (!loose || source.charCodeAt(i) !== 61) return i
    i++
    while (space(source.charCodeAt(i))) i++
  }
}

export function htmlEnd(source: string, start: number, end: number, loose = false): number {
  let i = start + 1
  if (source.startsWith('<!--', start)) {
    // Micromark accepts the short comment endings <!--> and <!--->.
    if (source.charCodeAt(start + 4) === 62) return start + 5
    if (source.charCodeAt(start + 4) === 45 && source.charCodeAt(start + 5) === 62)
      return start + 6
    const stop = source.indexOf('-->', start + 4)
    return stop < 0 || stop + 3 > end ? -1 : stop + 3
  }
  if (source.startsWith('<![CDATA[', start)) {
    const stop = source.indexOf(']]>', start + 9)
    return stop < 0 || stop + 3 > end ? -1 : stop + 3
  }
  if (source.charCodeAt(i) === 63) {
    const stop = source.indexOf('?>', i + 1)
    return stop < 0 || stop + 2 > end ? -1 : stop + 2
  }
  if (source.charCodeAt(i) === 33) {
    if (!alpha(source.charCodeAt(i + 1))) return -1
    const stop = source.indexOf('>', i + 2)
    return stop < 0 || stop >= end ? -1 : stop + 1
  }
  const closing = source.charCodeAt(i) === 47
  if (closing) i++
  if (!alpha(source.charCodeAt(i))) return -1
  for (
    i++;
    i < end &&
    (alpha(source.charCodeAt(i)) || digit(source.charCodeAt(i)) || source.charCodeAt(i) === 45);
    i++
  );
  while (i < end) {
    const before = i
    i = skipWhitespace(source, i, end)
    if (source.charCodeAt(i) === 62) return i + 1
    if (source.charCodeAt(i) === 47 && source.charCodeAt(i + 1) === 62 && !closing) return i + 2
    if (closing || i === before) return -1
    const c = source.charCodeAt(i)
    if (!alpha(c) && c !== 95 && c !== 58) return -1
    i++
    while (
      i < end &&
      (alpha(source.charCodeAt(i)) || digit(source.charCodeAt(i)) || '-._:'.includes(source[i]))
    )
      i++
    const attributeEnd = i
    i = skipWhitespace(source, i, end)
    if (source.charCodeAt(i) !== 61) {
      i = attributeEnd
      continue
    }
    i = skipWhitespace(source, i + 1, end)
    i = attributeValueEnd(source, i, end, loose)
    if (i < 0) return -1
  }
  return -1
}

function autolink(
  source: string,
  start: number,
  end: number,
): { end: number; url: string; value: string } | undefined {
  let i = start + 1
  while (
    i < end &&
    source.charCodeAt(i) !== 62 &&
    source.charCodeAt(i) > 32 &&
    source.charCodeAt(i) !== Char.Delete &&
    source.charCodeAt(i) !== 60
  )
    i++
  if (source.charCodeAt(i) !== 62) return
  const value = source.slice(start + 1, i)
  let colon = start + 1
  while (colon < i && source.charCodeAt(colon) !== 58) colon++
  if (
    colon < i &&
    colon - start >= MIN_AUTOLINK_SCHEME_LENGTH + 1 &&
    colon - start <= MAX_AUTOLINK_SCHEME_LENGTH + 1 &&
    alpha(source.charCodeAt(start + 1))
  ) {
    let valid = true
    for (let j = start + 2; j < colon; j++)
      if (
        !alpha(source.charCodeAt(j)) &&
        !digit(source.charCodeAt(j)) &&
        !'+-.'.includes(source[j])
      )
        valid = false
    if (valid) return { end: i + 1, url: value, value }
  }
  if (validEmail(value)) return { end: i + 1, url: 'mailto:' + value, value }
}

function validEmail(value: string): boolean {
  let at = -1
  for (let i = 0; i < value.length; i++)
    if (value.charCodeAt(i) === 64) {
      if (at >= 0) return false
      at = i
    }
  if (at <= 0 || at === value.length - 1) return false
  for (let i = 0; i < at; i++)
    if (
      !alpha(value.charCodeAt(i)) &&
      !digit(value.charCodeAt(i)) &&
      !".#$%&'*+-/=?^_`{|}~".includes(value[i])
    )
      return false
  let label = 0
  for (let i = at + 1; i <= value.length; i++) {
    const c = value.charCodeAt(i)
    if (i === value.length || c === 46) {
      if (!label || label > MAX_EMAIL_LABEL_LENGTH || value.charCodeAt(i - 1) === Char.Hyphen)
        return false
      label = 0
    } else {
      if ((!alpha(c) && !digit(c) && c !== 45) || (!label && c === 45)) return false
      label++
    }
  }
  return true
}

function plainText(
  view: View,
  start: number,
  end: number,
  parent: number,
  value?: string,
): number {
  const last = view.source.charCodeAt(end - 1)
  const n = node(
    Kind.Text,
    offset(view, start),
    last === 10 || last === 13 ? offset(view, end - 1) + 1 : offset(view, end),
    parent,
  )
  tree.value[n] = value ?? decode(view.source.slice(start, end))
  return n
}

function mergeText(parent: number): void {
  let last = 0
  for (let n = tree.child[parent]; n; ) {
    const next = tree.next[n]
    if (tree.kind[n] === Kind.Text && last && tree.kind[last] === Kind.Text) {
      tree.value[last] = (tree.value[last] ?? '') + (tree.value[n] ?? '')
      tree.end[last] = tree.end[n]
      unlink(parent, n)
    } else {
      if (tree.child[n]) mergeText(n)
      last = n
    }
    n = next
  }
}

function flatten(parent: number): string {
  let value = ''
  for (let n = tree.child[parent]; n; n = tree.next[n])
    value += tree.child[n] ? flatten(n) : (tree.value[n] ?? '')
  return value
}

export function parseInline(
  view: View,
  start: number,
  end: number,
  parent: number,
  context: InlineContext,
  inLink = false,
  trim = true,
  // micromark never starts a literal autolink inside an open link or image label.
  literals = !inLink,
): void {
  // ── Reserve this inline scope and select its candidate scanner ──
  const source = view.source
  const delimiterBegin = delimiterCount
  let textStart = start
  const emailAt = context.config.gfm && literals ? source.indexOf('@', start) : -1
  const email = emailAt >= 0 && emailAt < end
  const stops = email ? emailCandidates : context.config.gfm && literals ? linkStops : inlineStops
  const scanText = !context.inline || context.inlineMarkers
  const markers = context.config.gfm && literals ? gfmCandidates : markdownCandidates
  let i = start
  let unbalanced = 0
  while (i < end) {
    // ── Jump to a candidate; unrestricted custom hooks see every character ──
    if (scanText) {
      if (email) {
        while (i < end && !stops[source.charCodeAt(i)]) i++
      } else {
        markers.lastIndex = i
        const marker = markers.exec(source)
        i = marker && marker.index < end ? marker.index : end
      }
      if (i === end) break
    }
    const c = source.charCodeAt(i)
    // ── Syntax hooks take priority over built-in Markdown tokens ──
    if (context.inline) {
      const match = context.inline(view, i, end, context)
      if (match) {
        if (textStart < i) plainText(view, textStart, i, parent)
        append(parent, match.node)
        i = textStart = match.end
        continue
      }
    }
    // ── GFM tokenizer autolinks keep source positions ──
    const previous = i > start ? source.charCodeAt(i - 1) : -1
    const literalStart =
      (!(ascii[previous] & AsciiFlag.Alphanumeric) &&
        previous !== Char.Plus &&
        previous !== Char.Hyphen &&
        previous !== Char.Dot &&
        previous !== Char.Underscore &&
        previous !== Char.Slash) ||
      ((c === Char.UpperH || c === Char.LowerH || c === Char.UpperW || c === Char.LowerW) &&
        !(ascii[previous] & AsciiFlag.Letter))
    if (
      context.config.gfm &&
      literals &&
      !unbalanced && // Unmatched label brackets suppress tokenizer autolinks.
      literalStart &&
      ((email &&
        (ascii[c] & AsciiFlag.Alphanumeric ||
          c === Char.Plus ||
          c === Char.Hyphen ||
          c === Char.Dot ||
          c === Char.Underscore)) ||
        c === Char.UpperH ||
        c === Char.LowerH ||
        c === Char.UpperW ||
        c === Char.LowerW)
    ) {
      const link = rawLiteralLink(source, i, end, previous, email)
      if (link) {
        if (textStart < i) plainText(view, textStart, i, parent)
        const n = node(Kind.Link, offset(view, i), offset(view, link.end), parent)
        const value = source.slice(i, link.end)
        tree.extra[n] = { title: null, url: link.prefix + value }
        plainText(view, i, link.end, n, value)
        i = textStart = link.end
        continue
      }
    }
    // ── Escapes and line endings, including two-space hard breaks ──
    if (c === Char.Backslash) {
      const next = source.charCodeAt(i + 1)
      if (next < ASCII_SIZE && isPunctuation(next)) {
        i += 2
        continue
      }
      if (next === 10 || next === 13) {
        if (textStart < i) plainText(view, textStart, i, parent)
        let stop = i + 2
        if (next === 13 && source.charCodeAt(stop) === 10) stop++
        node(Kind.Break, offset(view, i), offset(view, stop - 1) + 1, parent)
        while (space(source.charCodeAt(stop))) stop++
        i = textStart = stop
        continue
      }
    }
    if (c === 10 || c === 13) {
      let trim = i
      while (trim > textStart && space(source.charCodeAt(trim - 1))) trim--
      let stop = i + 1
      if (c === 13 && source.charCodeAt(stop) === 10) stop++
      let tabs = false
      for (let j = trim; j < i; j++) if (source.charCodeAt(j) === 9) tabs = true
      if (
        !tabs &&
        i - trim >= 2 &&
        source.charCodeAt(i - 1) === 32 &&
        source.charCodeAt(i - 2) === 32
      ) {
        if (textStart < trim) plainText(view, textStart, trim, parent)
        node(Kind.Break, offset(view, trim), offset(view, stop - 1) + 1, parent)
        while (space(source.charCodeAt(stop))) stop++
        i = textStart = stop
      } else {
        if (textStart < trim) plainText(view, textStart, trim, parent)
        plainText(view, i, stop, parent)
        while (space(source.charCodeAt(stop))) stop++
        i = textStart = stop
      }
      continue
    }
    // ── Code spans consume only a closing run of the same length ──
    if (c === Char.Backtick) {
      let run = i + 1
      while (source.charCodeAt(run) === 96) run++
      const close = codeEnd(source, run, end, run - i)
      if (close >= 0) {
        if (textStart < i) plainText(view, textStart, i, parent)
        const stop = close + run - i
        const n = node(Kind.InlineCode, offset(view, i), offset(view, stop), parent)
        tree.value[n] = codeValue(source, run, close)
        if (view.table) tree.value[n] = unescapePipes(tree.value[n]!)
        i = textStart = stop
        continue
      }
      i = run
      continue
    }
    // ── Math spans follow the code span rules with `$` ──
    if (c === Char.Dollar && mathRun) {
      let run = i + 1
      while (source.charCodeAt(run) === Char.Dollar) run++
      const close = spanEnd(source, run, end, run - i, c)
      if (close >= 0) {
        if (textStart < i) plainText(view, textStart, i, parent)
        const stop = close + run - i
        const n = node(Kind.InlineMath, offset(view, i), offset(view, stop), parent)
        tree.value[n] = codeValue(source, run, close)
        i = textStart = stop
        continue
      }
      i = run
      continue
    }
    // ── Record attention runs; resolve their sibling ranges after tokenization ──
    if (
      c === Char.Asterisk ||
      c === Char.Underscore ||
      (c === Char.Tilde && context.config.gfm)
    ) {
      let stop = i + 1
      while (source.charCodeAt(stop) === c) stop++
      const length = stop - i
      if (
        c === Char.Tilde &&
        (length > 2 || (length === 1 && !context.config.gfm?.singleTilde))
      ) {
        i = stop
        continue
      }
      if (textStart < i) plainText(view, textStart, i, parent)
      const n = plainText(view, i, stop, parent)
      // Micromark classifies UTF-16 units, not decoded surrogate pairs.
      const before = i > start ? source.charCodeAt(i - 1) : Char.Space
      const after = stop < end ? source.charCodeAt(stop) : Char.Space
      const beforeSpace = isWhitespace(before)
      const afterSpace = isWhitespace(after)
      const beforePunct = isPunctuation(before)
      const afterPunct = isPunctuation(after)
      const left =
        (!afterSpace && (!afterPunct || beforeSpace || beforePunct)) ||
        (c !== Char.Tilde && context.config.gfm !== undefined && after === Char.Tilde)
      const right =
        (!beforeSpace && (!beforePunct || afterSpace || afterPunct)) ||
        (c !== Char.Tilde && context.config.gfm !== undefined && before === Char.Tilde)
      const canOpen = c === Char.Underscore ? left && (!right || beforePunct) : left
      const canClose = c === Char.Underscore ? right && (!left || afterPunct) : right
      delimiter(
        n,
        parent,
        i,
        length,
        c,
        (canOpen ? DelimiterFlag.CanOpen : 0) | (canClose ? DelimiterFlag.CanClose : 0),
      )
      i = textStart = stop
      continue
    }
    // ── Resolve bracket constructs now that all definitions are known ──
    if (
      c === Char.LeftBracket ||
      (c === Char.Exclamation && source.charCodeAt(i + 1) === Char.LeftBracket)
    ) {
      const image = c === Char.Exclamation
      const labelStart = i + (image ? 2 : 1)
      const close = bracketEnd(source, labelStart, end, view, context)
      if (close >= 0) {
        let stop = close + 1
        const raw = source.slice(labelStart, close)
        let data: any
        let reference = false
        let footnote = false
        if (
          !image &&
          raw.charCodeAt(0) === 94 &&
          raw.length > 1 &&
          !hasWhitespace(raw) &&
          context.config.gfm &&
          context.footnotes.has(normalizeIdentifier(raw.slice(1)))
        ) {
          data = { label: decode(raw.slice(1)), identifier: normalizeIdentifier(raw.slice(1)) }
          footnote = true
        } else if (image || !inLink) {
          if (source.charCodeAt(stop) === 40) data = resource(source, stop, end)
          if (data) stop = data.end
          else {
            let label = raw
            let type = 'shortcut'
            if (source.charCodeAt(stop) === 91) {
              label = ''
              let r = stop + 1
              while (r < end && source.charCodeAt(r) !== 93 && source.charCodeAt(r) !== 91) {
                if (source.charCodeAt(r) === 92) r++
                r++
              }
              if (source.charCodeAt(r) === 93) {
                label = source.slice(stop + 1, r)
                type = label ? 'full' : 'collapsed'
                if (!label) label = raw
                if (context.definitions.has(normalizeIdentifier(label))) stop = r + 1
                else label = ''
              }
            }
            if (label && context.definitions.has(normalizeIdentifier(label))) {
              data = {
                label: decode(label),
                identifier: normalizeIdentifier(label),
                referenceType: type,
              }
              reference = true
            }
          }
        }
        // Reject actual nested links, not brackets belonging to embedded syntax.
        if (data && !image && !footnote && containsLink(view, labelStart, close, context))
          data = undefined
        if (data) {
          if (textStart < i) plainText(view, textStart, i, parent)
          const kind = footnote
            ? Kind.FootnoteReference
            : image
              ? reference
                ? Kind.ImageReference
                : Kind.Image
              : reference
                ? Kind.LinkReference
                : Kind.Link
          const n = node(kind, offset(view, i), offset(view, stop), parent)
          tree.extra[n] = data
          if (!footnote) {
            parseInline(view, labelStart, close, n, context, !image, false, false)
            // MDX image alt waits for deferred JSX nesting before flattening.
            if (image && !context.config.mdx) {
              tree.value[n] = flatten(n)
              tree.child[n] = tree.last[n] = 0
            }
          }
          i = textStart = stop
          continue
        }
      }
      if (!image) unbalanced++
    }
    if (c === 93 && unbalanced) unbalanced--
    // ── Ordinary HTML and angle autolinks are disabled in MDX ──
    if (c === Char.LessThan && !context.config.mdx) {
      const auto = autolink(source, i, end)
      const stop = auto?.end ?? htmlEnd(source, i, end)
      if (stop > i) {
        if (textStart < i) plainText(view, textStart, i, parent)
        const n = node(
          auto ? Kind.Link : Kind.Html,
          offset(view, i),
          offset(view, stop),
          parent,
        )
        if (auto) {
          tree.extra[n] = { url: auto.url, title: null }
          plainText(view, i + 1, stop - 1, n, auto.value)
        } else tree.value[n] = trimContinuation(source.slice(i, stop), MAX_CONTINUATION_INDENT)
        i = textStart = stop
        continue
      }
    }
    i++
  }
  // ── Flush text, resolve attention, and release the recursive delimiter scope ──
  while (trim && end > textStart && space(source.charCodeAt(end - 1))) end--
  if (textStart < end) plainText(view, textStart, end, parent)
  resolveDelimiters(
    view,
    parent,
    delimiterBegin,
    delimiterCount,
    !trim || delimiterChar[delimiterBegin] === Char.Tilde,
  )
  delimiterCount = delimiterBegin
  mergeText(parent)
}

function hasWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (space(c) || c === 10 || c === 13) return true
  }
  return false
}

function unescapePipes(value: string): string {
  let result = ''
  let start = 0
  for (let i = 0; i + 1 < value.length; i++)
    if (value.charCodeAt(i) === 92 && value.charCodeAt(i + 1) === 124) {
      result += value.slice(start, i)
      start = i + 1
      i++
    }
  return result + value.slice(start)
}

function containsLink(view: View, start: number, end: number, context: InlineContext): boolean {
  const source = view.source
  for (let i = start; i < end; i++) {
    const c = source.charCodeAt(i)
    // Like bracketEnd, ignore reference-looking brackets inside expressions and JSX tags.
    if ((c === Char.LeftBrace || c === Char.LessThan) && context.inline) {
      const match = context.inline(view, i, end, context)
      if (match) {
        i = match.end - 1
        continue
      }
    }
    if (c === 92) {
      i++
      continue
    }
    if (c === 96 || (c === Char.Dollar && mathRun)) {
      let j = i + 1
      while (source.charCodeAt(j) === c) j++
      const close = spanEnd(source, j, end, j - i, c)
      if (close >= 0) {
        i = close + j - i - 1
        continue
      }
      i = j - 1
    }
    if (c === 60) {
      const stop = autolink(source, i, end)?.end ?? htmlEnd(source, i, end)
      if (stop > i) {
        i = stop - 1
        continue
      }
    }
    if (c === 33 && source.charCodeAt(i + 1) === 91) {
      const close = bracketEnd(source, i + 2, end, view, context)
      if (close >= 0) {
        // A link deactivates earlier link openings even through an image label.
        if (containsLink(view, i + 2, close, context)) return true
        let stop = close + 1
        if (source.charCodeAt(stop) === 40) stop = resource(source, stop, end)?.end ?? stop
        else if (source.charCodeAt(stop) === 91) {
          const ref = bracketEnd(source, stop + 1, end)
          if (ref >= 0) stop = ref + 1
        }
        i = stop - 1
        continue
      }
    }
    if (c !== 91) continue
    const close = bracketEnd(source, i + 1, end, view, context)
    if (close < 0) continue
    const stop = close + 1
    if (source.charCodeAt(stop) === 40 && resource(source, stop, end)) return true
    if (context.definitions.has(normalizeIdentifier(source.slice(i + 1, close)))) return true
    if (source.charCodeAt(stop) === 91) {
      const ref = bracketEnd(source, stop + 1, end)
      if (
        ref >= 0 &&
        context.definitions.has(
          normalizeIdentifier(source.slice(stop + 1, ref) || source.slice(i + 1, close)),
        )
      )
        return true
    }
  }
  return false
}

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
const enum Family {
  Attention = 1,
  Tilde = 2,
  Both = 3,
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
// First attention or tilde run of the current top-level content, labels included.
let firstRun = 0
// Shortest `$` run that opens inline math; 0 when math is off.
let mathRun = 0
const mathClosers = new Map<string, Map<number, number[]>>()
// Candidate scanners for this parse; math adds `$`.
let markdownCandidates = markdownMarkers
let gfmCandidates = gfmMarkers
let emailCandidates = emailStops
// Label closes of every `[` the last full bracketEnd scan passed, keyed by label start and
// stamped by scan, so openers nested in an unclosed label do not rescan it (`![[]()` floods).
let labelScan = 0
let labelStamp = new Int32Array(0)
let labelClose = new Int32Array(0)
let labelOpeners = new Int32Array(64)
let labelSource = ''
let labelView: View | undefined
let labelContext: InlineContext | undefined
let labelEnd = -1

// Container views write a tab's unconsumed columns as spaces mapped to the tab.
let documentSource = ''
// Ranges [from, to) that a failed micromark attempt read through, per top-level content.
// Micromark quirk: a line ending consumed again after such a backtrack ends after the next
// line's container prefix, because that prefix skip is only defined once the line is written.
// Only container views have prefixes. Line endings are queried in source order, so passed
// ranges are dropped.
let replayFrom: number[] = []
let replayTo: number[] = []
// Start of the earliest range that reads to the end of the content.
let replayRest = Infinity
let contentEnd = 0

export function resetInline(config: Config, source: string): void {
  documentSource = source
  delimiterCount = 0
  labelView = labelContext = undefined
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
  live: number = Family.Both,
): void {
  // Micromark uses tokenization order at the top level, tilde-first inside spans. Each
  // resolver turns its leftover runs into text, so spans the second family wraps only
  // resolve that family inside.
  const first = strikeFirst ? Family.Tilde : Family.Attention
  if (live & first) resolveFamily(view, parent, begin, end, strikeFirst, live)
  if (live & ~first) resolveFamily(view, parent, begin, end, !strikeFirst, live & ~first)
}

function resolveFamily(
  view: View,
  parent: number,
  begin: number,
  end: number,
  tilde: boolean,
  live: number,
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
      resolveDelimiters(view, wrapper, open + 1, close, true, live)
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
  const stop = destinationEnd(source, start, end)
  if (stop < 0) return
  // mdast stores decoded destinations; URI encoding belongs to HTML serialization.
  const angle = source.charCodeAt(start) === Char.LessThan
  const value = angle ? source.slice(start + 1, stop - 1) : source.slice(start, stop)
  return { end: stop, value: decode(value) }
}

/** End of the link destination at `start`, or -1. */
function destinationEnd(source: string, start: number, end: number): number {
  let i = start
  if (source.charCodeAt(i) === Char.LessThan) {
    for (i++; i < end; i++) {
      const c = source.charCodeAt(i)
      if (c === Char.GreaterThan) return i + 1
      if (c === Char.LessThan || c === Char.LineFeed || c === Char.CarriageReturn) return -1
      if (c === Char.Backslash && isPunctuation(source.charCodeAt(i + 1))) i++
    }
    return -1
  }
  let depth = 0
  for (; i < end; i++) {
    const c = source.charCodeAt(i)
    if ((c !== 0 && c <= Char.Space) || c === Char.Delete) break
    // A backslash at the end of the source escapes nothing.
    if (c === Char.Backslash && i + 1 < source.length && isPunctuation(source.charCodeAt(i + 1))) {
      i++
      continue
    }
    if (c === Char.LeftParen) {
      if (++depth > MAX_DESTINATION_PAREN_DEPTH) return -1
    } else if (c === Char.RightParen) {
      if (!depth) break
      depth--
    }
  }
  return depth ? -1 : i
}

export function title(
  source: string,
  start: number,
  end: number,
): { end: number; value: string } | undefined {
  const stop = titleEnd(source, start, end)
  if (stop >= 0)
    return { end: stop, value: decode(trimContinuation(source.slice(start + 1, stop - 1))) }
}

/** End of the link title at `start`, or -1. */
function titleEnd(source: string, start: number, end: number): number {
  const open = source.charCodeAt(start)
  if (open !== Char.DoubleQuote && open !== Char.SingleQuote && open !== Char.LeftParen) return -1
  const close = open === Char.LeftParen ? Char.RightParen : open
  for (let i = start + 1; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c === close) return i + 1
    if (c === 92 && isPunctuation(source.charCodeAt(i + 1))) i++
    if (c === 13 && source.charCodeAt(i + 1) === 10) {
      i++
      continue
    }
    if (
      (c === 10 || c === 13) &&
      (source.charCodeAt(i + 1) === 10 || source.charCodeAt(i + 1) === 13)
    )
      return -1
  }
  return -1
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

/** End of the resource at `start`, or -1; like resource without decoding its values. */
function resourceEnd(source: string, start: number, end: number): number {
  let i = skipWhitespace(source, start + 1, end)
  const dest = destinationEnd(source, i, end)
  if (dest < 0) return -1
  i = skipWhitespace(source, dest, end)
  if (i > dest && source.charCodeAt(i) !== 41) {
    const t = titleEnd(source, i, end)
    if (t < 0) return -1
    i = skipWhitespace(source, t, end)
  }
  return source.charCodeAt(i) === 41 ? i + 1 : -1
}

function bracketEnd(
  source: string,
  start: number,
  end: number,
  view: View,
  context: InlineContext,
): number {
  // A label start the cached scan passed has the same tokens up to its close. An unclosed
  // label is only known unclosed up to the cached end: a shorter end may split a token.
  if (
    view === labelView &&
    source === labelSource &&
    context === labelContext &&
    end <= labelEnd &&
    labelStamp[start] === labelScan
  ) {
    const close = labelClose[start]
    if (close >= 0 ? close < end : end === labelEnd) return close
  }
  if (labelStamp.length <= source.length) {
    labelStamp = new Int32Array(source.length + 1)
    labelClose = new Int32Array(source.length + 1)
    labelScan = 0
  }
  labelScan++
  labelSource = source
  labelView = view
  labelContext = context
  labelEnd = end
  // Depths of open inner image labels, innermost last. Link openers at depths below `active`
  // were marked inactive by an inner link: micromark ends them without a resource or reference.
  let images: number[] | undefined
  let depth = 0
  let active = 0
  // Definition labels hold no unescaped brackets, so only a label whose `[` is the last
  // bracket seen (`opener`, -1 after any other) can match one.
  let opener = -1
  for (let i = start; i < end; i++) {
    const c = source.charCodeAt(i)
    // Brackets inside expressions and JSX tags do not participate in Markdown labels.
    if ((c === Char.LeftBrace || c === Char.LessThan) && context.inline) {
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
    // Out-of-line skips keep this loop small enough for V8 to inline into parseInline.
    if (c === 60 || c === 96 || (c === Char.Dollar && mathRun)) i = skipSpan(source, i, end, c)
    else if (c === 91 || (c === Char.Exclamation && source.charCodeAt(i + 1) === 91)) {
      if (c === Char.Exclamation) {
        if (!images) images = []
        images.push(depth)
        i++
      }
      if (depth === labelOpeners.length) {
        const grown = new Int32Array(depth * 2)
        grown.set(labelOpeners)
        labelOpeners = grown
      }
      labelOpeners[depth] = i + 1
      labelStamp[i + 1] = labelScan
      labelClose[i + 1] = -1
      depth++
      opener = i
    } else if (c === 93) {
      if (!depth) return i
      depth--
      labelClose[labelOpeners[depth]] = i
      const image = images !== undefined && images[images.length - 1] === depth
      if (image) images!.pop()
      const labelStart = opener + 1
      opener = -1
      if (depth < active) {
        active = depth
        if (!image) continue
      }
      // Resources and references belong to the inner label, not the enclosing one.
      const stop = innerTail(source, labelStart, i, end, context, image)
      if (stop < 0) continue
      if (!image) active = depth
      i = stop - 1
    }
  }
  return -1
}

/** Last index of the HTML, autolink, code or math span at `i`, else of its unmatched run. */
function skipSpan(source: string, i: number, end: number, c: number): number {
  if (c === 60) return Math.max(i, (autolink(source, i, end)?.end ?? htmlEnd(source, i, end)) - 1)
  let run = i + 1
  while (source.charCodeAt(run) === c) run++
  const close = spanEnd(source, run, end, run - i, c)
  // An unmatched run stays whole; its suffix cannot open a shorter span.
  return close >= 0 ? close + run - i - 1 : run - 1
}

/**
 * End of the inner link or image closed at `close`, or -1. `labelStart` is 0 when the label
 * holds brackets. Kept out of bracketEnd so its scan loop stays small enough to inline.
 */
function innerTail(
  source: string,
  labelStart: number,
  close: number,
  end: number,
  context: InlineContext,
  image: boolean,
): number {
  const next = source.charCodeAt(close + 1)
  const plain = labelStart > 0
  // Only a resource, a reference, or a defined shortcut label forms an inner link.
  if (next !== 40 && next !== 91 && !(plain && context.definitions.size)) return -1
  // A defined GFM footnote call is no label: it takes no trailing resource or reference.
  if (plain && !image && source.charCodeAt(labelStart) === 94 && context.config.gfm) {
    const label = source.slice(labelStart + 1, close)
    if (label && !hasWhitespace(label) && context.footnotes.has(normalizeIdentifier(label)))
      return -1
  }
  return labelTail(source, labelStart, close, end, context, plain)
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

function codeValue(view: View, start: number, end: number): string {
  const source = view.source
  // CommonMark trims one edge space only when the code span is not entirely spaces.
  // micromark reads the virtual spaces of a split tab as data, never as padding.
  let allSpaces = true
  for (let i = start; i < end; i++) {
    const c = source.charCodeAt(i)
    if ((c !== 32 && c !== 10 && c !== 13) || virtualSpace(view, i)) allSpaces = false
  }
  const first = source.charCodeAt(start)
  const last = source.charCodeAt(end - 1)
  if (
    !allSpaces &&
    (first === 32 || first === 10 || first === 13) &&
    (last === 32 || last === 10 || last === 13) &&
    !virtualSpace(view, end - 1)
  ) {
    start += first === 13 && source.charCodeAt(start + 1) === 10 ? 2 : 1
    end -= last === 10 && source.charCodeAt(end - 2) === 13 ? 2 : 1
  }
  return source.slice(start, end)
}

function virtualSpace(view: View, i: number): boolean {
  return (
    !!view.map &&
    view.source.charCodeAt(i) === Char.Space &&
    documentSource.charCodeAt(view.map[i]) === Char.Tab
  )
}

// Where the last failed htmlEnd stopped reading.
let htmlReach = 0

function attributeValueEnd(source: string, at: number, end: number, loose: boolean): number {
  let i = at
  for (;;) {
    const c = source.charCodeAt(i)
    if (i >= end || c === 60 || c === 61 || c === 62 || c === 96) return htmlFailure(i)
    if (c === 34 || c === 39) {
      const stop = source.indexOf(source[i], i + 1)
      return stop < 0 || stop >= end ? htmlFailure(end) : stop + 1
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
    if (i === begin) return htmlFailure(i)
    if (!loose || source.charCodeAt(i) !== 61) return i
    i++
    while (space(source.charCodeAt(i))) i++
  }
}

function htmlFailure(at: number): number {
  htmlReach = at
  return -1
}

export function htmlEnd(source: string, start: number, end: number, loose = false): number {
  let i = start + 1
  htmlReach = i
  if (source.startsWith('<!--', start)) {
    // Micromark accepts the short comment endings <!--> and <!--->.
    if (source.charCodeAt(start + 4) === 62) return start + 5
    if (source.charCodeAt(start + 4) === 45 && source.charCodeAt(start + 5) === 62)
      return start + 6
    const stop = source.indexOf('-->', start + 4)
    return stop < 0 || stop + 3 > end ? htmlFailure(end) : stop + 3
  }
  if (source.startsWith('<![CDATA[', start)) {
    const stop = source.indexOf(']]>', start + 9)
    return stop < 0 || stop + 3 > end ? htmlFailure(end) : stop + 3
  }
  if (source.charCodeAt(i) === 63) {
    const stop = source.indexOf('?>', i + 1)
    return stop < 0 || stop + 2 > end ? htmlFailure(end) : stop + 2
  }
  if (source.charCodeAt(i) === 33) {
    if (!alpha(source.charCodeAt(i + 1))) return -1
    const stop = source.indexOf('>', i + 2)
    return stop < 0 || stop >= end ? htmlFailure(end) : stop + 1
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
    if (closing || i === before) return htmlFailure(i)
    const c = source.charCodeAt(i)
    if (!alpha(c) && c !== 95 && c !== 58) return htmlFailure(i)
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
  return htmlFailure(end)
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
    last === 10 || last === 13 ? lineEndingEnd(view, end) : offset(view, end),
    parent,
  )
  tree.value[n] = value ?? decode(view.source.slice(start, end))
  return n
}

function replay(from: number, to: number): void {
  if (to >= contentEnd) replayRest = Math.min(replayRest, from)
  else {
    replayFrom.push(from)
    replayTo.push(to)
  }
}

/** Source offset after the line ending that ends before virtual index `stop`. */
function lineEndingEnd(view: View, stop: number): number {
  if (!view.map || !replayed(stop)) return offset(view, stop - 1) + 1
  const at = offset(view, stop)
  // A partly consumed tab belongs to the prefix: the skip lands after it.
  return view.source.charCodeAt(stop) === Char.Space && documentSource.charCodeAt(at) === Char.Tab
    ? at + 1
    : at
}

function replayed(stop: number): boolean {
  if (replayRest < stop) return true
  let live = 0
  let hit = false
  for (let k = 0; k < replayFrom.length; k++) {
    if (replayTo[k] < stop) continue
    if (replayFrom[k] < stop) hit = true
    replayFrom[live] = replayFrom[k]
    replayTo[live++] = replayTo[k]
  }
  replayFrom.length = replayTo.length = live
  return hit
}

/** Where micromark rejects the resource at `start` that `resource` did not accept. */
function resourceFailure(source: string, start: number, end: number): number {
  let i = skipWhitespace(source, start + 1, end)
  const dest = destinationEnd(source, i, end)
  if (dest < 0) {
    if (source.charCodeAt(i) === Char.LessThan) {
      for (i++; i < end; i++) {
        const c = source.charCodeAt(i)
        if (c === Char.LessThan || c === Char.LineFeed || c === Char.CarriageReturn) return i
        if (c === Char.Backslash && isPunctuation(source.charCodeAt(i + 1))) i++
      }
      return end
    }
    let depth = 0
    for (; i < end; i++) {
      const c = source.charCodeAt(i)
      if ((c !== 0 && c <= Char.Space) || c === Char.Delete) return i
      if (c === Char.Backslash && isPunctuation(source.charCodeAt(i + 1))) i++
      else if (c === Char.LeftParen && ++depth > MAX_DESTINATION_PAREN_DEPTH) return i
      else if (c === Char.RightParen) depth--
    }
    return end
  }
  i = skipWhitespace(source, dest, end)
  if (i > dest && source.charCodeAt(i) !== Char.RightParen) {
    const t = titleEnd(source, i, end)
    if (t < 0) return titleOpener(source.charCodeAt(i)) ? end : i
    i = skipWhitespace(source, t, end)
  }
  return i
}

function titleOpener(c: number): boolean {
  return c === Char.DoubleQuote || c === Char.SingleQuote || c === Char.LeftParen
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
  if (trim) {
    firstRun = 0
    replayFrom.length = replayTo.length = 0
    replayRest = Infinity
    contentEnd = end
  }
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
        node(Kind.Break, offset(view, i), lineEndingEnd(view, stop), parent)
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
        node(Kind.Break, offset(view, trim), lineEndingEnd(view, stop), parent)
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
        tree.value[n] = codeValue(view, run, close)
        if (view.table) tree.value[n] = unescapePipes(tree.value[n]!)
        i = textStart = stop
        continue
      }
      replay(i, Infinity)
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
        tree.value[n] = codeValue(view, run, close)
        i = textStart = stop
        continue
      }
      // A run shorter than the math opener is never attempted.
      if (run - i >= mathRun) replay(i, Infinity)
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
      // Micromark classifies UTF-16 units, not decoded surrogate pairs. Label edges see
      // their own brackets, not whitespace.
      const before = i > start || !trim ? source.charCodeAt(i - 1) : Char.Space
      const after = stop < end || !trim ? source.charCodeAt(stop) : Char.Space
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
      if (!firstRun) firstRun = c
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
          if (source.charCodeAt(stop) === 40) {
            data = resource(source, stop, end)
            if (!data && view.map) replay(stop, resourceFailure(source, stop, end))
          }
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
              if (stop <= r) replay(stop, source.charCodeAt(r) === 93 ? r + 1 : r)
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
        } else if (view.map && source.charCodeAt(stop) === 40) {
          // micromark still tries, and rejects, the resource of a label inside a link label.
          replay(stop, resourceFailure(source, stop, end))
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
      if (!auto) replay(i, htmlReach)
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
    !trim || firstRun === Char.Tilde,
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
        // A failed image reference leaves its trailing brackets to be scanned as labels.
        const stop = labelTail(source, i + 2, close, end, context)
        i = (stop < 0 ? close + 1 : stop) - 1
        continue
      }
    }
    if (c !== 91) continue
    const close = bracketEnd(source, i + 1, end, view, context)
    if (close < 0) continue
    // A defined GFM footnote call takes the whole bracket, never a trailing resource.
    if (
      source.charCodeAt(i + 1) === 94 &&
      close > i + 2 &&
      context.config.gfm &&
      context.footnotes.has(normalizeIdentifier(source.slice(i + 2, close))) &&
      !hasWhitespace(source.slice(i + 2, close))
    ) {
      i = close
      continue
    }
    if (labelTail(source, i + 1, close, end, context) >= 0) return true
  }
  return false
}

/**
 * End of the link or image whose label spans `start..close`, or -1 when it does not form.
 * Mirrors micromark's label end: a failed resource falls back to a shortcut, but a following
 * `[` must complete a full or collapsed reference, so `[a][missing]` is no link even with `[a]`.
 * `plain` is false when the label holds brackets, so no definition can match it.
 */
function labelTail(
  source: string,
  start: number,
  close: number,
  end: number,
  context: InlineContext,
  plain = true,
): number {
  const stop = close + 1
  const c = source.charCodeAt(stop)
  const lookup = plain && context.definitions.size > 0
  if (c === 91) {
    let r = stop + 1
    while (r < end && source.charCodeAt(r) !== 93 && source.charCodeAt(r) !== 91) {
      if (source.charCodeAt(r) === 92) r++
      r++
    }
    if (source.charCodeAt(r) !== 93) return -1
    if (r > stop + 1)
      return context.definitions.has(normalizeIdentifier(source.slice(stop + 1, r))) ? r + 1 : -1
    return lookup && context.definitions.has(normalizeIdentifier(source.slice(start, close)))
      ? r + 1
      : -1
  }
  if (c === 40) {
    const match = resourceEnd(source, stop, end)
    if (match >= 0) return match
  }
  return lookup && context.definitions.has(normalizeIdentifier(source.slice(start, close)))
    ? stop
    : -1
}

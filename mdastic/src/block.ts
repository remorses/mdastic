// Recognize blocks in CommonMark precedence order and collect definitions.
// Queue stripped source views for inline parsing after block discovery.
import type { Config } from './syntax.ts'
import type { AlignType } from './types.ts'
import {
  alpha,
  ASCII_SIZE,
  Char,
  decode,
  digit,
  isPunctuation,
  lineCount,
  lineStarts,
  normalizeIdentifier,
  point,
  space,
  TAB_SIZE,
} from './scan.ts'
import {
  destination,
  htmlEnd,
  offset,
  parseInline,
  title,
  type DefinitionData,
  type InlineContext,
  type View,
} from './inline.ts'
import { Kind, node, TaskState, tree } from './tree.ts'

export interface Line {
  // Offsets stay in the original source; padding represents unconsumed tab columns.
  start: number
  end: number
  next: number
  padding?: number
  lazy?: boolean
}
export interface BlockContext extends InlineContext {
  source: string
  flow?: (
    context: BlockContext,
    input: Line[],
    at: number,
    parent: number,
    boundary?: Line,
  ) => number
  flowParent?: (parent: number) => number
  interrupt?: (line: Line) => boolean
  esm?: (line: Line) => boolean
  // With `input`, tags are read without the container's line prefixes.
  continuationEnd?: (
    line: Line,
    context?: BlockContext,
    input?: Line[],
    at?: number,
    boundary?: Line,
  ) => number
  continuation?: (
    context: BlockContext,
    input: Line[],
    at: number,
    boundary?: Line,
  ) => boolean | undefined
}
interface Marker {
  start: number
  content: number
  indent: number
  ordered: boolean
  number: number
  char: number
  padding: number
}
const enum InterruptState {
  None = 0,
  Paragraph = 1,
  Definition = 2,
  IndentedCode = 3,
}
const MAX_BLOCK_INDENT = 3
const CODE_INDENT = 4
const FOOTNOTE_INDENT = 4
const MAX_HEADING_DEPTH = 6
const MIN_THEMATIC_MARKERS = 3
const MIN_FENCE_LENGTH = 3
const MIN_MATH_FENCE_LENGTH = 2
const MAX_ORDERED_MARKER_DIGITS = 9
const MAX_LIST_PADDING = 4
const MAX_LABEL_LENGTH = 999
const MAX_LAZY_CONTAINER_PROBES = 100
const INITIAL_TASK_CAPACITY = 1024
const TASK_CLEANUP_PENDING = 1

let mdxMode = false
let mathMode = false
// Quirk: micromark attempts an unclosed frontmatter fence up to EOF, and no line that
// attempt spans starts a container. Set by frontmatter(), reset per parse.
let noContainers = false
// Open blockquotes; nothing inside one keeps the final EOF line ending.
let quoteDepth = 0
// A line that continues an open list as its next item. micromark closes the containers inside
// that list before the preceding blank lines, so they never close at its prefix.
let siblingLine: Line | undefined
// The line right after a container whose last line is a table row. micromark tries it
// as a lazy body row, which fails, and never as a new table head: `> a|b\n> -|-\nc|d\n-|-`.
let afterTable: Line | undefined
// Set by lazyState when the line has a list marker, even one it reads as paragraph text.
let lazyListed = false
// Content lines of the outermost open footnote definition. Every non-blank one after the label
// line starts with the definition's indent token, which prepareList does not look back past.
let footnoteLines: Line[] | undefined

let taskCount = 0
let taskParents = new Int32Array(INITIAL_TASK_CAPACITY)
let taskStarts = new Int32Array(INITIAL_TASK_CAPACITY)
const taskViews: (View | undefined)[] = []
// Lines runStart..runLimit-1 of runInput continue a paragraph and share one definition scan.
let runInput: Line[] | undefined
let runStart = 0
let runLimit = 0

export function resetBlocks(): void {
  noContainers = false
  runInput = undefined
  quoteDepth = 0
  siblingLine = undefined
  afterTable = undefined
  footnoteLines = undefined
  taskCount = 0
  taskViews.length = 0
}

function inlineTask(view: View, parent: number): void {
  if (taskCount === taskParents.length) {
    const parents = new Int32Array(taskCount * 2)
    parents.set(taskParents)
    taskParents = parents
    const starts = new Int32Array(taskCount * 2)
    starts.set(taskStarts)
    taskStarts = starts
  }
  taskViews[taskCount] = view
  taskParents[taskCount] = parent
  taskStarts[taskCount++] = 0
}

export function lines(source: string, from = 0): Line[] {
  const result: Line[] = []
  let first = 0
  while (first < lineCount && lineStarts[first] < from) first++
  for (let i = first; i < lineCount; i++) {
    const start = lineStarts[i]
    const next = i + 1 < lineCount ? lineStarts[i + 1] : source.length
    let end = next
    if (source.charCodeAt(end - 1) === 10) end--
    if (source.charCodeAt(end - 1) === 13) end--
    result.push({ start, end, next })
  }
  return result
}

function indentation(source: string, line: Line): { start: number; indent: number } {
  let start = line.start
  let indent = line.padding ?? 0
  while (start < line.end && space(source.charCodeAt(start))) {
    indent += source.charCodeAt(start) === 9 ? tabWidth(source, start) : 1
    start++
  }
  return { start, indent }
}
export function blank(source: string, line: Line): boolean {
  return indentation(source, line).start === line.end
}
// micromark only looks for a task checkbox in an item's first content. A first
// line with only whitespace after the marker, or a blank line after leading
// definitions, starts a later content, so the paragraph is not a task.
function inFirstContent(
  source: string,
  content: Line[],
  markerContent: number,
  paragraph: number,
): boolean {
  if (blank(source, content[0]) && space(source.charCodeAt(markerContent - 1))) return false
  for (let k = 1; k < content.length && content[k].start < paragraph; k++)
    if (blank(source, content[k])) return false
  return true
}
function trimEnd(source: string, start: number, end: number): number {
  while (end > start && space(source.charCodeAt(end - 1))) end--
  return end
}

function stripIndent(source: string, line: Line, amount: number): Line {
  // Stripping part of a tab leaves virtual spaces, not a shifted source offset.
  let i = line.start
  let indent = line.padding ?? 0
  if (indent >= amount) return { ...line, padding: indent - amount }
  while (i < line.end && indent < amount && space(source.charCodeAt(i))) {
    indent += source.charCodeAt(i) === 9 ? tabWidth(source, i) : 1
    i++
  }
  return {
    start: i,
    end: line.end,
    next: line.next,
    padding: Math.max(0, indent - amount),
    lazy: line.lazy,
  }
}

export function tabWidth(source: string, at: number): number {
  let start = at
  while (start && source.charCodeAt(start - 1) !== 10 && source.charCodeAt(start - 1) !== 13)
    start--
  let column = 0
  for (let i = start; i < at; i++)
    column += source.charCodeAt(i) === Char.Tab ? TAB_SIZE - (column % TAB_SIZE) : 1
  return TAB_SIZE - (column % TAB_SIZE)
}

function thematic(source: string, line: Line, mdx = mdxMode): boolean {
  const scan = indentation(source, line)
  if (!mdx && scan.indent > MAX_BLOCK_INDENT) return false
  const c = source.charCodeAt(scan.start)
  if (c !== 42 && c !== 45 && c !== 95) return false
  let count = 0
  for (let i = scan.start; i < line.end; i++) {
    const d = source.charCodeAt(i)
    if (d === c) count++
    else if (!space(d)) return false
  }
  return count >= MIN_THEMATIC_MARKERS
}

function atx(
  source: string,
  line: Line,
  mdx = mdxMode,
): { start: number; content: number; end: number; depth: number } | undefined {
  const scan = indentation(source, line)
  if ((!mdx && scan.indent > MAX_BLOCK_INDENT) || source.charCodeAt(scan.start) !== Char.Hash)
    return
  let i = scan.start
  while (source.charCodeAt(i) === 35) i++
  const depth = i - scan.start
  if (depth > MAX_HEADING_DEPTH || (i < line.end && !space(source.charCodeAt(i)))) return
  while (space(source.charCodeAt(i))) i++
  const content = i
  let end = trimEnd(source, content, line.end)
  let tail = end
  while (tail > content && source.charCodeAt(tail - 1) === 35) tail--
  if (tail === content || (tail < end && space(source.charCodeAt(tail - 1))))
    end = trimEnd(source, content, tail)
  return { start: scan.start, content, end, depth }
}

function setext(source: string, line: Line, mdx = mdxMode): number {
  const scan = indentation(source, line)
  if (!mdx && scan.indent > MAX_BLOCK_INDENT) return 0
  const c = source.charCodeAt(scan.start)
  if (c !== 45 && c !== 61) return 0
  let i = scan.start
  while (source.charCodeAt(i) === c) i++
  if (i === scan.start) return 0
  while (space(source.charCodeAt(i))) i++
  return i === line.end ? (c === 61 ? 1 : 2) : 0
}

function fence(
  source: string,
  line: Line,
  mdx = mdxMode,
):
  | { start: number; content: number; char: number; length: number; indent: number }
  | undefined {
  const scan = indentation(source, line)
  if (!mdx && scan.indent > MAX_BLOCK_INDENT) return
  const c = source.charCodeAt(scan.start)
  const math = c === Char.Dollar
  if (c !== Char.Backtick && c !== Char.Tilde && !(math && mathMode)) return
  let i = scan.start
  while (source.charCodeAt(i) === c) i++
  if (i - scan.start < (math ? MIN_MATH_FENCE_LENGTH : MIN_FENCE_LENGTH)) return
  // Backtick and dollar fences cannot repeat their marker in the info string.
  if (c !== Char.Tilde) for (let j = i; j < line.end; j++) if (source.charCodeAt(j) === c) return
  return { start: scan.start, content: i, char: c, length: i - scan.start, indent: scan.indent }
}

function marker(source: string, line: Line, mdx = mdxMode): Marker | undefined {
  const scan = indentation(source, line)
  if (noContainers || (!mdx && scan.indent > MAX_BLOCK_INDENT)) return
  let i = scan.start
  const c = source.charCodeAt(i)
  let number = 0
  let ordered = false
  if (digit(c)) {
    ordered = true
    // CommonMark permits at most nine digits in an ordered-list marker.
    while (digit(source.charCodeAt(i)) && i - scan.start < MAX_ORDERED_MARKER_DIGITS)
      number = number * 10 + source.charCodeAt(i++) - Char.Digit0
    if (source.charCodeAt(i) !== 46 && source.charCodeAt(i) !== 41) return
    i++
  } else if (c === 42 || c === 43 || c === 45) i++
  else return
  if (i < line.end && !space(source.charCodeAt(i))) return
  const markerEnd = i
  let padding = 0
  while (i < line.end && space(source.charCodeAt(i))) {
    padding += source.charCodeAt(i) === 9 ? tabWidth(source, i) : 1
    i++
  }
  let remaining = 0
  // Oversized padding consumes just one separator; the remainder belongs to content.
  // MDX has no indented code, so there the item keeps all of it.
  if ((!mdx && padding > MAX_LIST_PADDING) || i === line.end) {
    remaining = source.charCodeAt(markerEnd) === 9 ? tabWidth(source, markerEnd) - 1 : 0
    i = markerEnd < line.end ? markerEnd + 1 : markerEnd
    padding = 1
  }
  return {
    start: scan.start,
    content: i,
    indent: scan.indent + markerEnd - scan.start + (padding || 1),
    ordered,
    number,
    char: source.charCodeAt(markerEnd - 1),
    padding: remaining,
  }
}

export function quote(source: string, line: Line, mdx = mdxMode): number {
  const scan = indentation(source, line)
  if (
    noContainers ||
    (!mdx && scan.indent > MAX_BLOCK_INDENT) ||
    source.charCodeAt(scan.start) !== Char.GreaterThan
  )
    return -1
  let i = scan.start + 1
  if (space(source.charCodeAt(i))) i++
  return i
}

const htmlBlocks = new Set([
  'address',
  'article',
  'aside',
  'base',
  'basefont',
  'blockquote',
  'body',
  'caption',
  'center',
  'col',
  'colgroup',
  'dd',
  'details',
  'dialog',
  'dir',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'frame',
  'frameset',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hr',
  'html',
  'iframe',
  'legend',
  'li',
  'link',
  'main',
  'menu',
  'menuitem',
  'nav',
  'noframes',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'search',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'title',
  'tr',
  'track',
  'ul',
])
const rawHtmlEnd = /<\/(?:script|pre|style|textarea)>/i

function htmlBlock(
  source: string,
  line: Line,
  interrupt: boolean,
): { start: number; until: string | RegExp | null } | undefined {
  const scan = indentation(source, line)
  const start = scan.start
  if (scan.indent > MAX_BLOCK_INDENT || source.charCodeAt(start) !== Char.LessThan) return
  if (source.startsWith('<!--', start)) return { start, until: '-->' }
  if (source.startsWith('<?', start)) return { start, until: '?>' }
  if (source.startsWith('<![CDATA[', start)) return { start, until: ']]>' }
  if (source.charCodeAt(start + 1) === 33 && alpha(source.charCodeAt(start + 2)))
    return { start, until: '>' }
  let i = start + 1
  if (source.charCodeAt(i) === 47) i++
  const begin = i
  while (alpha(source.charCodeAt(i)) || digit(source.charCodeAt(i))) i++
  const tag = source.slice(begin, i).toLowerCase()
  if (
    space(source.charCodeAt(i)) ||
    source.charCodeAt(i) === 62 ||
    (source.charCodeAt(i) === 47 && source.charCodeAt(i + 1) === 62) ||
    i === line.end
  ) {
    if (
      source.charCodeAt(start + 1) !== 47 &&
      source.charCodeAt(i) !== 47 &&
      (tag === 'script' || tag === 'pre' || tag === 'style' || tag === 'textarea')
    )
      // Quirk: any raw closing tag ends the block, not just the opening tag's name.
      return { start, until: rawHtmlEnd }
    if (htmlBlocks.has(tag)) return { start, until: null }
  }
  // CommonMark HTML type 7 cannot interrupt an existing paragraph.
  if (!interrupt) {
    const stop = htmlEnd(source, start, line.end, true)
    if (stop > 0 && trimEnd(source, stop, line.end) === stop) return { start, until: null }
  }
}

// Interrupters that still end a paragraph while an MDX span covers the line.
function flowInterrupts(context: BlockContext, line: Line): boolean {
  const source = context.source
  if (context.interrupt?.(line)) return true
  if (blank(source, line) || thematic(source, line) || atx(source, line) || fence(source, line))
    return true
  return !context.config.mdx && !!htmlBlock(source, line, true)
}

function interrupts(context: BlockContext, line: Line): boolean {
  const source = context.source
  if (flowInterrupts(context, line) || quote(source, line) >= 0) return true
  if (context.config.gfm && footnoteLabel(source, line)) return true
  const m = marker(source, line)
  // Only nonempty ordered items starting with 1 can interrupt a paragraph.
  return (
    !!m &&
    (!m.ordered ||
      (source.charCodeAt(m.start) === 49 &&
        (source.charCodeAt(m.start + 1) === 46 || source.charCodeAt(m.start + 1) === 41))) &&
    !blank(source, { start: m.content, end: line.end, next: line.next, padding: m.padding })
  )
}

// A lazy line opening a multi-line MDX flow tag or expression stays in the container, so
// micromark's laziness check runs on the lines it spans.
function lazyFlowSpan(context: BlockContext, line: Line): boolean {
  return (
    !!context.interrupt?.(line) && (context.continuationEnd?.(line) ?? line.end) > line.end
  )
}

function footnoteLabel(source: string, line: Line): { end: number; raw: string } | undefined {
  const scan = indentation(source, line)
  if (
    noContainers ||
    (!mdxMode && scan.indent > MAX_BLOCK_INDENT) ||
    !source.startsWith('[^', scan.start)
  )
    return
  let i = scan.start + 2
  for (; i < line.end; i++) {
    const c = source.charCodeAt(i)
    if (space(c) || c === 91) return
    if (c === 93) break
    if (
      c === Char.Backslash &&
      source.charCodeAt(i + 1) < ASCII_SIZE &&
      isPunctuation(source.charCodeAt(i + 1))
    )
      i++
  }
  if (
    i === scan.start + 2 ||
    i - scan.start > MAX_LABEL_LENGTH + 2 ||
    source.charCodeAt(i) !== 93 ||
    source.charCodeAt(i + 1) !== 58
  )
    return
  return { end: i + 2, raw: source.slice(scan.start + 2, i) }
}

// micromark's block quote continuation fails at EOF, so a final empty line is lazy in one.
export function inQuote(): boolean {
  return quoteDepth > 0
}

// The line opens a block quote, list item or footnote definition.
export function startsContainer(context: BlockContext, line: Line): boolean {
  const source = context.source
  return (
    quote(source, line) >= 0 ||
    (!!marker(source, line) && !thematic(source, line)) ||
    (!!context.config.gfm && !!footnoteLabel(source, line))
  )
}

// micromark exits a quoted list or footnote definition after the prefix (quote markers or a
// footnote definition's indent) of the line opening a new container, or of a final prefix-only
// line at EOF, not before the blank lines preceding it.
function closesQuotedContainer(
  context: BlockContext,
  input: Line[],
  j: number,
  boundary: Line | undefined,
): boolean {
  const source = context.source
  const line = j < input.length ? input[j] : boundary
  // A parent that ended on a lazy line does not hand its boundary down as a container start.
  if (!line || line === siblingLine || line.lazy || (j >= input.length && input[j - 1]?.lazy))
    return false
  if (!quotePrefix(source, line) && !footnoteIndented(source, line)) return false
  if (blank(source, line))
    return line.start === line.end && !line.padding && line.end === source.length
  return startsContainer(context, line)
}

// The line continues an open footnote definition through its indent, in any nested view of it.
function footnoteIndented(source: string, line: Line | undefined): boolean {
  const lines = footnoteLines
  if (!lines || !line || line.lazy) return false
  // Views of one source line share its `next`; the label line has no indent.
  let low = 1
  let high = lines.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const found = lines[middle]
    if (found.next < line.next) low = middle + 1
    else if (found.next > line.next) high = middle - 1
    else return !found.lazy && !blank(source, found)
  }
  return false
}

// Keep footnote exit locals outside recursive parseBlocks frames.
function closeFootnoteItem(
  context: BlockContext,
  input: Line[],
  j: number,
  lastContent: number,
  item: number,
  list: number,
  nextSibling: Marker | undefined,
  boundary: Line | undefined,
): boolean {
  if (!footnoteLines) return false
  const source = context.source
  const exit = nextSibling
    ? footnoteIndented(source, input[j]) && nextSibling.content
    : closesQuotedContainer(context, input, j, boundary)
      ? footnoteIndented(source, input[j] ?? boundary) && (input[j] ?? boundary!).start
      : j > lastContent + 1 &&
        quotePrefix(source, input[j - 1]) &&
        footnoteIndented(source, input[j - 1]) &&
        input[j - 1].end
  if (exit === false) return false
  // Quirk: the footnote indent stops prepareList's trailing line-ending scan.
  if (tree.end[item] <= input[lastContent].end)
    for (let k = lastContent + 1; k < j; k++)
      if (input[k].end < exit && blank(source, input[k])) tree.a[item] = 1
  tree.end[item] = exit
  tree.end[list] = exit
  return true
}

const enum LazyLine {
  Stop,
  Take,
  TakeLast,
}

// Quirk: lazy HTML ends the container as its last line, but stays outside when it ends the file.
function lazyLine(context: BlockContext, line: Line): LazyLine {
  if (context.config.mdx || !htmlBlock(context.source, line, false)) return LazyLine.Take
  return line.next === line.end ? LazyLine.Stop : LazyLine.TakeLast
}

// What is left of `line` inside the block quotes and list items `opener` opened, and
// whether `line` is lazy there. micromark rejects a lazy table delimiter row, so
// `- > a\n  b|c\n  -|-` is one quoted paragraph, while `- > a|b\n  > -|-` is a table.
function within(source: string, opener: Line, line: Line): { line: Line; lazy: boolean; list: boolean } {
  let list = false
  for (let depth = 0; depth < MAX_LAZY_CONTAINER_PROBES; depth++) {
    const q = quote(source, opener)
    const m = q < 0 ? marker(source, opener) : undefined
    if (q < 0 && !m) break
    list = !!m
    const next: Line = m
      ? { start: m.content, end: opener.end, next: opener.next, padding: m.padding }
      : { start: q, end: opener.end, next: opener.next, padding: quotePadding(source, q) }
    if (line.start === opener.start) line = { ...next, end: line.end, next: line.next }
    else if (m) {
      if (indentation(source, line).indent < m.indent) return { line, lazy: true, list }
      line = stripIndent(source, line, m.indent)
    } else {
      const r = quote(source, line)
      if (r < 0) return { line, lazy: true, list }
      line = { start: r, end: line.end, next: line.next, padding: quotePadding(source, r) }
    }
    opener = next
  }
  return { line, lazy: false, list }
}

function quotePadding(source: string, content: number): number {
  return source.charCodeAt(content - 1) === 9 ? tabWidth(source, content - 1) - 1 : 0
}

// A table row pair inside the paragraph `opener` opened: the delimiter row must not be lazy.
function nestedTable(context: BlockContext, opener: Line, header: Line, delimiter: Line): boolean {
  const source = context.source
  // Every delimiter row has a dash.
  let dash = delimiter.start
  while (dash < delimiter.end && source.charCodeAt(dash) !== 45) dash++
  if (dash === delimiter.end) return false
  const row = within(source, opener, delimiter)
  if (row.lazy) return false
  const head = within(source, opener, header).line
  // A blank line is no head row: `- a\n\n  -:\nb` is a paragraph that takes `b`.
  if (blank(source, head)) return false
  // MDX flow tags and expressions are tried before tables, so `> <a>\n> -|` is no table and
  // the paragraph `-|` still takes lazy lines.
  if (context.interrupt?.(head)) return false
  return !!tableStart(context, [head, row.line], 0)
}

// Whether `line` continues the table in the containers `opener` opened.
function tableRow(context: BlockContext, opener: Line, line: Line): boolean {
  const row = within(context.source, opener, line)
  return !row.lazy && !blank(context.source, row.line) && !interrupts(context, row.line)
}

// The line that opens the paragraph `line` leaves open, given the current one's opener.
function paragraphOpener(context: BlockContext, opener: Line, line: Line, open: boolean): Line {
  const source = context.source
  if (!open) {
    // An empty list item takes an indented next line as its first content, so the paragraph
    // that line opens is inside the item: `> 1.\n>    a|\n> -|\nb` keeps `-|` lazy.
    if (opener !== line) {
      const inner = within(source, opener, opener)
      if (inner.list && blank(source, inner.line) && !within(source, opener, line).lazy) return opener
    }
    return line
  }
  return interrupts(context, within(source, opener, line).line) ? line : opener
}

// What a container line leaves open for the next line, seen through the containers it starts.
// A paragraph takes lazy lines. Indented code takes none, but micromark keeps `interrupt` set
// after it, across blank lines too, so a marker on the next line that cannot interrupt is text.
// `open` is what the container had open before the line: `interrupted` rejects those markers at
// any depth, open code only directly in the container. `listed` says an earlier line may have
// left a list item open, which would take an indented line as its own content.
function lazyState(
  context: BlockContext,
  line: Line,
  interrupted = false,
  open = InterruptState.None,
  listed = false,
): InterruptState {
  const source = context.source
  let current = line
  lazyListed = false
  // This probe cap bounds implementation work; it is not a CommonMark grammar limit.
  for (let depth = 0; depth < MAX_LAZY_CONTAINER_PROBES; depth++) {
    const code = depth === 0 && open === InterruptState.IndentedCode
    if (blank(source, current)) return code ? InterruptState.IndentedCode : InterruptState.None
    // Only code directly in this container counts. A container this line starts, an earlier
    // list item, or an open paragraph may take the line instead.
    if (!context.config.mdx && indentation(source, current).indent >= CODE_INDENT)
      return depth === 0 && !listed && open !== InterruptState.Paragraph
        ? InterruptState.IndentedCode
        : InterruptState.None
    if (
      thematic(source, current) ||
      atx(source, current) ||
      fence(source, current) ||
      context.interrupt?.(current)
    )
      return InterruptState.None
    if (!context.config.mdx && htmlBlock(source, current, false)) return InterruptState.None
    const q = quote(source, current)
    const m = q < 0 ? marker(source, current) : undefined
    if (m) lazyListed = true
    if (
      m &&
      (interrupted || code) &&
      (blank(source, { start: m.content, end: line.end, next: line.next }) ||
        (m.ordered &&
          !(
            source.charCodeAt(m.start) === 49 &&
            (source.charCodeAt(m.start + 1) === 46 || source.charCodeAt(m.start + 1) === 41)
          )))
    )
      return InterruptState.Paragraph
    const start = q >= 0 ? q : m?.content
    if (start === undefined) return InterruptState.Paragraph
    current = { start, end: line.end, next: line.next }
  }
  return InterruptState.None
}

function quotePrefix(source: string, line: Line): boolean {
  for (
    let i = line.start - 1;
    i >= 0 && source.charCodeAt(i) !== 10 && source.charCodeAt(i) !== 13;
    i--
  )
    if (source.charCodeAt(i) === 62) return true
  return false
}

function viewFor(source: string, selected: Line[], trim = true): View {
  // Contiguous slices need no map; stripped containers use one slot per virtual unit.
  let contiguous = true
  for (let j = 0; j < selected.length; j++)
    if (
      ((!trim || j > 0) && selected[j].padding) ||
      (j > 0 && selected[j].start !== selected[j - 1].next)
    ) {
      contiguous = false
      break
    }
  if (contiguous && selected.length) {
    const first = selected[0]
    const start = trim ? indentation(source, first).start : first.start
    return { source: source.slice(start, selected[selected.length - 1].end), base: start }
  }
  if (selected.length === 1 && (trim || !selected[0].padding)) {
    const line = selected[0]
    const start = trim ? indentation(source, line).start : line.start
    return { source: source.slice(start, line.end), base: start }
  }
  let size = 0
  for (let j = 0; j < selected.length; j++) {
    const line = selected[j]
    const start = trim && j === 0 ? indentation(source, line).start : line.start
    size +=
      line.end -
      start +
      (trim && j === 0 ? 0 : (line.padding ?? 0)) +
      (j + 1 < selected.length ? line.next - line.end : 0)
  }
  // The extra slot maps EOF; virtual tab spaces map to the consumed tab.
  const map = new Int32Array(size + 1)
  let text = ''
  let k = 0
  for (let j = 0; j < selected.length; j++) {
    const line = selected[j]
    const start = trim && j === 0 ? indentation(source, line).start : line.start
    const end = j + 1 < selected.length ? line.next : line.end
    if ((!trim || j > 0) && line.padding) {
      text += ' '.repeat(line.padding)
      for (let p = 0; p < line.padding; p++) map[k++] = start - 1
    }
    text += source.slice(start, end)
    for (let i = start; i < end; i++) map[k++] = i
    map[k] = end
  }
  return { source: text, base: 0, map }
}

function queue(context: BlockContext, parent: number, selected: Line[]): void {
  const view = viewFor(context.source, selected)
  inlineTask(view, parent)
}

function parseDefinition(
  context: BlockContext,
  input: Line[],
  at: number,
  parent: number,
  continued = false,
): number {
  // ── Reject impossible prefixes before allocating a continuation view ──
  const original = context.source
  const line = input[at]
  const scan = indentation(original, line)
  // MDX has no indented code, so definitions and footnote labels take any indent.
  if (
    (!continued && !mdxMode && scan.indent > MAX_BLOCK_INDENT) ||
    original.charCodeAt(scan.start) !== Char.LeftBracket
  )
    return 0
  for (let i = scan.start + 1; i < line.end; i++) {
    const c = original.charCodeAt(i)
    if (c === 92) {
      i++
      continue
    }
    if (c === 91) return 0
    if (c === 93) {
      if (original.charCodeAt(i + 1) !== 58) return 0
      break
    }
  }
  if (tableStart(context, input, at)) return 0
  // ── Collect continuation lines without crossing another block construct ──
  // A table head row interrupts paragraph content, so the definition ends before it.
  let limit = at + 1
  if (input === runInput && at >= runStart && at < runLimit) {
    limit = runLimit
  } else {
    runInput = input
    runStart = at
    while (
      limit < input.length &&
      !blank(original, input[limit]) &&
      !interrupts(context, input[limit]) &&
      !setext(original, input[limit]) &&
      !tableStart(context, input, limit, true)
    )
      limit++
    runLimit = limit
  }
  // A definition usually spans a line or two of its run. Read a doubling window of lines and
  // widen it only when a read reaches the window end, where the full run could differ.
  for (let size = 2; ; size *= 2) {
    const stop = Math.min(limit, at + size)
    const consumed = readDefinition(context, input, at, stop, limit, parent, scan)
    if (consumed >= 0) return consumed
  }
}

// Consumed lines of the definition in lines at..stop-1, 0 when there is none, or -1 when the
// window ends before the definition does and more of the run (up to limit) must be read.
function readDefinition(
  context: BlockContext,
  input: Line[],
  at: number,
  stop: number,
  limit: number,
  parent: number,
  scan: { start: number },
): number {
  const original = context.source
  const line = input[at]
  const view = viewFor(original, input.slice(at, stop), false)
  const source = view.source
  // The window's text is a prefix of the run's, so only reads at its end may differ.
  const partial = stop < limit
  // The view starts with the line's virtual tab columns.
  let i = scan.start - line.start + (line.padding ?? 0) + 1
  // ── Read and normalize the reference label ──
  const labelStart = i
  while (
    i < source.length &&
    i - labelStart <= MAX_LABEL_LENGTH &&
    source.charCodeAt(i) !== 93 &&
    source.charCodeAt(i) !== 91
  ) {
    if (source.charCodeAt(i) === 92) i++
    i++
  }
  if (partial && i + 1 >= source.length) return -1
  if (
    i - labelStart > MAX_LABEL_LENGTH ||
    i === labelStart ||
    source.charCodeAt(i) !== 93 ||
    source.charCodeAt(i + 1) !== 58
  )
    return 0
  const raw = source.slice(labelStart, i)
  const identifier = normalizeIdentifier(raw)
  if (!identifier) return 0
  i += 2
  while (space(source.charCodeAt(i))) i++
  if (source.charCodeAt(i) === 10 || source.charCodeAt(i) === 13) {
    if (source.charCodeAt(i++) === 13 && source.charCodeAt(i) === 10) i++
    while (space(source.charCodeAt(i))) i++
  }
  // ── Read destination and optional title, then commit the definition ──
  // Destinations end at a line ending, so one inside the window bounds every read up to it.
  if (partial && !lineEndAfter(source, i)) return -1
  const dest = destination(source, i, source.length)
  if (!dest || dest.end === i) return 0
  i = dest.end
  const destEnd = i
  while (space(source.charCodeAt(i))) i++
  let label: string | null = null
  let end = i
  const newline = source.charCodeAt(i) === 10 || source.charCodeAt(i) === 13
  if (newline) {
    if (source.charCodeAt(i++) === 13 && source.charCodeAt(i) === 10) i++
    while (space(source.charCodeAt(i))) i++
    if (partial && i >= source.length) return -1
  }
  if (i > destEnd) {
    const t = title(source, i, source.length)
    if (t) {
      let stop = t.end
      while (space(source.charCodeAt(stop))) stop++
      if (partial && stop >= source.length) return -1
      if (
        stop === source.length ||
        source.charCodeAt(stop) === 10 ||
        source.charCodeAt(stop) === 13
      ) {
        label = t.value || null
        end = stop
      } else if (!newline) return 0
    } else {
      // An open title can only fail at a blank line or the end of the run.
      const c = source.charCodeAt(i)
      if (partial && (c === Char.DoubleQuote || c === Char.SingleQuote || c === Char.LeftParen))
        return -1
      if (!newline && i < source.length) return 0
    }
  } else if (i < source.length) return 0
  const absoluteEnd = offset(view, end)
  let consumed = 1
  while (at + consumed < input.length && input[at + consumed - 1].end < absoluteEnd) consumed++
  if (consumed > limit - at) return 0
  const data: DefinitionData = { identifier, label: decode(raw), url: dest.value, title: label }
  const n = node(Kind.Definition, scan.start, absoluteEnd, parent)
  tree.extra[n] = data
  // CommonMark resolves duplicate labels to the first definition.
  if (!context.definitions.has(identifier)) context.definitions.set(identifier, data)
  return consumed
}

function lineEndAfter(source: string, i: number): boolean {
  for (; i < source.length; i++) {
    const c = source.charCodeAt(i)
    if (c === 10 || c === 13) return true
  }
  return false
}

function tableCells(source: string, line: Line): [number, number][] {
  let start = indentation(source, line).start
  let end = trimEnd(source, start, line.end)
  if (source.charCodeAt(start) === 124) start++
  if (source.charCodeAt(end - 1) === 124) {
    let slashes = 0
    for (let i = end - 2; i >= start && source.charCodeAt(i) === 92; i--) slashes++
    if (!(slashes & 1)) end--
  }
  const cells: [number, number][] = []
  let begin = start
  for (let i = start; i < end; i++) {
    if (
      source.charCodeAt(i) === 92 &&
      (source.charCodeAt(i + 1) === 124 || source.charCodeAt(i + 1) === 92)
    ) {
      i++
      continue
    }
    if (source.charCodeAt(i) === 124) {
      cells.push([begin, i])
      begin = i + 1
    }
  }
  cells.push([begin, end])
  return cells
}

function tableAlign(source: string, line: Line): AlignType[] | undefined {
  const scan = indentation(source, line)
  if (!mdxMode && scan.indent > MAX_BLOCK_INDENT) return
  const first = source.charCodeAt(scan.start)
  if (first !== 45 && first !== 58 && first !== 124) return
  const cells = tableCells(source, line)
  const align: AlignType[] = []
  for (const cell of cells) {
    let i = cell[0]
    const end = trimEnd(source, i, cell[1])
    while (space(source.charCodeAt(i))) i++
    const left = source.charCodeAt(i) === 58
    if (left) i++
    const begin = i
    while (source.charCodeAt(i) === 45) i++
    if (i === begin) return
    const right = source.charCodeAt(i) === 58
    if (right) i++
    if (i !== end) return
    align.push(left ? (right ? 'center' : 'left') : right ? 'right' : null)
  }
  return align
}

function row(context: BlockContext, line: Line, parent: number): void {
  const source = context.source
  const n = node(Kind.TableRow, indentation(source, line).start, line.end, parent)
  const cells = tableCells(source, line)
  for (let i = 0; i < cells.length; i++) {
    const [start, end] = cells[i]
    const cell = node(
      Kind.TableCell,
      i === 0 ? indentation(source, line).start : start - 1,
      i + 1 === cells.length ? line.end : end,
      n,
    )
    let begin = start
    while (space(source.charCodeAt(begin))) begin++
    const finish = trimEnd(source, begin, end)
    const view = { source: source.slice(begin, finish), base: begin, table: true }
    inlineTask(view, cell)
  }
}

// HTML flow is tried before tables at `<`, so a table cannot start on an HTML block start.
// Interrupting paragraph content, the head row attempt still succeeds: it ends the paragraph,
// and then an HTML block of any kind, even one that cannot interrupt, starts there.
function tableStart(
  context: BlockContext,
  input: Line[],
  i: number,
  paragraph = false,
): AlignType[] | undefined {
  if (!context.config.gfm || !input[i + 1] || input[i + 1].lazy) return
  const source = context.source
  const align = tableAlign(source, input[i + 1])
  if (!align) return
  const headerLine = input[i]
  if (
    (!mdxMode && indentation(source, headerLine).indent >= CODE_INDENT) ||
    (marker(source, headerLine) && (!paragraph || interrupts(context, headerLine))) ||
    quote(source, headerLine) >= 0 ||
    footnoteLabel(source, headerLine) ||
    (!paragraph && !mdxMode && htmlBlock(source, headerLine, false))
  )
    return
  // A setext underline or list marker wins over a possible table delimiter row.
  if (setext(context.source, input[i + 1]) || marker(context.source, input[i + 1]))
    return
  const header = tableCells(context.source, input[i])
  if (header.length !== align.length) return
  if (header.length === 1 && header[0][0] > header[0][1]) return
  return align
}

// Whether the innermost last block of container `n` is a table whose last row ends at `end`.
// Callers check for a table start first: this walks the nesting depth.
function endsWithTable(n: number, end: number): boolean {
  let last = tree.last[n]
  while (
    last &&
    (tree.kind[last] === Kind.Blockquote ||
      tree.kind[last] === Kind.List ||
      tree.kind[last] === Kind.ListItem ||
      tree.kind[last] === Kind.FootnoteDefinition)
  )
    last = tree.last[last]
  return !!last && tree.kind[last] === Kind.Table && tree.end[last] === end
}

function parseTable(
  context: BlockContext,
  input: Line[],
  i: number,
  parent: number,
  paragraph: boolean,
): number {
  if (input[i] === afterTable) return 0
  const align = tableStart(context, input, i, paragraph)
  // The paragraph this line may interrupt has ended, so HTML blocks win here.
  if (!align || (!mdxMode && htmlBlock(context.source, input[i], false))) return 0
  const source = context.source
  const n = node(Kind.Table, indentation(source, input[i]).start, input[i + 1].end, parent)
  tree.extra[n] = align
  row(context, input[i], n)
  let j = i + 2
  for (
    ;
    j < input.length &&
    !input[j].lazy &&
    !interrupts(context, input[j]) &&
    !context.esm?.(input[j]) &&
    !marker(source, input[j]) &&
    (mdxMode || indentation(source, input[j]).indent < CODE_INDENT) &&
    (context.config.mdx || !htmlBlock(source, input[j], false));
    j++
  ) {
    row(context, input[j], n)
    tree.end[n] = input[j].end
  }
  return j - i
}

function frontmatter(context: BlockContext, input: Line[], parent: number): number {
  const config = context.config.frontmatter
  if (!config || !input.length) return 0
  const source = context.source
  const line = input[0]
  const c = source.charCodeAt(line.start)
  const yaml = c === 45 && config.yaml
  const toml = c === 43 && config.toml
  if (
    (!yaml && !toml) ||
    trimEnd(source, line.start, line.end) - line.start !== 3 ||
    source.charCodeAt(line.start + 1) !== c ||
    source.charCodeAt(line.start + 2) !== c
  )
    return 0
  for (let j = 1; j < input.length; j++) {
    const next = input[j]
    const end = trimEnd(source, next.start, next.end)
    if (
      end - next.start !== 3 ||
      source.charCodeAt(next.start) !== c ||
      source.charCodeAt(next.start + 1) !== c ||
      source.charCodeAt(next.start + 2) !== c
    )
      continue
    const n = node(yaml ? Kind.Yaml : Kind.Toml, line.start, next.end, parent)
    tree.value[n] = source.slice(line.next, j === 1 ? line.next : input[j - 1].end)
    return j + 1
  }
  noContainers = true
  return 0
}

function parseFencedCode(
  context: BlockContext,
  input: Line[],
  i: number,
  parent: number,
  opening: NonNullable<ReturnType<typeof fence>>,
  boundary?: Line,
): number {
  const source = context.source
  const line = input[i]
  let j = i + 1
  let closed = false
  const content: Line[] = []
  // Collect stripped content until a matching closing fence or container end.
  for (; j < input.length; j++) {
    const current = input[j]
    // Fenced code takes no lazy lines; parseBlocks hands them back to the container.
    if (current.lazy) break
    const scan = indentation(source, current)
    let k = scan.start
    while (source.charCodeAt(k) === opening.char) k++
    if (
      (mdxMode || scan.indent <= MAX_BLOCK_INDENT) &&
      k - scan.start >= opening.length &&
      trimEnd(source, k, current.end) === k
    ) {
      closed = true
      break
    }
    content.push(stripIndent(source, current, opening.indent))
  }
  const last = closed ? input[j] : input[Math.max(i, j - 1)]
  // micromark closes the flow before a new container (footnotes too, not thematic `- --`).
  const nextContainer = !input[j]?.lazy && boundary && startsContainer(context, boundary)
  // Unclosed root/EOF fences retain the ending; closed fences end at their marker.
  const keepEnding =
    tree.kind[parent] === Kind.Root ||
    !!nextContainer ||
    ((tree.kind[parent] === Kind.ListItem || tree.kind[parent] === Kind.FootnoteDefinition) &&
      last.next === source.length &&
      !quoteDepth)
  // A last EOF line of only container prefixes is outside the code but inside its parent.
  const prefixOnly =
    !closed && j > i + 1 && last.start === last.end && last.end === source.length && !last.padding
  const math = opening.char === Char.Dollar
  const n = node(
    math ? Kind.Math : Kind.Code,
    opening.start,
    prefixOnly ? input[j - 2].next : closed || !keepEnding ? last.end : last.next,
    parent,
  )
  if (prefixOnly) tree.end[parent] = Math.max(tree.end[parent], last.end)
  let info = opening.content
  while (space(source.charCodeAt(info))) info++
  let word = info
  while (word < line.end && !space(source.charCodeAt(word))) word++
  let meta = word
  while (space(source.charCodeAt(meta))) meta++
  // Math fences have no language; the whole info string is the meta.
  tree.extra[n] = math
    ? info === line.end
      ? null
      : decode(source.slice(info, line.end))
    : {
        lang: info === line.end ? null : decode(source.slice(info, word)),
        meta: meta === line.end ? null : decode(source.slice(meta, line.end)),
      }
  tree.value[n] = content.length ? viewFor(source, content, false).source : ''
  // A blank line ending its container, or an empty last line at EOF, is not part of the value.
  const tail = content[content.length - 1]
  if (
    !closed &&
    tail &&
    ((!keepEnding && blank(source, last)) ||
      (tail.start === tail.end && tail.end === source.length))
  ) {
    const value = tree.value[n]!
    if (value.charCodeAt(value.length - 1) === Char.LineFeed)
      tree.value[n] = value.slice(
        0,
        value.charCodeAt(value.length - 2) === Char.CarriageReturn ? -2 : -1,
      )
    else if (value.charCodeAt(value.length - 1) === Char.CarriageReturn)
      tree.value[n] = value.slice(0, -1)
  }
  return j - i + (closed ? 1 : 0)
}

function parseHtmlBlock(
  context: BlockContext,
  input: Line[],
  i: number,
  parent: number,
  html: NonNullable<ReturnType<typeof htmlBlock>>,
  boundary?: Line,
): number {
  const source = context.source
  const line = input[i]
  let j = i
  let closed = false
  for (; j < input.length; j++) {
    // HTML takes no lazy lines; parseBlocks hands them back to the container.
    if (j > i && (line.lazy || input[j].lazy)) break
    if (!html.until && blank(source, input[j])) break
    if (html.until) {
      const value = source.slice(input[j].start, input[j].end)
      if (typeof html.until === 'string' ? value.includes(html.until) : html.until.test(value)) {
        closed = true
        j++
        break
      }
    }
  }
  const last = input[j - 1]
  const nextContainer = boundary && startsContainer(context, boundary)
  // Unterminated root/container HTML retains its final line ending.
  const unclosed =
    html.until &&
    !closed &&
    (tree.kind[parent] === Kind.Root || nextContainer || last.next === source.length) &&
    j === input.length
  const n = node(Kind.Html, line.start, unclosed ? last.next : last.end, parent)
  const content = input.slice(i, j)
  tree.value[n] = viewFor(source, content, false).source
  if (unclosed) tree.value[n] += source.slice(last.end, last.next)
  return j - i
}

function parseFootnoteDefinition(
  context: BlockContext,
  input: Line[],
  i: number,
  parent: number,
  footnote: NonNullable<ReturnType<typeof footnoteLabel>>,
  start: number,
  residual: InterruptState,
  nested: boolean,
  boundary?: Line,
): number {
  const source = context.source
  const line = input[i]
  const raw = footnote.raw
  const identifier = normalizeIdentifier(raw)
  let first = footnote.end
  while (space(source.charCodeAt(first))) first++
  const content: Line[] = [{ start: first, end: line.end, next: line.next }]
  let j = i + 1
  let last = i
  let open = lazyState(context, content[0], residual > 0)
  let listed = lazyListed
  let opener = content[0]
  let table = false
  let rejected: Line | undefined
  for (; j < input.length; j++) {
    const scan = indentation(source, input[j])
    const indent = scan.indent
    if (scan.start === input[j].end) {
      content.push(input[j])
      if (open !== InterruptState.IndentedCode) open = InterruptState.None
      table = false
    } else if (
      !input[j].lazy &&
      (indent >= FOOTNOTE_INDENT ||
        // Quirk: micromark checks the indent token before the line, so a footnote directly
        // in a footnote takes the outer indent as its own when it has none left.
        (nested && indent === 0))
    ) {
      const stripped =
        indent >= FOOTNOTE_INDENT ? stripIndent(source, input[j], FOOTNOTE_INDENT) : input[j]
      if (table) {
        table = tableRow(context, opener, stripped)
        // micromark tried the rejected row as a body row, so it cannot open a table.
        if (!table) rejected = stripped
      } else if (
        context.config.gfm &&
        content[content.length - 1] !== rejected &&
        nestedTable(context, opener, content[content.length - 1], stripped)
      )
        table = true
      if (!table) opener = paragraphOpener(context, opener, stripped, open === InterruptState.Paragraph)
      content.push(stripped)
      last = j
      open = table ? InterruptState.None : lazyState(context, stripped, open === InterruptState.Paragraph, open, listed)
      listed ||= lazyListed
    } else if (
      open === InterruptState.Paragraph &&
      ((!interrupts(context, input[j]) && !marker(source, input[j])) ||
        lazyFlowSpan(context, input[j]))
    ) {
      // A lazy line is not continued, so any list marker may open a list there.
      const take = lazyLine(context, input[j])
      if (take === LazyLine.Stop) break
      content.push({ ...input[j], lazy: true })
      last = j
      if (take === LazyLine.TakeLast) {
        j++
        break
      }
    } else break
  }
  let end = input[last].end
  if (j > last + 1 && quotePrefix(source, input[j - 1])) end = input[j - 1].end
  if (closesQuotedContainer(context, input, j, boundary)) end = (input[j] ?? boundary!).start
  const n = node(Kind.FootnoteDefinition, start, end, parent)
  tree.extra[n] = { identifier, label: decode(raw) }
  context.footnotes.add(identifier)
  const outerLines = footnoteLines
  footnoteLines ??= content
  // Containers opened on the label line can interrupt only what the label line could.
  const stop = parseBlocks(context, content, n, false, residual, input[j] ?? boundary)
  footnoteLines = outerLines
  if (stop < content.length) {
    j = i + stop
    tree.end[n] = input[j - 1].end
  }
  if (tableStart(context, input, j) && endsWithTable(n, input[j - 1].end)) afterTable = input[j]
  if (tree.last[n]) tree.end[n] = Math.max(tree.end[n], tree.end[tree.last[n]])
  return j - i
}

// prepareList only skips blank line endings inside nested lists and quotes, so blank lines
// inside flow JSX or footnote definitions also make the enclosing item spread.
function hasNestedBlankLine(source: string, content: Line[], parent: number): boolean {
  for (let n = tree.child[parent]; n; n = tree.next[n]) {
    let previousEnd: number
    let end: number
    if (tree.kind[n] === Kind.Mdx && tree.extra[n]?.type === 'mdxJsxFlowElement') {
      previousEnd = tree.a[n]
      end = tree.b[n]
    } else if (tree.kind[n] === Kind.FootnoteDefinition) {
      // An empty label line ends in a blank line ending when the definition continues.
      const first = tree.child[n] ? tree.start[tree.child[n]] : tree.end[n]
      for (let k = tree.start[n]; k < first; k++)
        if (source.charCodeAt(k) === 10 || source.charCodeAt(k) === 13) return true
      previousEnd = tree.start[n]
      end = tree.end[n]
    } else continue
    for (let c = tree.child[n]; c; c = tree.next[c]) {
      for (const line of content)
        if (line.start >= previousEnd && line.end <= tree.start[c] && blank(source, line))
          return true
      previousEnd = tree.end[c]
    }
    // A trailing blank line counts only if the container ends after its line ending (a final
    // line at EOF has none).
    for (const line of content)
      if (
        line.start >= previousEnd &&
        (tree.kind[n] === Kind.FootnoteDefinition
          ? line.end < line.next && line.next <= end
          : line.end <= end) &&
        blank(source, line)
      )
        return true
    if (hasNestedBlankLine(source, content, n)) return true
  }
  return false
}

// Keep collection locals off the recursive parseBlocks frame to preserve deep quote capacity.
function quoteLines(
  context: BlockContext,
  input: Line[],
  i: number,
  residual: InterruptState,
  content: Line[],
): number {
  const source = context.source
  let j = i
  let open = InterruptState.None
  let listed = false
  let table = false
  let rejected: Line | undefined
  let opener: Line | undefined
  for (; j < input.length; j++) {
    const current = input[j]
    const stripped = quote(source, current)
    if (stripped >= 0) {
      const item = {
        start: stripped,
        end: current.end,
        next: current.next,
        padding: quotePadding(source, stripped),
        lazy: current.lazy,
      }
      if (table && opener) {
        table = tableRow(context, opener, item)
        // micromark tried the rejected row as a body row, so it cannot open a table.
        if (!table) rejected = item
      } else if (
        context.config.gfm &&
        opener &&
        content[content.length - 1] !== rejected &&
        nestedTable(context, opener, content[content.length - 1], item)
      )
        table = true
      if (!table) opener = paragraphOpener(context, opener ?? item, item, open === InterruptState.Paragraph)
      content.push(item)
      // Tables cannot receive ordinary lazy paragraph continuation.
      // Open paragraphs, indented code and the first line's inherited state reject markers that
      // cannot interrupt, so the marker line stays paragraph text.
      const interrupted = open === InterruptState.Paragraph || (j === i && residual > 0)
      open = table ? InterruptState.None : lazyState(context, item, interrupted, open, listed)
      listed ||= lazyListed
    } else if (
      open === InterruptState.Paragraph &&
      ((!interrupts(context, current) && !marker(source, current)) ||
        lazyFlowSpan(context, current))
    ) {
      const take = lazyLine(context, current)
      if (take === LazyLine.Stop) break
      content.push({ ...current, lazy: true })
      if (take === LazyLine.TakeLast) {
        j++
        break
      }
    } else break
  }
  return j
}

function extendBlankContainer(source: string, input: Line[], i: number, parent: number): void {
  const line = input[i]
  const previous = tree.last[parent]
  // Quirk: EOF after a quote prefix does not emit a blank line-ending token.
  if (
    !previous ||
    !quotePrefix(source, line) ||
    !((tree.kind[previous] === Kind.Blockquote &&
      line.next === source.length &&
      line.end === line.next &&
      i > 0 &&
      !blank(source, input[i - 1])) ||
      tree.kind[previous] === Kind.List ||
      tree.kind[previous] === Kind.FootnoteDefinition)
  )
    return
  const item = tree.kind[previous] === Kind.List ? tree.last[previous] : 0
  if (item && footnoteIndented(source, line)) {
    const child = tree.last[item]
    if (
      i > 0 &&
      blank(source, input[i - 1]) &&
      (child ? tree.end[child] : tree.start[item]) < input[i - 1].end
    )
      tree.a[item] = 1
    tree.end[item] = line.end
  } else if (
    item &&
    i > 0 &&
    blank(source, input[i - 1]) &&
    tree.end[item] < input[i - 1].end
  )
    tree.extra[previous] = true
  tree.end[previous] = line.end
}

export function parseBlocks(
  context: BlockContext,
  input: Line[],
  parent: number,
  document = false,
  inheritedInterrupt = InterruptState.None,
  boundary?: Line,
): number {
  mdxMode = !!context.config.mdx
  mathMode = !!context.config.math
  const owner = parent
  const source = context.source
  let i = document ? frontmatter(context, input, parent) : 0
  // Residual state controls list interruption and indented-code eligibility.
  // Definitions survive adjacent lines; only indented code retains its state across blanks.
  // A new container's first line may be interrupted, but no definition precedes it there.
  let residual: InterruptState =
    inheritedInterrupt === InterruptState.Definition ? InterruptState.Paragraph : inheritedInterrupt
  let pendingLazy = false
  // Lines an MDX flow tag or expression attempt still spans cannot start containers.
  let spanEnd = 0
  while (i < input.length) {
    // ── Route flow parents, handle blank lines, then allow extension flow syntax ──
    parent = context.flowParent?.(owner) ?? owner
    const line = input[i]
    if (blank(source, line)) {
      extendBlankContainer(source, input, i, parent)
      if (residual !== InterruptState.IndentedCode) residual = InterruptState.None
      i++
      continue
    }
    const scan = indentation(source, line)
    if (context.flow) {
      const count = context.flow(context, input, i, owner, boundary)
      if (count) {
        residual = InterruptState.None
        i += count
        if (input[i]?.lazy) return i
        continue
      }
    }
    // ── ATX headings precede fenced code and thematic breaks ──
    const heading = atx(source, line)
    if (heading) {
      const n = node(Kind.Heading, heading.start, line.end, parent)
      tree.a[n] = heading.depth
      queue(context, n, [{ start: heading.content, end: heading.end, next: heading.end }])
      residual = InterruptState.None
      i++
      continue
    }
    // ── Fenced code consumes its own closing marker or container boundary ──
    const opening = fence(source, line)
    if (opening) {
      i += parseFencedCode(context, input, i, parent, opening, boundary)
      // A lazy line closes every container up to the one that accepted it.
      if (input[i]?.lazy) return i
      residual = InterruptState.None
      continue
    }
    // ── Thematic breaks precede lists that use the same marker ──
    if (!line.lazy && thematic(source, line)) {
      node(Kind.ThematicBreak, scan.start, line.end, parent)
      residual = InterruptState.None
      i++
      continue
    }
    // ── Blockquotes collect prefixed lines and permitted lazy continuation ──
    const spanned = line.start < spanEnd
    const q = spanned ? -1 : quote(source, line)
    if (q >= 0) {
      const previous = tree.last[parent]
      if (previous && tree.kind[previous] === Kind.List && quotePrefix(source, line)) {
        const lastItem = tree.last[previous]
        if (
          i > 0 &&
          blank(source, input[i - 1]) &&
          tree.child[lastItem] &&
          tree.end[lastItem] <= input[i - 1].start
        )
          tree.extra[previous] = true
        tree.end[previous] = line.start
      }
      const content: Line[] = []
      let j = quoteLines(context, input, i, residual, content)
      const n = node(Kind.Blockquote, scan.start, input[j - 1].end, parent)
      quoteDepth++
      const stop = parseBlocks(context, content, n, false, residual, input[j] ?? boundary)
      quoteDepth--
      if (stop < content.length) {
        j = i + stop
        tree.end[n] = input[j - 1].end
      }
      if (tableStart(context, input, j) && endsWithTable(n, input[j - 1].end)) afterTable = input[j]
      // A lazy line closes every container up to the one that accepted it.
      if (input[j]?.lazy) return j
      // Quirk: a line opening a new container after a quote prefix or footnote indent closes
      // the quote at that prefix.
      if (
        j < input.length &&
        (quotePrefix(source, input[j]) || footnoteIndented(source, input[j])) &&
        startsContainer(context, input[j])
      )
        tree.end[n] = input[j].start
      if (tree.last[n]) tree.end[n] = Math.max(tree.end[n], tree.end[tree.last[n]])
      pendingLazy = j < input.length && !blank(source, input[j])
      residual = InterruptState.None
      i = j
      continue
    }
    // ── Footnotes are containers, so they precede tables and definition continuation ──
    const footnote = context.config.gfm && !spanned && footnoteLabel(source, line)
    if (footnote) {
      i += parseFootnoteDefinition(
        context,
        input,
        i,
        parent,
        footnote,
        scan.start,
        residual,
        // The container, not an open MDX flow tag routed through `flowParent`.
        tree.kind[owner] === Kind.FootnoteDefinition,
        boundary,
      )
      if (input[i]?.lazy) return i
      // The next line is not continued, so nothing it starts interrupts.
      residual = InterruptState.None
      continue
    }
    // ── GFM tables precede list and paragraph recognition ──
    // Definitions are paragraph content, so a head row after one interrupts it the same way.
    const tableCount = parseTable(
      context,
      input,
      i,
      parent,
      residual === InterruptState.Paragraph || residual === InterruptState.Definition,
    )
    if (tableCount) {
      i += tableCount
      residual = InterruptState.None
      continue
    }
    // ── Reject list starts that cannot interrupt retained paragraph-like content ──
    let m = line.lazy || spanned ? undefined : marker(source, line)
    if (
      m &&
      residual &&
      (blank(source, { start: m.content, end: line.end, next: line.next }) ||
        (m.ordered &&
          !(
            source.charCodeAt(m.start) === 49 &&
            (source.charCodeAt(m.start + 1) === 46 || source.charCodeAt(m.start + 1) === 41)
          )))
    )
      m = undefined
    // ── Collect list items, then derive task state, spread and final positions ──
    if (m) {
      const list = node(Kind.List, m.start, line.end, parent)
      tree.a[list] = m.ordered ? 1 : 0
      tree.b[list] = m.number
      let j = i
      let spread = false
      while (j < input.length) {
        const mark = marker(source, input[j])
        if (
          !mark ||
          mark.ordered !== m.ordered ||
          mark.char !== m.char ||
          thematic(source, input[j])
        )
          break
        const itemStart = j
        const content: Line[] = [
          {
            start: mark.content,
            end: input[j].end,
            next: input[j].next,
            padding: mark.padding,
          },
        ]
        j++
        let open = lazyState(context, content[0], residual > 0)
        let listed = lazyListed
        let opener = content[0]
        let sawBlank = false
        let lastContent = itemStart
        let itemSpread = false
        let table = false
        let rejected: Line | undefined
        for (; j < input.length; j++) {
          const current = input[j]
          if (blank(source, current)) {
            if (lastContent === itemStart && blank(source, content[0])) {
              let next = j + 1
              while (next < input.length && blank(source, input[next])) next++
              const nextMark = next < input.length ? marker(source, input[next]) : undefined
              if (nextMark && nextMark.char === m.char && nextMark.ordered === m.ordered) {
                if (!footnoteIndented(source, input[next])) spread = true
                j = next
              } else if (closesQuotedContainer(context, input, next, boundary)) j = next
              break
            }
            content.push(stripIndent(source, current, mark.indent))
            sawBlank = true
            if (open !== InterruptState.IndentedCode) open = InterruptState.None
            table = false
            continue
          }
          const scan = indentation(source, current)
          if (scan.indent < mark.indent && marker(source, current) && !current.lazy) break
          // A lazy line skipped this item's continuation, so its indent stays content.
          if (!current.lazy && scan.indent >= mark.indent) {
            const stripped = stripIndent(source, current, mark.indent)
            if (table) {
              table = tableRow(context, opener, stripped)
              // micromark tried the rejected row as a body row, so it cannot open a table.
              if (!table) rejected = stripped
            } else if (
              context.config.gfm &&
              content[content.length - 1] !== rejected &&
              nestedTable(context, opener, content[content.length - 1], stripped)
            )
              table = true
            if (!table) opener = paragraphOpener(context, opener, stripped, open === InterruptState.Paragraph)
            content.push(stripped)
            lastContent = j
            const interrupted = open === InterruptState.Paragraph || residual > 0
            open = table
              ? InterruptState.None
              : lazyState(context, stripped, interrupted, open, listed)
            listed ||= lazyListed
            sawBlank = false
          } else if (
            open === InterruptState.Paragraph &&
            (current.lazy || !interrupts(context, current) || lazyFlowSpan(context, current))
          ) {
            const take = lazyLine(context, current)
            if (take === LazyLine.Stop) break
            content.push({ ...current, lazy: true })
            lastContent = j
            if (take === LazyLine.TakeLast) {
              j++
              break
            }
          } else break
        }
        const item = node(Kind.ListItem, mark.start, input[lastContent].end, list)
        tree.a[item] = itemSpread ? 1 : 0
        const taskStart = taskCount
        const after = j < input.length ? marker(source, input[j]) : undefined
        const outerSibling = siblingLine
        if (
          after &&
          after.ordered === m.ordered &&
          after.char === m.char &&
          !thematic(source, input[j])
        )
          siblingLine = input[j]
        const stop = parseBlocks(context, content, item, false, residual, input[j] ?? boundary)
        siblingLine = outerSibling
        if (stop < content.length) {
          j = itemStart + stop
          lastContent = j - 1
          tree.end[item] = input[lastContent].end
        }
        if (tableStart(context, input, j) && endsWithTable(item, input[j - 1].end))
          afterTable = input[j]
        // Only the first item can interrupt a paragraph; later items never inherit it.
        residual = InterruptState.None
        const nextMark = j < input.length ? marker(source, input[j]) : undefined
        const sibling =
          nextMark &&
          nextMark.ordered === m.ordered &&
          nextMark.char === m.char &&
          !thematic(source, input[j])
        // Skip the checkbox now; deferred inline cleanup removes one separator later.
        if (context.config.gfm) {
          let first = tree.child[item]
          while (first && tree.kind[first] === Kind.Definition) first = tree.next[first]
          if (first && tree.kind[first] === Kind.Paragraph) {
            for (let t = taskStart; t < taskCount; t++) {
              if (taskParents[t] !== first) continue
              const value = taskViews[t]!.source
              const check = value.charCodeAt(1)
              const close = check === 13 && value.charCodeAt(2) === 10 ? 3 : 2
              let after = close + 1
              while (space(value.charCodeAt(after))) after++
              if (
                value.charCodeAt(0) === 91 &&
                (space(check) ||
                  check === 10 ||
                  check === 13 ||
                  check === 120 ||
                  check === 88) &&
                value.charCodeAt(close) === 93 &&
                after < value.length &&
                (space(value.charCodeAt(close + 1)) ||
                  value.charCodeAt(close + 1) === 10 ||
                  value.charCodeAt(close + 1) === 13) &&
                inFirstContent(source, content, mark.content, tree.start[first])
              ) {
                tree.b[item] =
                  check === Char.LowerX || check === Char.UpperX
                    ? TaskState.Checked
                    : TaskState.Unchecked
                taskStarts[t] = close + 1
                tree.a[first] = TASK_CLEANUP_PENDING
              }
              break
            }
          }
        }
        // Spread comes from blank lines between blocks, including JSX flow children.
        for (
          let child = tree.child[item];
          child && tree.next[child];
          child = tree.next[child]
        ) {
          const next = tree.next[child]
          for (let k = itemStart; k < lastContent; k++)
            if (
              input[k].end > tree.end[child] &&
              input[k].next <= tree.start[next] &&
              blank(source, input[k])
            )
              itemSpread = true
        }
        if (
          (context.config.mdx || context.config.gfm) &&
          hasNestedBlankLine(source, content, item)
        )
          itemSpread = true
        tree.a[item] = itemSpread ? 1 : 0
        if (tree.last[item])
          tree.end[item] = Math.max(tree.end[item], tree.end[tree.last[item]])
        if (
          sibling &&
          tree.last[item] &&
          (tree.end[tree.last[item]] === input[j].start ||
            tree.end[tree.last[item]] === input[j - 1].next)
        )
          tree.end[item] = nextMark.content
        if (
          closeFootnoteItem(
            context,
            input,
            j,
            lastContent,
            item,
            list,
            sibling ? nextMark : undefined,
            boundary,
          )
        ) {
          if (!sibling) break
          continue
        }
        if (sibling && sawBlank && tree.end[item] <= input[lastContent].end) spread = true
        tree.end[list] = tree.end[item]
        if (!sibling && j > lastContent + 1 && quotePrefix(source, input[j - 1]))
          tree.end[list] = input[j - 1].end
        // prepareList counts trailing quoted blank endings only outside nested containers.
        if (
          !sibling &&
          j > lastContent + 2 &&
          quotePrefix(source, input[j - 1]) &&
          tree.end[item] <= input[lastContent].end
        )
          spread = true
        // A quoted container start closes the list after that line's prefix, so every trailing
        // blank line ending stays inside the list (only the innermost list counts them).
        if (!sibling && closesQuotedContainer(context, input, j, boundary)) {
          tree.end[list] = (input[j] ?? boundary!).start
          if (j > lastContent + 1 && tree.end[item] <= input[lastContent].end) spread = true
          // A last child that kept its line ending (unclosed code) leaves no trailing ending
          // to end the item at, so the item ends with the list.
          else if (tree.end[item] > input[lastContent].end) tree.end[item] = tree.end[list]
        }
        if (!sibling) break
      }
      tree.extra[list] = spread
      if (input[j]?.lazy) return j
      let after = j
      while (after < input.length && blank(source, input[after])) after++
      pendingLazy =
        after < input.length && indentation(source, input[after]).indent >= CODE_INDENT
      residual = InterruptState.None
      i = j
      continue
    }
    // ── Adjacent definitions can continue without ordinary indentation limits ──
    const previous = tree.last[parent]
    if (
      previous &&
      tree.kind[previous] === Kind.Definition &&
      i > 0 &&
      !blank(source, input[i - 1])
    ) {
      const count = parseDefinition(context, input, i, parent, true)
      if (count) {
        residual = InterruptState.Definition
        i += count
        continue
      }
    }
    // ── Indented code is disabled in MDX and after an adjacent definition ──
    if (
      !context.config.mdx &&
      scan.indent >= CODE_INDENT &&
      residual !== InterruptState.Definition
    ) {
      const content: Line[] = []
      let j = i
      let last = i
      for (; j < input.length; j++) {
        if (pendingLazy && j > i) break
        const current = input[j]
        if (blank(source, current)) content.push(stripIndent(source, current, CODE_INDENT))
        else if (indentation(source, current).indent >= CODE_INDENT) {
          content.push(stripIndent(source, current, CODE_INDENT))
          last = j
        } else break
      }
      // Micromark commits blank lines with a full code indent, even with no value.
      let committed = last
      for (let k = last + 1; k < j; k++)
        if (indentation(source, input[k]).indent >= CODE_INDENT) committed = k
      content.length = committed - i + 1
      const n = node(Kind.Code, line.start, input[committed].end, parent)
      tree.value[n] = viewFor(source, content, false).source
      if (blank(source, content[content.length - 1])) {
        const value = tree.value[n]!
        if (value.charCodeAt(value.length - 1) === 10)
          tree.value[n] = value.slice(0, value.charCodeAt(value.length - 2) === 13 ? -2 : -1)
        else if (value.charCodeAt(value.length - 1) === 13) tree.value[n] = value.slice(0, -1)
      }
      residual = pendingLazy ? InterruptState.None : InterruptState.IndentedCode
      pendingLazy = false
      i = j
      continue
    }
    // ── HTML blocks end at their terminator, blank line or lazy boundary ──
    // Definitions are paragraph content, so HTML that cannot interrupt one stays text,
    // except on a lazy line, which ends the definitions' container, or a table head row.
    const html =
      !context.config.mdx &&
      htmlBlock(
        source,
        line,
        residual === InterruptState.Definition && !line.lazy && !tableStart(context, input, i, true),
      )
    if (html) {
      i += parseHtmlBlock(context, input, i, parent, html, boundary)
      if (input[i]?.lazy) return i
      residual = InterruptState.None
      continue
    }
    // ── Ordinary reference definitions precede paragraph fallback ──
    const definition = parseDefinition(context, input, i, parent)
    if (definition) {
      residual = InterruptState.Definition
      i += definition
      continue
    }
    // ── Gather paragraph lines, or promote them to a setext heading ──
    const content: Line[] = [line]
    if (context.continuationEnd)
      spanEnd = Math.max(spanEnd, context.continuationEnd(line, context, input, i, boundary))
    let j = i + 1
    let depth = 0
    for (; j < input.length; j++) {
      depth = input[j].lazy ? 0 : setext(source, input[j])
      if (depth) break
      // A flow tag or expression decided in the container view overrides raw source probes.
      const flow = context.continuation?.(context, input, j, boundary)
      if (flow) break
      if (input[j].start < spanEnd) {
        if (flow === undefined && flowInterrupts(context, input[j])) break
      } else {
        if (flow === undefined && !input[j].lazy && interrupts(context, input[j])) break
        if (input[j].lazy && !context.config.mdx && htmlBlock(source, input[j], false)) break
        if (flow === undefined && input[j].lazy && lazyFlowSpan(context, input[j])) break
        if (context.continuationEnd)
          spanEnd = context.continuationEnd(input[j], context, input, j, boundary)
      }
      if (tableStart(context, input, j, true)) break
      content.push(input[j])
    }
    let start = scan.start
    // A setext heading can include preceding adjacent definitions in its position.
    if (depth && !setext(source, line)) {
      let previous = tree.last[parent]
      let k = i - 1
      while (
        previous &&
        tree.kind[previous] === Kind.Definition &&
        k >= 0 &&
        !blank(source, input[k])
      ) {
        start = tree.start[previous]
        previous = tree.prev[previous]
        k--
      }
    }
    const n = node(
      depth ? Kind.Heading : Kind.Paragraph,
      start,
      depth ? input[j].end : input[j - 1].end,
      parent,
    )
    tree.a[n] = depth
    queue(context, n, content)
    residual = depth ? InterruptState.None : InterruptState.Paragraph
    i = j + (depth ? 1 : 0)
    // A setext underline closes the paragraph, so no lazy line can follow it.
    if (depth && input[i]?.lazy) return i
  }
  return input.length
}

export function runInlineTasks(context: BlockContext): void {
  for (let i = 0; i < taskCount; i++) {
    const view = taskViews[i]!
    const parent = taskParents[i]
    parseInline(view, taskStarts[i], view.source.length, parent, context)
    taskViews[i] = undefined
    // Task prefixes leave one separator for parsing, then remove it and repair positions.
    if (tree.kind[parent] === Kind.Paragraph && tree.a[parent] === TASK_CLEANUP_PENDING) {
      const first = tree.child[parent]
      if (first && tree.kind[first] === Kind.Text) {
        tree.value[first] = tree.value[first]!.slice(1)
        if (!tree.value[first]) {
          tree.child[parent] = tree.next[first]
          if (tree.next[first]) tree.prev[tree.next[first]] = 0
          else tree.last[parent] = 0
        } else {
          if (context.config.positions) {
            const start = point(tree.start[first])
            const positionStart = {
              line: start.line,
              column: start.column + 1,
              offset: start.offset + 1,
            }
            tree.extra[first] = tree.extra[parent] = { positionStart }
          }
          tree.start[first]++
          tree.start[parent] = tree.start[first]
        }
      }
    }
  }
}

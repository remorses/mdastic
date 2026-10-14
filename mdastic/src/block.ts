import type { Config } from './syntax.ts'
import type { AlignType } from './types.ts'
import {
  alpha,
  decode,
  digit,
  isPunctuation,
  lineCount,
  lineStarts,
  normalizeIdentifier,
  point,
  space,
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
import { Kind, node, tree } from './tree.ts'

export interface Line {
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
  continuationEnd?: (line: Line) => number
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
let mdxMode = false

let taskCount = 0
let taskParents = new Int32Array(1024)
let taskStarts = new Int32Array(1024)
const taskViews: (View | undefined)[] = []

export function resetBlocks(): void {
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

export function lines(source: string): Line[] {
  const result: Line[] = []
  for (let i = 0; i < lineCount; i++) {
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
function blank(source: string, line: Line): boolean {
  return indentation(source, line).start === line.end
}
function trimEnd(source: string, start: number, end: number): number {
  while (end > start && space(source.charCodeAt(end - 1))) end--
  return end
}

function stripIndent(source: string, line: Line, amount: number): Line {
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

function tabWidth(source: string, at: number): number {
  let start = at
  while (start && source.charCodeAt(start - 1) !== 10 && source.charCodeAt(start - 1) !== 13)
    start--
  let column = 0
  for (let i = start; i < at; i++) column += source.charCodeAt(i) === 9 ? 4 - (column % 4) : 1
  return 4 - (column % 4)
}

function thematic(source: string, line: Line, mdx = mdxMode): boolean {
  const scan = indentation(source, line)
  if (!mdx && scan.indent > 3) return false
  const c = source.charCodeAt(scan.start)
  if (c !== 42 && c !== 45 && c !== 95) return false
  let count = 0
  for (let i = scan.start; i < line.end; i++) {
    const d = source.charCodeAt(i)
    if (d === c) count++
    else if (!space(d)) return false
  }
  return count >= 3
}

function atx(
  source: string,
  line: Line,
  mdx = mdxMode,
): { start: number; content: number; end: number; depth: number } | undefined {
  const scan = indentation(source, line)
  if ((!mdx && scan.indent > 3) || source.charCodeAt(scan.start) !== 35) return
  let i = scan.start
  while (source.charCodeAt(i) === 35) i++
  const depth = i - scan.start
  if (depth > 6 || (i < line.end && !space(source.charCodeAt(i)))) return
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
  if (!mdx && scan.indent > 3) return 0
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
): { start: number; content: number; char: number; length: number; indent: number } | undefined {
  const scan = indentation(source, line)
  if (!mdx && scan.indent > 3) return
  const c = source.charCodeAt(scan.start)
  if (c !== 96 && c !== 126) return
  let i = scan.start
  while (source.charCodeAt(i) === c) i++
  if (i - scan.start < 3) return
  if (c === 96) for (let j = i; j < line.end; j++) if (source.charCodeAt(j) === 96) return
  return { start: scan.start, content: i, char: c, length: i - scan.start, indent: scan.indent }
}

function marker(source: string, line: Line, mdx = mdxMode): Marker | undefined {
  const scan = indentation(source, line)
  if (!mdx && scan.indent > 3) return
  let i = scan.start
  const c = source.charCodeAt(i)
  let number = 0
  let ordered = false
  if (digit(c)) {
    ordered = true
    while (digit(source.charCodeAt(i)) && i - scan.start < 9)
      number = number * 10 + source.charCodeAt(i++) - 48
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
  if (padding > 4 || i === line.end) {
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

function quote(source: string, line: Line, mdx = mdxMode): number {
  const scan = indentation(source, line)
  if ((!mdx && scan.indent > 3) || source.charCodeAt(scan.start) !== 62) return -1
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
function htmlBlock(
  source: string,
  line: Line,
  interrupt: boolean,
): { start: number; until: string | null; tag?: string } | undefined {
  const scan = indentation(source, line)
  const start = scan.start
  if (scan.indent > 3 || source.charCodeAt(start) !== 60) return
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
      return { start, until: '</' + tag + '>', tag }
    if (htmlBlocks.has(tag)) return { start, until: null }
  }
  if (!interrupt) {
    const stop = htmlEnd(source, start, line.end, true)
    if (stop > 0 && trimEnd(source, stop, line.end) === stop) return { start, until: null }
  }
}

function interrupts(context: BlockContext, line: Line): boolean {
  const source = context.source
  if (context.interrupt?.(line)) return true
  if (
    blank(source, line) ||
    thematic(source, line) ||
    atx(source, line) ||
    fence(source, line) ||
    quote(source, line) >= 0
  )
    return true
  if (!context.config.mdx && htmlBlock(source, line, true)) return true
  if (context.config.gfm && footnoteLabel(source, line)) return true
  const m = marker(source, line)
  return (
    !!m &&
    (!m.ordered ||
      (source.charCodeAt(m.start) === 49 &&
        (source.charCodeAt(m.start + 1) === 46 || source.charCodeAt(m.start + 1) === 41))) &&
    m.content < line.end
  )
}

function footnoteLabel(source: string, line: Line): { end: number; raw: string } | undefined {
  const scan = indentation(source, line)
  if (scan.indent > 3 || !source.startsWith('[^', scan.start)) return
  let i = scan.start + 2
  for (; i < line.end; i++) {
    const c = source.charCodeAt(i)
    if (space(c) || c === 91) return
    if (c === 93) break
    if (c === 92 && source.charCodeAt(i + 1) < 128 && isPunctuation(source.charCodeAt(i + 1))) i++
  }
  if (
    i === scan.start + 2 ||
    i - scan.start > 1001 ||
    source.charCodeAt(i) !== 93 ||
    source.charCodeAt(i + 1) !== 58
  )
    return
  return { end: i + 2, raw: source.slice(scan.start + 2, i) }
}

function lazyParagraph(context: BlockContext, line: Line, interrupted = false): boolean {
  const source = context.source
  let current = line
  for (let depth = 0; depth < 100; depth++) {
    if (
      blank(source, current) ||
      (!context.config.mdx && indentation(source, current).indent >= 4) ||
      thematic(source, current) ||
      atx(source, current) ||
      fence(source, current) ||
      context.interrupt?.(current)
    )
      return false
    if (!context.config.mdx && htmlBlock(source, current, false)) return false
    const q = quote(source, current)
    const m = q < 0 ? marker(source, current) : undefined
    if (
      m &&
      interrupted &&
      (blank(source, { start: m.content, end: line.end, next: line.next }) ||
        (m.ordered &&
          !(
            source.charCodeAt(m.start) === 49 &&
            (source.charCodeAt(m.start + 1) === 46 || source.charCodeAt(m.start + 1) === 41)
          )))
    )
      return true
    const start = q >= 0 ? q : m?.content
    if (start === undefined) return true
    current = { start, end: line.end, next: line.next }
  }
  return false
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
  const original = context.source
  const line = input[at]
  const scan = indentation(original, line)
  if ((!continued && scan.indent > 3) || original.charCodeAt(scan.start) !== 91) return 0
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
  let limit = at + 1
  while (
    limit < input.length &&
    !blank(original, input[limit]) &&
    !interrupts(context, input[limit]) &&
    !setext(original, input[limit])
  ) {
    if (tableStart(context, input, limit - 1)) return 0
    limit++
  }
  const view = viewFor(original, input.slice(at, limit), false)
  const source = view.source
  let i = scan.start - line.start + 1
  const labelStart = i
  while (
    i < source.length &&
    i - labelStart <= 999 &&
    source.charCodeAt(i) !== 93 &&
    source.charCodeAt(i) !== 91
  ) {
    if (source.charCodeAt(i) === 92) i++
    i++
  }
  if (
    i - labelStart > 999 ||
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
  }
  if (i > destEnd) {
    const t = title(source, i, source.length)
    if (t) {
      let stop = t.end
      while (space(source.charCodeAt(stop))) stop++
      if (
        stop === source.length ||
        source.charCodeAt(stop) === 10 ||
        source.charCodeAt(stop) === 13
      ) {
        label = t.value || null
        end = stop
      } else if (!newline) return 0
    } else if (!newline && i < source.length) return 0
  } else if (i < source.length) return 0
  const absoluteEnd = offset(view, end)
  let consumed = 1
  while (at + consumed < input.length && input[at + consumed - 1].end < absoluteEnd) consumed++
  if (consumed > limit - at) return 0
  const data: DefinitionData = { identifier, label: decode(raw), url: dest.value, title: label }
  const n = node(Kind.Definition, scan.start, absoluteEnd, parent)
  tree.extra[n] = data
  if (!context.definitions.has(identifier)) context.definitions.set(identifier, data)
  return consumed
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
  if (!mdxMode && scan.indent > 3) return
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

function tableStart(context: BlockContext, input: Line[], i: number): AlignType[] | undefined {
  if (!context.config.gfm || !input[i + 1] || input[i + 1].lazy) return
  const align = tableAlign(context.source, input[i + 1])
  if (!align || setext(context.source, input[i + 1]) || marker(context.source, input[i + 1])) return
  const header = tableCells(context.source, input[i])
  if (header.length !== align.length) return
  if (header.length === 1) {
    const [start, end] = header[0]
    let j = start
    while (space(context.source.charCodeAt(j))) j++
    if (header[0][0] > header[0][1]) return
  }
  return align
}

function parseTable(context: BlockContext, input: Line[], i: number, parent: number): number {
  const align = tableStart(context, input, i)
  if (!align) return 0
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
    !marker(source, input[j]) &&
    (mdxMode || indentation(source, input[j]).indent < 4) &&
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
  return 0
}

export function parseBlocks(
  context: BlockContext,
  input: Line[],
  parent: number,
  document = false,
  inheritedInterrupt = 0,
  boundary?: Line,
): void {
  mdxMode = !!context.config.mdx
  const owner = parent
  const source = context.source
  let i = document ? frontmatter(context, input, parent) : 0
  // Micromark retains interrupted content state after definitions and indented code.
  let residual = inheritedInterrupt
  let pendingLazy = false
  while (i < input.length) {
    parent = context.flowParent?.(owner) ?? owner
    const line = input[i]
    if (blank(source, line)) {
      const previous = tree.last[parent]
      if (
        previous &&
        quotePrefix(source, line) &&
        ((tree.kind[previous] === Kind.Blockquote && i + 1 === input.length) ||
          tree.kind[previous] === Kind.List ||
          tree.kind[previous] === Kind.FootnoteDefinition)
      )
        tree.end[previous] = line.end
      if (residual !== 3) residual = 0
      i++
      continue
    }
    const scan = indentation(source, line)
    if (context.flow) {
      const count = context.flow(context, input, i, owner, boundary)
      if (count) {
        residual = 0
        i += count
        continue
      }
    }
    const heading = atx(source, line)
    if (heading) {
      const n = node(Kind.Heading, heading.start, line.end, parent)
      tree.a[n] = heading.depth
      queue(context, n, [{ start: heading.content, end: heading.end, next: heading.end }])
      residual = 0
      i++
      continue
    }
    const opening = fence(source, line)
    if (opening) {
      let j = i + 1
      let closed = false
      const content: Line[] = []
      for (; j < input.length; j++) {
        const current = input[j]
        const scan = indentation(source, current)
        let k = scan.start
        while (source.charCodeAt(k) === opening.char) k++
        if (
          (mdxMode || scan.indent < 4) &&
          k - scan.start >= opening.length &&
          trimEnd(source, k, current.end) === k
        ) {
          closed = true
          break
        }
        content.push(stripIndent(source, current, opening.indent))
      }
      const last = closed ? input[j] : input[Math.max(i, j - 1)]
      const nextContainer = boundary && (quote(source, boundary) >= 0 || marker(source, boundary))
      const keepEnding =
        tree.kind[parent] === Kind.Root ||
        !!nextContainer ||
        (tree.kind[parent] === Kind.ListItem && last.next === source.length)
      const n = node(Kind.Code, opening.start, closed || !keepEnding ? last.end : last.next, parent)
      let info = opening.content
      while (space(source.charCodeAt(info))) info++
      let word = info
      while (word < line.end && !space(source.charCodeAt(word))) word++
      let meta = word
      while (space(source.charCodeAt(meta))) meta++
      tree.extra[n] = {
        lang: info === line.end ? null : decode(source.slice(info, word)),
        meta: meta === line.end ? null : decode(source.slice(meta, line.end)),
      }
      tree.value[n] = content.length ? viewFor(source, content, false).source : ''
      if (
        !closed &&
        !nextContainer &&
        tree.kind[parent] !== Kind.Root &&
        last.next < source.length &&
        content.length &&
        blank(source, last)
      ) {
        const value = tree.value[n]!
        if (value.charCodeAt(value.length - 1) === 10)
          tree.value[n] = value.slice(0, value.charCodeAt(value.length - 2) === 13 ? -2 : -1)
        else if (value.charCodeAt(value.length - 1) === 13) tree.value[n] = value.slice(0, -1)
      }
      residual = 0
      i = j + (closed ? 1 : 0)
      continue
    }
    if (!line.lazy && thematic(source, line)) {
      node(Kind.ThematicBreak, scan.start, line.end, parent)
      residual = 0
      i++
      continue
    }
    const q = quote(source, line)
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
      let j = i
      let lazy = false
      let table = false
      for (; j < input.length; j++) {
        const current = input[j]
        const stripped = quote(source, current)
        if (stripped >= 0) {
          const padding =
            source.charCodeAt(stripped - 1) === 9 ? tabWidth(source, stripped - 1) - 1 : 0
          const item = {
            start: stripped,
            end: current.end,
            next: current.next,
            padding,
            lazy: current.lazy,
          }
          if (blank(source, item) || interrupts(context, item)) table = false
          const align =
            context.config.gfm && content.length && !setext(source, item)
              ? tableAlign(source, item)
              : undefined
          if (align && tableCells(source, content[content.length - 1]).length === align.length)
            table = true
          content.push(item)
          lazy = !table && lazyParagraph(context, item)
        } else if (lazy && !interrupts(context, current)) {
          const html = !context.config.mdx && htmlBlock(source, current, false)
          if (html && current.next === current.end) break
          content.push({ ...current, lazy: true })
          if (html) {
            j++
            break
          }
        } else break
      }
      const n = node(Kind.Blockquote, scan.start, input[j - 1].end, parent)
      parseBlocks(context, content, n, false, residual, input[j] ?? boundary)
      if (tree.last[n]) tree.end[n] = Math.max(tree.end[n], tree.end[tree.last[n]])
      pendingLazy = j < input.length && !blank(source, input[j])
      residual = 0
      i = j
      continue
    }
    const tableCount = parseTable(context, input, i, parent)
    if (tableCount) {
      i += tableCount
      continue
    }
    let m = marker(source, line)
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
          { start: mark.content, end: input[j].end, next: input[j].next, padding: mark.padding },
        ]
        j++
        let lazy = lazyParagraph(context, content[0], residual > 0)
        let sawBlank = false
        let lastContent = itemStart
        let itemSpread = false
        let table = false
        for (; j < input.length; j++) {
          const current = input[j]
          if (blank(source, current)) {
            if (lastContent === itemStart && blank(source, content[0])) {
              let next = j + 1
              while (next < input.length && blank(source, input[next])) next++
              const nextMark = next < input.length ? marker(source, input[next]) : undefined
              if (nextMark && nextMark.char === m.char && nextMark.ordered === m.ordered) {
                spread = true
                j = next
              }
              break
            }
            content.push(stripIndent(source, current, mark.indent))
            sawBlank = true
            lazy = false
            continue
          }
          const scan = indentation(source, current)
          if (scan.indent < mark.indent && marker(source, current)) break
          if (scan.indent >= mark.indent) {
            const stripped = stripIndent(source, current, mark.indent)
            if (blank(source, stripped) || interrupts(context, stripped)) table = false
            if (
              context.config.gfm &&
              content.length &&
              tableStart(context, [content[content.length - 1], stripped], 0)
            )
              table = true
            content.push(stripped)
            lastContent = j
            lazy = !table && lazyParagraph(context, stripped, lazy || residual > 0)
            sawBlank = false
          } else if (lazy && !interrupts(context, current) && !setext(source, current)) {
            const html = !context.config.mdx && htmlBlock(source, current, false)
            if (html && current.next === current.end) break
            content.push({ ...current, lazy: true })
            lastContent = j
            if (html) {
              j++
              break
            }
          } else break
        }
        const nextMark = j < input.length ? marker(source, input[j]) : undefined
        const sibling =
          nextMark &&
          nextMark.ordered === m.ordered &&
          nextMark.char === m.char &&
          !thematic(source, input[j])
        const item = node(Kind.ListItem, mark.start, input[lastContent].end, list)
        tree.a[item] = itemSpread ? 1 : 0
        const taskStart = taskCount
        parseBlocks(context, content, item, false, residual, input[j] ?? boundary)
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
                (space(check) || check === 10 || check === 13 || check === 120 || check === 88) &&
                value.charCodeAt(close) === 93 &&
                after < value.length &&
                (space(value.charCodeAt(close + 1)) ||
                  value.charCodeAt(close + 1) === 10 ||
                  value.charCodeAt(close + 1) === 13)
              ) {
                tree.b[item] = check === 120 || check === 88 ? 2 : 1
                taskStarts[t] = close + 1
                tree.a[first] = 1
              }
              break
            }
          }
        }
        for (let child = tree.child[item]; child && tree.next[child]; child = tree.next[child]) {
          const next = tree.next[child]
          for (let k = itemStart; k < lastContent; k++)
            if (
              input[k].end >= tree.end[child] &&
              input[k].next <= tree.start[next] &&
              blank(source, input[k])
            )
              itemSpread = true
        }
        if (context.config.mdx) {
          function jsxSpread(parent: number): boolean {
            for (let n = tree.child[parent]; n; n = tree.next[n]) {
              if (tree.kind[n] !== Kind.Mdx || tree.extra[n]?.type !== 'mdxJsxFlowElement') continue
              let previousEnd = tree.a[n]
              for (let c = tree.child[n]; c; c = tree.next[c]) {
                for (const l of content)
                  if (l.start >= previousEnd && l.end <= tree.start[c] && blank(source, l))
                    return true
                previousEnd = tree.end[c]
              }
              for (const l of content)
                if (l.start >= previousEnd && l.end <= tree.b[n] && blank(source, l)) return true
              if (jsxSpread(n)) return true
            }
            return false
          }
          if (jsxSpread(item)) itemSpread = true
        }
        tree.a[item] = itemSpread ? 1 : 0
        if (tree.last[item]) tree.end[item] = Math.max(tree.end[item], tree.end[tree.last[item]])
        if (
          sibling &&
          tree.last[item] &&
          (tree.end[tree.last[item]] === input[j].start ||
            tree.kind[parent] === Kind.FootnoteDefinition)
        )
          tree.end[item] = nextMark.content
        if (!sibling && nextMark && tree.kind[parent] === Kind.FootnoteDefinition)
          tree.end[item] = nextMark.start
        if (sibling && sawBlank && tree.kind[parent] === Kind.FootnoteDefinition) tree.a[item] = 1
        if (sibling && sawBlank && tree.end[item] <= input[lastContent].end) spread = true
        tree.end[list] = tree.end[item]
        if (!sibling && j > lastContent + 1 && quotePrefix(source, input[j - 1]))
          tree.end[list] = input[j - 1].end
        if (!sibling) break
      }
      tree.extra[list] = spread
      let after = j
      while (after < input.length && blank(source, input[after])) after++
      pendingLazy = after < input.length && indentation(source, input[after]).indent >= 4
      residual = 0
      i = j
      continue
    }
    const previous = tree.last[parent]
    if (
      previous &&
      tree.kind[previous] === Kind.Definition &&
      i > 0 &&
      !blank(source, input[i - 1])
    ) {
      const count = parseDefinition(context, input, i, parent, true)
      if (count) {
        residual = 2
        i += count
        continue
      }
    }
    if (!context.config.mdx && scan.indent >= 4 && residual !== 2) {
      const content: Line[] = []
      let j = i
      let last = i
      for (; j < input.length; j++) {
        if (pendingLazy && j > i) break
        const current = input[j]
        if (blank(source, current)) content.push(stripIndent(source, current, 4))
        else if (indentation(source, current).indent >= 4) {
          content.push(stripIndent(source, current, 4))
          last = j
        } else break
      }
      const preserveEofIndent =
        input[j - 1].end === source.length && indentation(source, input[j - 1]).indent >= 4
      while (content.length && blank(source, content[content.length - 1]) && !preserveEofIndent)
        content.pop()
      let end = input[last].end
      if (!pendingLazy)
        for (let k = last + 1; k < j; k++)
          if (indentation(source, input[k]).indent >= 4) end = input[k].end
          else break
      if (preserveEofIndent) end = input[j - 1].end
      const n = node(Kind.Code, line.start, end, parent)
      tree.value[n] = viewFor(source, content, false).source
      if (preserveEofIndent && blank(source, content[content.length - 1])) {
        const value = tree.value[n]!
        if (value.charCodeAt(value.length - 1) === 10)
          tree.value[n] = value.slice(0, value.charCodeAt(value.length - 2) === 13 ? -2 : -1)
        else if (value.charCodeAt(value.length - 1) === 13) tree.value[n] = value.slice(0, -1)
      }
      residual = pendingLazy ? 0 : 3
      pendingLazy = false
      i = j
      continue
    }
    const html = !context.config.mdx && htmlBlock(source, line, false)
    if (html) {
      let j = i
      for (; j < input.length; j++) {
        if (line.lazy && j > i) break
        if (!html.until && blank(source, input[j])) break
        if (html.until) {
          let value = source.slice(input[j].start, input[j].end)
          if (html.tag) value = value.toLowerCase()
          if (value.includes(html.until)) {
            j++
            break
          }
        }
      }
      const last = input[j - 1]
      const nextContainer = boundary && (quote(source, boundary) >= 0 || marker(source, boundary))
      const unclosed =
        html.until &&
        (tree.kind[parent] === Kind.Root || nextContainer) &&
        j === input.length &&
        !source.slice(last.start, last.end).toLowerCase().includes(html.until)
      const n = node(Kind.Html, line.start, unclosed ? last.next : last.end, parent)
      const content = input.slice(i, j)
      tree.value[n] = viewFor(source, content, false).source
      if (unclosed) tree.value[n] += source.slice(last.end, last.next)
      residual = 0
      i = j
      continue
    }
    const footnote = context.config.gfm && footnoteLabel(source, line)
    if (footnote) {
      const raw = footnote.raw
      const identifier = normalizeIdentifier(raw)
      let first = footnote.end
      while (space(source.charCodeAt(first))) first++
      const content: Line[] = [{ start: first, end: line.end, next: line.next }]
      let j = i + 1
      let last = i
      let lazy = lazyParagraph(context, content[0])
      for (; j < input.length; j++) {
        if (blank(source, input[j])) {
          content.push(input[j])
          lazy = false
        } else if (indentation(source, input[j]).indent >= 4) {
          const stripped = stripIndent(source, input[j], 4)
          content.push(stripped)
          last = j
          lazy = lazyParagraph(context, stripped)
        } else if (lazy && !interrupts(context, input[j])) {
          content.push({ ...input[j], lazy: true })
          last = j
        } else break
      }
      let end = input[last].end
      if (j > last + 1 && quotePrefix(source, input[j - 1])) end = input[j - 1].end
      const n = node(Kind.FootnoteDefinition, scan.start, end, parent)
      tree.extra[n] = { identifier, label: decode(raw) }
      context.footnotes.add(identifier)
      parseBlocks(context, content, n, false, 0, input[j] ?? boundary)
      i = j
      continue
    }
    const definition = parseDefinition(context, input, i, parent)
    if (definition) {
      residual = 2
      i += definition
      continue
    }
    const content: Line[] = [line]
    const continuationEnd = context.continuationEnd?.(line) ?? line.end
    let j = i + 1
    let depth = 0
    for (; j < input.length; j++) {
      if (input[j].start < continuationEnd) {
        content.push(input[j])
        continue
      }
      depth = input[j].lazy ? 0 : setext(source, input[j])
      if (depth) break
      if (interrupts(context, input[j])) break
      if (input[j].lazy && !context.config.mdx && htmlBlock(source, input[j], false)) break
      if (tableStart(context, input, j)) break
      content.push(input[j])
    }
    let start = scan.start
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
    residual = depth ? 0 : 1
    i = j + (depth ? 1 : 0)
  }
}

export function runInlineTasks(context: BlockContext): void {
  for (let i = 0; i < taskCount; i++) {
    const view = taskViews[i]!
    const parent = taskParents[i]
    parseInline(view, taskStarts[i], view.source.length, parent, context)
    taskViews[i] = undefined
    if (tree.kind[parent] === Kind.Paragraph && tree.a[parent] === 1) {
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

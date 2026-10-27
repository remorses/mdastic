// Public API: parse, stringify, visit. Every node type is exported from ./types.ts.
import { documentScoped, parseDocument } from './parser.ts'
import { Char } from './scan.ts'
import { toMarkdown, type StringifyOptions } from './stringify.ts'
import { MdxParseError, resolveConfig, type Config, type Syntax } from './syntax.ts'
import type { NodeOf, NodeType, Nodes, Parents, Root, RootContent } from './types.ts'

export type * from './types.ts'
export type {
  Syntax,
  GfmSyntax,
  MdxSyntax,
  FrontmatterSyntax,
  HeadingIdSyntax,
  MathSyntax,
} from './syntax.ts'
export type { StringifyOptions } from './stringify.ts'
export { MdxParseError } from './syntax.ts'

export interface ParseOptions {
  syntax?: readonly Syntax[]
  /** Set false to skip `position` on every node. Faster, smaller trees. Default true. */
  positions?: boolean
}

/** Parse markdown into mdast. Only MDX syntax can fail; the error is returned, never thrown. */
export function parse(source: string, options: ParseOptions = {}): Root | MdxParseError {
  return parseFrom({ source, config: resolveConfig(options.syntax, options.positions ?? true) })
}

function parseFrom({ source, config, from = 0 }: { source: string; config: Config; from?: number }): Root | MdxParseError {
  try {
    return parseDocument({ source, config, from })
  } catch (error) {
    if (error instanceof MdxParseError) return error
    throw error
  }
}

export interface StreamParser {
  /** Parse all text received so far. Returns the same tree as `parse(source)`. */
  parse(source: string): Root | MdxParseError
}

/**
 * Parser for text that grows at the end, like an LLM response. Each call returns the same tree as
 * `parse(source)`, but top-level blocks closed by a blank line are not parsed again: they keep their
 * object identity, so renderers can skip them. Returned trees share those nodes; do not mutate them.
 * Link or footnote definitions and MDX imports resolve across blocks, so they force full reparses.
 */
export function createStreamParser(options: { syntax?: readonly Syntax[] } = {}): StreamParser {
  const config = resolveConfig(options.syntax, true)
  // `stable` are the top-level nodes before `from`, a line start in the BOM-stripped text.
  // `checked` is the raw text that decided the cut, through the next block's first line.
  let checked = ''
  let from = 0
  let stable: RootContent[] = []
  return {
    parse(source) {
      // Not startsWith: V8 compares sliced strings char by char there, `===` uses memcmp.
      if (source.slice(0, checked.length) !== checked) {
        checked = ''
        from = 0
        stable = []
      }
      const bom = source.charCodeAt(0) === Char.Bom ? 1 : 0
      const text = bom ? source.slice(1) : source
      const tree = parseFrom({ source, config, from })
      if (tree instanceof Error) return tree
      if (documentScoped) {
        const full = from ? parseFrom({ source, config }) : tree
        checked = ''
        from = 0
        stable = []
        return full
      }
      const tail = tree.children
      tree.children = stable.length ? stable.concat(tail) : tail
      // An opening frontmatter fence reads ahead to a closing fence that may not have arrived yet.
      const first = tail[0]?.type
      if (!from && config.frontmatter && /^(---|\+\+\+)/.test(text) && first !== 'yaml' && first !== 'toml')
        return tree
      for (let i = tail.length - 1; i > 0; i--) {
        const cut = blockCut({ source: text, previous: tail[i - 1], next: tail[i] })
        if (!cut) continue
        from = cut.start
        checked = source.slice(0, cut.end + bom)
        stable = tree.children.slice(0, stable.length + i)
        break
      }
      return tree
    },
  }
}

/**
 * Where a cut before `next` is safe, or undefined: `start` is the line start of `next`, `end` follows
 * its first line, and text up to `end` must stay unchanged. A blank line must separate them (it
 * closes paragraphs, tables and MDX flow), and the first line of `next` must be complete:
 * `1. a\n\n1` becomes one list once `.` arrives.
 */
function blockCut({ source, previous, next }: { source: string; previous: RootContent; next: RootContent }) {
  const end = previous.position?.end.offset
  const start = next.position?.start.offset
  if (end === undefined || start === undefined) return undefined
  // Quirk: interruption state flows through indented code across blank lines, like micromark.
  if (indentedCode(source, previous) || indentedCode(source, next)) return undefined
  let lineStart = start
  while (lineStart > end && !lineBreak(source.charCodeAt(lineStart - 1))) lineStart--
  if (lineStart <= end) return undefined
  let breaks = 0
  for (let i = end; i < lineStart; i++) {
    const c = source.charCodeAt(i)
    if (c === Char.LineFeed || (c === Char.CarriageReturn && source.charCodeAt(i + 1) !== Char.LineFeed)) breaks++
    else if (c !== Char.CarriageReturn && c !== Char.Space && c !== Char.Tab) return undefined
  }
  if (breaks < 2) return undefined
  for (let i = start; i < source.length; i++) if (lineBreak(source.charCodeAt(i))) return { start: lineStart, end: i + 1 }
  return undefined
}

function indentedCode(source: string, node: RootContent): boolean {
  if (node.type !== 'code') return false
  const c = source.charCodeAt(node.position?.start.offset ?? 0)
  return c !== Char.Backtick && c !== Char.Tilde
}

function lineBreak(c: number): boolean {
  return c === Char.LineFeed || c === Char.CarriageReturn
}

/** Serialize mdast to markdown. Same output as remark-stringify with the matching extensions. */
export function stringify(tree: Nodes, options: StringifyOptions & { syntax?: readonly Syntax[] } = {}): string {
  return toMarkdown(tree, resolveConfig(options.syntax), options)
}

// ── visit ───────────────────────────────────────────────────────────────────

/** Do not visit the children of the current node. */
export const SKIP = 'skip'
/** Stop the whole traversal. */
export const EXIT = false

/** Return SKIP, EXIT, or the index of the next sibling to visit (after inserting/removing siblings). */
export type VisitResult = void | typeof SKIP | typeof EXIT | number
export type Visitor<T extends Nodes = Nodes> = (node: T, index: number | undefined, parent: Parents | undefined) => VisitResult

/**
 * Depth-first preorder walk, same semantics as unist-util-visit.
 * `visit(tree, fn)`, `visit(tree, 'heading', fn)` or `visit(tree, ['link', 'image'], fn)`.
 */
export function visit(tree: Nodes, visitor: Visitor): void
export function visit<T extends NodeType>(tree: Nodes, type: T | readonly T[], visitor: Visitor<NodeOf<T>>): void
export function visit(tree: Nodes, typeOrVisitor: NodeType | readonly NodeType[] | Visitor, maybeVisitor?: Visitor<any>): void {
  const visitor = typeof typeOrVisitor === 'function' ? typeOrVisitor : maybeVisitor!
  const types = typeof typeOrVisitor === 'function' ? undefined : typeof typeOrVisitor === 'string' ? [typeOrVisitor] : typeOrVisitor
  walk(tree, undefined, undefined, types, visitor)
}

function walk(node: Nodes, index: number | undefined, parent: Parents | undefined, types: readonly string[] | undefined, visitor: Visitor): VisitResult {
  const result = !types || types.includes(node.type) ? visitor(node, index, parent) : undefined
  if (result === EXIT || result === SKIP || !('children' in node)) return result
  const children = node.children as Nodes[]
  let i = 0
  while (i < children.length) {
    const child = walk(children[i]!, i, node as Parents, types, visitor)
    if (child === EXIT) return EXIT
    i = typeof child === 'number' ? child : i + 1
  }
  return result
}

/** Plain text content of a node, same as mdast-util-to-string (image alt and html included). */
export function toString(node: Nodes | Nodes[] | undefined): string {
  if (!node) return ''
  if (Array.isArray(node)) {
    let out = ''
    for (const child of node) out += toString(child)
    return out
  }
  if ('value' in node && typeof node.value === 'string') return node.value
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  return 'children' in node ? toString(node.children as Nodes[]) : ''
}

// Public API: parse, stringify, visit. Every node type is exported from ./types.ts.
import { parseDocument } from './parser.ts'
import { toMarkdown, type StringifyOptions } from './stringify.ts'
import { MdxParseError, resolveConfig, type Syntax } from './syntax.ts'
import type { NodeOf, NodeType, Nodes, Parents, Root } from './types.ts'

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
  const config = resolveConfig(options.syntax, options.positions ?? true)
  try {
    return parseDocument(source, config)
  } catch (error) {
    if (error instanceof MdxParseError) return error
    throw error
  }
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

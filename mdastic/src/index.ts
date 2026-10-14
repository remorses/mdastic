// Public API: parse, stringify, visit. Every node type is exported from ./types.ts.
import { parseDocument } from './parser.ts'
import { toMarkdown, type StringifyOptions } from './stringify.ts'
import { MdxParseError, resolveConfig, type Syntax } from './syntax.ts'
import type { Nodes, Root } from './types.ts'

export type * from './types.ts'
export type { Syntax, GfmSyntax, MdxSyntax, FrontmatterSyntax } from './syntax.ts'
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

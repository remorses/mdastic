// Block discovery registers definitions before the inline phase resolves references.
// Owns per-document resets. Parsing is synchronous and non-reentrant.
import type { Config } from './syntax.ts'
import type { Root } from './types.ts'
import { Char, indexLines } from './scan.ts'
import { lines, parseBlocks, resetBlocks, runInlineTasks, type BlockContext } from './block.ts'
import { Kind, materializeRoot, node, resetTree } from './tree.ts'
import { transformLiteralLinks } from './autolink.ts'
import { mdxHooks } from './mdx-parser.ts'
import { headingIdInline } from './heading-id.ts'
import { resetInline } from './inline.ts'

export interface ParserHooks {
  flow?: BlockContext['flow']
  inline?: BlockContext['inline']
}

export function parseDocument(source: string, config: Config, hooks?: ParserHooks): Root {
  if (source.charCodeAt(0) === Char.Bom) source = source.slice(1)
  // NUL replacement is one code unit, so positions stay unchanged.
  if (source.indexOf('\0') >= 0) source = source.replaceAll('\0', '\uFFFD')
  indexLines(source, config.positions)
  resetTree()
  resetBlocks()
  // A failed MDX parse can leave delimiters behind before recursive scope restoration.
  resetInline(config)
  const root = node(Kind.Root, 0, source.length)
  const mdx = config.mdx ? mdxHooks(source, config.mdx) : undefined
  const inline: BlockContext['inline'] = config.headingId
    ? (view, start, end) => headingIdInline(view, start, end) ?? mdx?.inline(view, start, end)
    : mdx?.inline
  const context: BlockContext = {
    source,
    config,
    definitions: new Map(),
    footnotes: new Set(),
    ...mdx,
    flow: hooks?.flow ?? mdx?.flow,
    inline: hooks?.inline ?? inline,
  }
  context.inlineMarkers = !!inline && !hooks?.inline
  // Discover blocks and definitions before resolving inline references and JSX nesting.
  parseBlocks(context, lines(source), root, true)
  runInlineTasks(context)
  mdx?.finish()
  // Decoded-text fallback links run after tokenizer links and before materialization.
  if (config.gfm) transformLiteralLinks(root)
  return materializeRoot(root)
}

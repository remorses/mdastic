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

/**
 * True when the last successful parse saw state that crosses top-level blocks: link or footnote
 * definitions, or MDX imports. The stream parser then cannot reuse earlier blocks.
 */
export let documentScoped = false

/**
 * Parse `source` into mdast. With `from` > 0, only top-level blocks from that line start are parsed;
 * the caller guarantees every block before it is closed. Positions and estree stay document-relative.
 */
export function parseDocument({
  source,
  config,
  hooks,
  from = 0,
}: {
  source: string
  config: Config
  hooks?: ParserHooks
  from?: number
}): Root {
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
  parseBlocks(context, lines(source, from), root, from === 0)
  runInlineTasks(context)
  mdx?.finish()
  // Decoded-text fallback links run after tokenizer links and before materialization.
  if (config.gfm) transformLiteralLinks(root)
  documentScoped = context.definitions.size > 0 || context.footnotes.size > 0 || !!mdx?.hasImports()
  return materializeRoot(root)
}

// Block discovery registers definitions before the inline phase resolves references.
import type { Config } from './syntax.ts'
import type { Root } from './types.ts'
import { indexLines } from './scan.ts'
import { lines, parseBlocks, resetBlocks, runInlineTasks, type BlockContext } from './block.ts'
import { Kind, materializeRoot, node, resetTree } from './tree.ts'
import { transformLiteralLinks } from './autolink.ts'
import { mdxHooks } from './mdx-parser.ts'

export interface ParserHooks {
  flow?: BlockContext['flow']
  inline?: BlockContext['inline']
}

export function parseDocument(source: string, config: Config, hooks?: ParserHooks): Root {
  if (source.charCodeAt(0) === 65279) source = source.slice(1)
  // NUL replacement is one code unit, so positions stay unchanged.
  if (source.indexOf('\0') >= 0) source = source.replaceAll('\0', '\uFFFD')
  indexLines(source, config.positions)
  resetTree()
  resetBlocks()
  const root = node(Kind.Root, 0, source.length)
  const mdx = config.mdx ? mdxHooks(source, config.mdx) : undefined
  const context: BlockContext = {
    source,
    config,
    definitions: new Map(),
    footnotes: new Set(),
    ...mdx,
    flow: hooks?.flow ?? mdx?.flow,
    inline: hooks?.inline ?? mdx?.inline,
  }
  context.inlineMarkers = !!mdx && !hooks?.inline
  parseBlocks(context, lines(source), root, true)
  runInlineTasks(context)
  mdx?.finish()
  if (config.gfm) transformLiteralLinks(root)
  return materializeRoot(root)
}

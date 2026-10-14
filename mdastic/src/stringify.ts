// Serializer entry. Placeholder until the mdast-util-to-markdown port lands.
import type { Config } from './syntax.ts'
import type { Nodes } from './types.ts'

export interface StringifyOptions {}

export function toMarkdown(tree: Nodes, config: Config, options: StringifyOptions): string {
  throw new Error(`stringify not implemented (${tree.type}, ${Boolean(config.gfm)}, ${Object.keys(options)})`)
}

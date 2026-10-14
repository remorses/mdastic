// Parser entry. Placeholder until the block + inline phases land.
import type { Config } from './syntax.ts'
import type { Root } from './types.ts'

export function parseDocument(source: string, config: Config): Root {
  throw new Error(`parser not implemented (${source.length} chars, positions=${config.positions})`)
}

// Frontmatter syntax: `---` yaml and `+++` toml blocks at the start of the document.
import type { FrontmatterSyntax } from './syntax.ts'

export function frontmatter(kinds: readonly ('yaml' | 'toml')[] = ['yaml', 'toml']): FrontmatterSyntax {
  return { name: 'frontmatter', yaml: kinds.includes('yaml'), toml: kinds.includes('toml') }
}

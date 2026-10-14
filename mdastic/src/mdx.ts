// MDX syntax: JSX, `{expressions}` and ESM. Same defaults as micromark-extension-mdxjs.
import { Parser } from 'acorn'
import jsx from 'acorn-jsx'
import type { MdxSyntax } from './syntax.ts'

const AcornJsx = Parser.extend(jsx())

export function mdx(options: { estree?: boolean } = {}): MdxSyntax {
  return { name: 'mdx', acorn: AcornJsx, estree: options.estree ?? true }
}

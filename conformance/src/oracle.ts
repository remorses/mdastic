// The oracle: the real remark stack, pinned. Every conformance test compares mdastic against it.
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { mdxjs } from 'micromark-extension-mdxjs'
import { mdxFromMarkdown, mdxToMarkdown } from 'mdast-util-mdx'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown, frontmatterToMarkdown } from 'mdast-util-frontmatter'
import type { Root } from 'mdast'
import { micromarkHeadingId } from 'micromark-heading-id'
import { mdastHeadingId } from 'mdast-heading-id'

export type SyntaxName = 'gfm' | 'mdx' | 'frontmatter' | 'headingId'

export type Fixture = {
  name: string
  input: string
  syntax: SyntaxName[]
}

/** A hand-built tree from an upstream toMarkdown test. `options` never contains `extensions`. */
export type StringifyTreeFixture = {
  name: string
  tree: unknown
  options: Record<string, unknown>
  syntax: SyntaxName[]
}

export type OracleError = {
  message: string
  line?: number
  column?: number
  offset?: number
  ruleId?: string
  source?: string
}

// Same order remark-mdx + remark-frontmatter(['yaml','toml']) + remark-gfm register them in safe-mdx.
function extensions(syntax: SyntaxName[]) {
  const micromark: any[] = []
  const from: any[] = []
  const to: any[] = []
  if (syntax.includes('mdx')) {
    micromark.push(mdxjs())
    from.push(mdxFromMarkdown())
    to.push(mdxToMarkdown())
  }
  if (syntax.includes('frontmatter')) {
    micromark.push(frontmatter(['yaml', 'toml']))
    from.push(frontmatterFromMarkdown(['yaml', 'toml']))
    to.push(frontmatterToMarkdown(['yaml', 'toml']))
  }
  if (syntax.includes('gfm')) {
    micromark.push(gfm())
    from.push(gfmFromMarkdown())
    to.push(gfmToMarkdown())
  }
  if (syntax.includes('headingId')) {
    micromark.push(micromarkHeadingId())
    from.push(mdastHeadingId())
  }
  return { micromark, from, to }
}

export function oracleParse(input: string, syntax: SyntaxName[]): Root | OracleError {
  const ext = extensions(syntax)
  try {
    return fromMarkdown(input, { extensions: ext.micromark, mdastExtensions: ext.from })
  } catch (error: any) {
    return toOracleError(error)
  }
}

export function oracleStringify(tree: Root, syntax: SyntaxName[]): string {
  return toMarkdown(tree, { extensions: extensions(syntax).to })
}

/** toMarkdown with extra options (bullet, emphasis, listItemIndent…). `extensions` comes from `syntax`. */
export function oracleStringifyWith(tree: Root, syntax: SyntaxName[], options: Record<string, unknown> = {}): string {
  return toMarkdown(tree, { ...options, extensions: extensions(syntax).to })
}

export function toOracleError(error: any): OracleError {
  const place = error?.place
  const point = place && 'start' in place ? place.start : place
  return {
    message: error?.reason ?? String(error?.message ?? error),
    line: point?.line ?? error?.line,
    column: point?.column ?? error?.column,
    offset: point?.offset,
    ruleId: error?.ruleId,
    source: error?.source,
  }
}

/** Plain JSON copy: drops undefined fields and class prototypes (acorn Node, SourceLocation). */
export function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

// Syntax descriptors and the flat config the parser and serializer read. One list drives both.
import type { Parser as AcornParser } from 'acorn'
import type { Point } from './types.ts'

export interface GfmSyntax {
  readonly name: 'gfm'
  /** Allow `~one~` strikethrough, like micromark-extension-gfm-strikethrough `singleTilde`. Default true. */
  readonly singleTilde: boolean
}

export interface MdxSyntax {
  readonly name: 'mdx'
  /** acorn Parser extended with acorn-jsx. Only `mdastic/mdx` imports acorn, so core bundles stay small. */
  readonly acorn: typeof AcornParser
  /** Attach `data.estree` to ESM, expressions and expression attributes (like remark-mdx). Default true. */
  readonly estree: boolean
}

export interface FrontmatterSyntax {
  readonly name: 'frontmatter'
  readonly yaml: boolean
  readonly toml: boolean
}

export interface HeadingIdSyntax {
  readonly name: 'headingId'
}

export type Syntax = GfmSyntax | MdxSyntax | FrontmatterSyntax | HeadingIdSyntax

/** Resolved, flat view of a syntax list. Built once per call site, read in hot loops. */
export interface Config {
  gfm: GfmSyntax | undefined
  mdx: MdxSyntax | undefined
  frontmatter: FrontmatterSyntax | undefined
  headingId?: HeadingIdSyntax
  positions: boolean
}

export function resolveConfig(syntax: readonly Syntax[] = [], positions = true): Config {
  const config: Config = { gfm: undefined, mdx: undefined, frontmatter: undefined, positions }
  for (const s of syntax) {
    if (s.name === 'gfm') config.gfm = s
    else if (s.name === 'mdx') config.mdx = s
    else if (s.name === 'frontmatter') config.frontmatter = s
    else if (s.name === 'headingId') config.headingId = s
  }
  return config
}

/**
 * MDX syntax error. Same fields as the VFileMessage micromark throws: `message` is the reason
 * and `name` is the place (`'1:6'`, `'1:1'` when unknown), so `String(error)` is `1:6: reason`.
 */
export class MdxParseError extends Error {
  override readonly name: string
  readonly reason: string
  readonly place: Point | undefined
  readonly line: number | undefined
  readonly column: number | undefined
  readonly ruleId: string
  readonly source: string
  readonly url: string | undefined
  readonly fatal = true
  constructor(options: { reason: string; place?: Point; ruleId: string; source: string; url?: string; cause?: unknown }) {
    super(options.reason, { cause: options.cause })
    this.name = options.place ? `${options.place.line}:${options.place.column}` : '1:1'
    this.reason = options.reason
    this.place = options.place
    this.line = options.place?.line
    this.column = options.place?.column
    this.ruleId = options.ruleId
    this.source = options.source
    this.url = options.url
  }
}

// Syntax descriptors and the flat config the parser and serializer read. One list drives both.
import type { Parser as AcornParser } from 'acorn'
import type { Point, Position } from './types.ts'

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

export interface MathSyntax {
  readonly name: 'math'
  /** Allow `$x$` with one dollar, like micromark-extension-math `singleDollarTextMath`. Default true. */
  readonly singleDollarTextMath: boolean
}

export type Syntax = GfmSyntax | MdxSyntax | FrontmatterSyntax | HeadingIdSyntax | MathSyntax

/** Resolved, flat view of a syntax list. Built once per call site, read in hot loops. */
export interface Config {
  gfm: GfmSyntax | undefined
  mdx: MdxSyntax | undefined
  frontmatter: FrontmatterSyntax | undefined
  headingId?: HeadingIdSyntax
  math?: MathSyntax
  positions: boolean
}

export function resolveConfig(syntax: readonly Syntax[] = [], positions = true): Config {
  const config: Config = { gfm: undefined, mdx: undefined, frontmatter: undefined, positions }
  for (const s of syntax) {
    if (s.name === 'gfm') config.gfm = s
    else if (s.name === 'mdx') config.mdx = s
    else if (s.name === 'frontmatter') config.frontmatter = s
    else if (s.name === 'headingId') config.headingId = s
    else if (s.name === 'math') config.math = s
  }
  return config
}

const MDX_JSX_DOCS = 'https://github.com/micromark/micromark-extension-mdx-jsx'
const MDX_EXPRESSION_DOCS =
  'https://github.com/micromark/micromark-extension-mdx-expression/tree/main/packages/micromark-extension-mdx-expression'
const MDX_ESM_DOCS = 'https://github.com/micromark/micromark-extension-mdxjs-esm'

/** `url` that micromark sets per `source:ruleId`. mdast-util-mdx-jsx errors have none. */
const ERROR_URLS: Record<string, string> = {
  'micromark-extension-mdx-jsx:unexpected-eof': MDX_JSX_DOCS + '#unexpected-end-of-file-at-expected-expect',
  'micromark-extension-mdx-jsx:unexpected-character': MDX_JSX_DOCS + '#unexpected-character-at-expected-expect',
  'micromark-extension-mdx-jsx:unexpected-lazy': MDX_JSX_DOCS + '#unexpected-lazy-line-in-container-expected-line-to-be',
  'micromark-extension-mdx-expression:unexpected-eof':
    MDX_EXPRESSION_DOCS + '#unexpected-end-of-file-in-expression-expected-a-corresponding-closing-brace-for-',
  'micromark-extension-mdx-expression:unexpected-lazy':
    MDX_EXPRESSION_DOCS + '#unexpected-lazy-line-in-expression-in-container-expected-line-to-be-prefixed',
  'micromark-extension-mdx-expression:non-spread': MDX_EXPRESSION_DOCS + '#unexpected-type-in-code-expected-an-object-spread-spread',
  'micromark-extension-mdx-expression:spread-extra':
    MDX_EXPRESSION_DOCS + '#unexpected-extra-content-in-spread-only-a-single-spread-is-supported',
  'micromark-extension-mdx-expression:acorn': MDX_EXPRESSION_DOCS + '#could-not-parse-expression-with-acorn',
  'micromark-extension-mdxjs-esm:acorn': MDX_ESM_DOCS + '#could-not-parse-importexports-with-acorn',
  'micromark-extension-mdxjs-esm:non-esm': MDX_ESM_DOCS + '#unexpected-type-in-code-only-importexports-are-supported',
}

function stringifyPoint(point: Point): string {
  return `${point.line}:${point.column}`
}

/**
 * MDX syntax error. Same fields as the VFileMessage micromark throws: `message` is the reason
 * and `name` is the place (`'1:6'`, `'1:4-1:8'` for a range, `'1:1'` when unknown), so
 * `String(error)` is `1:6: reason`.
 */
export class MdxParseError extends Error {
  override readonly name: string
  readonly reason: string
  readonly place: Point | Position | undefined
  readonly line: number | undefined
  readonly column: number | undefined
  readonly ruleId: string
  readonly source: string
  readonly url: string | undefined
  readonly fatal = true
  constructor(options: {
    reason: string
    place?: Point | Position
    ruleId: string
    source: string
    url?: string
    cause?: unknown
  }) {
    super(options.reason, { cause: options.cause })
    const place = options.place
    const start = place && 'start' in place ? place.start : place
    this.name = !place ? '1:1' : 'start' in place ? `${stringifyPoint(place.start)}-${stringifyPoint(place.end)}` : stringifyPoint(place)
    this.reason = options.reason
    this.place = place
    this.line = start?.line
    this.column = start?.column
    this.ruleId = options.ruleId
    this.source = options.source
    this.url = options.url ?? ERROR_URLS[options.source + ':' + options.ruleId]
  }
}

// Replaces satteri's test/conformance/helpers.ts: every helper records its markdown input with the
// syntax its remark reference pipeline uses (remark-gfm base; mdx helpers use @mdx-js/mdx defaults).
import { record, universal } from './runtime.ts'

type Syntax = string[] | 'skip'
const gfm: Syntax = ['gfm']
const fm: Syntax = ['frontmatter', 'gfm']

function rec(syntax: Syntax | ((...args: any[]) => Syntax)) {
  return (input: unknown, ...rest: any[]) => {
    record('parse', input, undefined, typeof syntax === 'function' ? syntax(...rest) : syntax)
    return universal
  }
}

const ext = (extensions: string[] = []): Syntax =>
  extensions.includes('math') || extensions.includes('directive') ? 'skip' : extensions.includes('frontmatter') ? fm : gfm

export const REF_REHYPE_OPTIONS = {}
export const normalizeAlignToStyle = (node: unknown) => node
export const referenceMdast = rec(gfm)
export const referenceHast = rec(gfm)
export const satteriMdast = rec(gfm)
export const satteriHast = rec(gfm)
export const referenceHtml = rec(gfm)
export const satteriHtml = rec(gfm)
export const referenceMathMdast = rec('skip')
export const satteriMathMdast = rec('skip')
export const referenceMathHast = rec('skip')
export const referenceMathHtml = rec('skip')
export const satteriMathHast = rec('skip')
export const satteriMathHtml = rec('skip')
export const assertNoSingleDollarMathMdastConformance = rec('skip')
export const assertNoSingleDollarMathHastConformance = rec('skip')
export const assertFootnoteHastConformance = rec(gfm)
export const referenceFmMdast = rec(fm)
export const referenceFmHast = rec(fm)
export const referenceFmHtml = rec(fm)
export const satteriFmMdast = rec(fm)
export const satteriFmHast = rec(fm)
export const satteriFmHtml = rec(fm)
export const assertSliceInvariantEverywhere = () => {}
export const reconcileFnrPositions = () => {}
export const assertMdastConformance = rec(gfm)
export const assertCommonMarkMdastConformance = rec([])
export const collectUrls = () => []
export const linkUrls = rec(gfm)
export const conforms = rec(gfm)
export const assertMdastConformanceNoPosition = rec(gfm)
export const assertHastConformance = rec(gfm)
export const assertHtmlConformance = rec(gfm)
export const assertExtMdastConformance = rec(ext)
export const assertExtHastConformance = rec(ext)
export const assertMdxConformance = rec(['mdx'])
export const assertMdxPluginConformance = rec(['mdx'])
export const assertMarkdownJsConformance = rec((o: any = {}) => (o.math ? 'skip' : o.frontmatter ? fm : gfm))
export const assertMarkdownJsModuleConformance = rec(gfm)
export const assertMarkdownJsDevPositionConformance = rec(gfm)
export const assertMdxDevPositionConformance = rec(['mdx'])
export const assertMdxMathConformance = rec('skip')
export const assertMdxInlineStyleConformance = rec(['mdx'])
export const assertBothReject = rec(['mdx'])
export const assertRejects = rec(['mdx'])

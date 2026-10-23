// Math with `singleDollarTextMath: false`, which fixtures cannot express: the math fixture inputs
// parse and round-trip like remark-math configured the same way.
import { expect, test } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfm as gfmSyntax } from 'micromark-extension-gfm'
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm'
import { math as mathSyntax } from 'micromark-extension-math'
import { mathFromMarkdown, mathToMarkdown } from 'mdast-util-math'
import { parse, stringify } from '../../mdastic/src/index.ts'
import { gfm } from '../../mdastic/src/gfm.ts'
import { math } from '../../mdastic/src/math.ts'
import { loadFixtureFiles } from './harness.ts'
import { normalize } from './oracle.ts'

const options = { singleDollarTextMath: false }
const syntax = [gfm(), math(options)]
const inputs = loadFixtureFiles()
  .filter(({ file }) => /^math-(?!realworld)/.test(file))
  .flatMap(({ fixtures }) => fixtures.filter((f) => f.syntax.join() === 'gfm,math').map((f) => f.input))

test.each(inputs.map((input, i) => [i, input] as const))('double dollar %i', (_, input) => {
  const expected = fromMarkdown(input, {
    extensions: [gfmSyntax(), mathSyntax(options)],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  expect(normalize(parse(input, { syntax }))).toEqual(normalize(expected))
  const markdown = toMarkdown(structuredClone(expected), { extensions: [gfmToMarkdown(), mathToMarkdown(options)] })
  expect(stringify(structuredClone(expected) as any, { syntax })).toBe(markdown)
})

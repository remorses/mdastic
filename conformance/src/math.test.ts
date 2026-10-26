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

test('dollar run lookup respects inline bounds, escaped openers and fresh parses', () => {
  const RUN_LENGTH_COUNT = 32
  const runs = Array.from({ length: RUN_LENGTH_COUNT }, (_, i) => 'e' + '$'.repeat(i + 1)).join('')
  const sources = [
    runs,
    runs + ' $closed$',
    '[a $b](u) c$',
    '[a $$b](u) c$$',
    '[a $[b](v)$](u)',
    '[a $b$](u) $c$',
    '[$$]()$\n\n[$$$]()$\n\n[![a](x)$$](u)$\n\n[$$][ref]$\n\n[ref]: /url',
    '\\$$x$ $$y$$ \\$$$z$$',
    '`$x$` $a\\$b$ <i data-x="$">x</i> $c$',
    '> 😀 $a$\n> $$b$$\n\n- $c$\n\n$d$',
    '$a$\n\n$$a$$',
    '$a$\n\n$a$',
    runs,
  ]
  for (const singleDollarTextMath of [true, false, true]) {
    const options = { singleDollarTextMath }
    for (const source of sources) {
      const expected = fromMarkdown(source, {
        extensions: [gfmSyntax(), mathSyntax(options)],
        mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
      })
      expect(normalize(parse(source, { syntax: [gfm(), math(options)] }))).toEqual(normalize(expected))
    }
  }
})

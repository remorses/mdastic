// Differential parse conformance: mdastic tree (positions + estree) must deep-equal the oracle's.
import { describe, expect, test } from 'vitest'
import { expectedParse, loadFixtureFiles, mdasticParse } from './harness.ts'
import { parse } from '../../mdastic/src/index.ts'
import { mdx } from '../../mdastic/src/mdx.ts'
import { normalize, toOracleError } from './oracle.ts'

test('MDX options keep validation and document-relative ESTree locations', () => {
  const sources = [
    "import {x} from 'x'\n\n> <Box value={\n>   x /* comment */\n> } {...props}>\n> {`a${x}`}\n> </Box>\n",
    '\n\n{a +}',
    '<Box>',
  ]
  function omit(value: unknown, key: string): unknown {
    return JSON.parse(JSON.stringify(value, (name, item) => name === key ? undefined : item))
  }
  for (const source of sources) {
    const expected = expectedParse(source, ['mdx'])
    for (const positions of [true, false]) {
      for (const estree of [true, false]) {
        const result = parse(source, { syntax: [mdx({ estree })], positions })
        let actual: unknown = result instanceof Error ? toOracleError(result) : normalize(result)
        let wanted: unknown = expected
        if (!positions) wanted = omit(wanted, 'position')
        if (!estree) {
          actual = omit(actual, 'data')
          wanted = omit(wanted, 'data')
        }
        expect(actual).toEqual(wanted)
      }
    }
  }
})

test('MDX expression probes stop at the first closing brace acorn rejects', () => {
  // Paragraph interruption probes read across container prefixes, so `> }` is never valid there.
  const fence = '```'
  const shapes = [
    `> ${fence}\n> {\n> }\n> ${fence}\n`,
    `- > ${fence}\n  > {\n  > }\n  > ${fence}\n`,
    `> > ${fence}\n> > {a b\n> > }\n> > ${fence}\n`,
    `> ${fence}\n> <A {...\n> } b={\n> } />\n> ${fence}\n`,
    '> {\n> }\n',
    '> a\n> {\n> b}\n',
    '> <A b={\n> 1} />\n',
  ]
  let calls = 0
  const base = mdx()
  class Counting extends base.acorn {
    static override parse(...args: Parameters<typeof base.acorn.parse>) {
      calls++
      return super.parse(...args)
    }
    static override parseExpressionAt(...args: Parameters<typeof base.acorn.parseExpressionAt>) {
      calls++
      return super.parseExpressionAt(...args)
    }
  }
  const syntax = [{ ...base, acorn: Counting }]
  function count(source: string) {
    calls = 0
    const result = parse(source, { syntax })
    return { calls, result: result instanceof Error ? toOracleError(result) : normalize(result) }
  }
  for (const shape of shapes) {
    const small = count(shape.repeat(20))
    expect(small.result).toEqual(expectedParse(shape.repeat(20), ['mdx']))
    // Each probe tries a bounded number of braces, so acorn calls grow with the input.
    expect(count(shape.repeat(40)).calls).toBeLessThanOrEqual(2 * small.calls + 8)
    // A fresh parse of the same source does the same work and returns the same tree.
    expect(count(shape.repeat(20))).toEqual(small)
  }
})

for (const { file, fixtures } of loadFixtureFiles()) {
  describe(file, () => {
    test.each(fixtures.map((f, i) => [`${i} ${f.name}`, f] as const))('%s', (_, fixture) => {
      expect(mdasticParse(fixture.input, fixture.syntax)).toEqual(expectedParse(fixture.input, fixture.syntax))
    })
  })
}

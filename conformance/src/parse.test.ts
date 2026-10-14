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

for (const { file, fixtures } of loadFixtureFiles()) {
  describe(file, () => {
    test.each(fixtures.map((f, i) => [`${i} ${f.name}`, f] as const))('%s', (_, fixture) => {
      expect(mdasticParse(fixture.input, fixture.syntax)).toEqual(expectedParse(fixture.input, fixture.syntax))
    })
  })
}

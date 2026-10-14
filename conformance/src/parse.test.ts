// Differential parse conformance: mdastic tree (positions + estree) must deep-equal the oracle's.
import { describe, expect, test } from 'vitest'
import { expectedParse, loadFixtureFiles, mdasticParse } from './harness.ts'

for (const { file, fixtures } of loadFixtureFiles()) {
  describe(file, () => {
    test.each(fixtures.map((f, i) => [`${i} ${f.name}`, f] as const))('%s', (_, fixture) => {
      expect(mdasticParse(fixture.input, fixture.syntax)).toEqual(expectedParse(fixture.input, fixture.syntax))
    })
  })
}

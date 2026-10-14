// Differential stringify conformance: same oracle tree must serialize to the same markdown.
import { describe, expect, test } from 'vitest'
import { loadFixtureFiles, stringifyPair } from './harness.ts'

for (const { file, fixtures } of loadFixtureFiles()) {
  describe(file, () => {
    test.each(fixtures.map((f, i) => [`${i} ${f.name}`, f] as const))('%s', (_, fixture) => {
      const pair = stringifyPair(fixture.input, fixture.syntax)
      if (!pair) return
      expect(pair.actual).toBe(pair.expected)
    })
  })
}

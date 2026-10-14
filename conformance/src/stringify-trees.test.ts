// Serializer conformance on hand-built trees (mdast-util-to-markdown + extension test suites):
// mdastic stringify(tree, options) must equal the oracle's toMarkdown(tree, options).
import { describe, expect, test } from 'vitest'
import { loadStringifyTreeFiles, stringifyTreePair } from './harness.ts'

for (const { file, fixtures } of loadStringifyTreeFiles()) {
  describe(file, () => {
    test.each(fixtures.map((f, i) => [`${i} ${f.name}`, f] as const))('%s', (_, fixture) => {
      const pair = stringifyTreePair(fixture)
      expect(pair.actual).toBe(pair.expected)
    })
  })
}

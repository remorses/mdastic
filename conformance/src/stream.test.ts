// Stream parser parity: every streamed prefix must give the same tree as a full `parse` of it.
import { describe, expect, test } from 'vitest'
import { createStreamParser, parse, type Root } from 'mdastic/src'
import { mdx } from 'mdastic/src/mdx'
import { gfm } from 'mdastic/src/gfm'
import { loadFixtureFiles, toSyntax } from './harness.ts'
import { toOracleError, type SyntaxName } from './oracle.ts'

// Short inputs are streamed one character at a time, long ones in this many uneven chunks.
const CHAR_BY_CHAR_MAX_LENGTH = 400
const LONG_INPUT_STEPS = 40
// Quadratic inputs: full reparses per step take minutes. Linear time is checked by scripts/pathological.ts.
const SLOW_FILES = new Set(['pathological.json'])
const SLOW_INPUT_LENGTH = 50_000

function snapshot(result: ReturnType<typeof parse>): string {
  return JSON.stringify(result instanceof Error ? toOracleError(result) : result)
}

/** Prefix lengths a stream delivers: every character, or uneven chunks ending at the full input. */
function prefixLengths(length: number): number[] {
  if (length <= CHAR_BY_CHAR_MAX_LENGTH) return Array.from({ length }, (_, i) => i + 1)
  const step = Math.ceil(length / LONG_INPUT_STEPS)
  const result: number[] = []
  // Alternate chunk sizes so cuts land on different columns and line breaks.
  for (let n = 1, k = 0; n < length; n += step + (k++ % 3) * 7) result.push(n)
  result.push(length)
  return result
}

/** First streamed prefix whose tree differs from `parse(prefix)`, or null. */
function firstMismatch(input: string, names: SyntaxName[]) {
  const syntax = toSyntax(names)
  const stream = createStreamParser({ syntax })
  for (const length of prefixLengths(input.length)) {
    const prefix = input.slice(0, length)
    const actual = snapshot(stream.parse(prefix))
    const expected = snapshot(parse(prefix, { syntax }))
    if (actual !== expected) return { prefix, actual, expected }
  }
  return null
}

describe('every fixture, streamed', () => {
  for (const { file, fixtures } of loadFixtureFiles()) {
    if (SLOW_FILES.has(file)) continue
    test(file, () => {
      const failures = fixtures
        .filter((fixture) => fixture.input.length < SLOW_INPUT_LENGTH)
        .map((fixture) => ({ name: fixture.name, mismatch: firstMismatch(fixture.input, fixture.syntax) }))
        .filter((failure) => failure.mismatch)
      expect(failures.slice(0, 3)).toEqual([])
    })
  }
})

// A chat answer the way models stream it: think wrapper, unclosed fences with blank lines, a table,
// a multi-line JSX component, a list that keeps growing, and a reference defined at the end.
const CHAT_ANSWER = `<think>
The user wants a table.

Keep it short.
</think>

# Result

Here is the code:

\`\`\`ts
const a = 1

const b = 2
\`\`\`

| name | value |
| ---- | ----- |
| a    | 1     |
| b    | 2     |

<Callout
  type="warning"
  title={\`Note \${1 + 1}\`}
>
  Values are **cached**.

  - first
</Callout>

1. one
2. two

   still two

3. three

See [the docs][docs].

[docs]: https://example.com
`

test('chat answer streamed char by char matches parse at every step', () => {
  for (const names of [['mdx', 'gfm'], ['gfm']] as SyntaxName[][]) {
    expect(firstMismatch(CHAT_ANSWER, names)).toBeNull()
  }
})

test('closed blocks keep identity, the live block is replaced', () => {
  const stream = createStreamParser({ syntax: [gfm()] })
  // The live line `Second` must be complete before `First paragraph` is reused.
  const first = stream.parse('# Title\n\nFirst paragraph\n\nSecond\n') as Root
  const second = stream.parse('# Title\n\nFirst paragraph\n\nSecond\n\n- a\n') as Root
  expect(second.children.map((node, i) => [node.type, node === first.children[i]])).toMatchInlineSnapshot(`
    [
      [
        "heading",
        true,
      ],
      [
        "paragraph",
        true,
      ],
      [
        "paragraph",
        false,
      ],
      [
        "list",
        false,
      ],
    ]
  `)
  expect(snapshot(second)).toBe(snapshot(parse('# Title\n\nFirst paragraph\n\nSecond\n\n- a\n', { syntax: [gfm()] })))
})

test('blocks are reused only when later text cannot change them', () => {
  // Each pair: the earlier text has two top-level nodes, the later text merges them into one.
  // The live line is incomplete: `1` and `<div` can still change meaning.
  // No blank line: a multi-line JSX tag interrupts `foo`, until text after `/>` makes it inline.
  const cases = [
    { before: '1. a\n\n1', after: '1. a\n\n1. b', syntax: [gfm()] },
    { before: 'foo\n<div', after: 'foo\n<divx', syntax: [gfm()] },
    { before: 'foo\n<A\n/>\n', after: 'foo\n<A\n/> x', syntax: [mdx()] },
  ]
  const result = cases.map(({ before, after, syntax }) => {
    const stream = createStreamParser({ syntax })
    const split = (stream.parse(before) as Root).children.length
    const tree = stream.parse(after) as Root
    return { split, merged: tree.children.length, same: snapshot(tree) === snapshot(parse(after, { syntax })) }
  })
  expect(result).toMatchInlineSnapshot(`
    [
      {
        "merged": 1,
        "same": true,
        "split": 2,
      },
      {
        "merged": 1,
        "same": true,
        "split": 2,
      },
      {
        "merged": 1,
        "same": true,
        "split": 2,
      },
    ]
  `)
})

test('definitions resolve references in earlier blocks', () => {
  const stream = createStreamParser()
  const first = stream.parse('[a]\n\ntext\n\n[a') as Root
  const second = stream.parse('[a]\n\ntext\n\n[a]: /url\n') as Root
  expect([first.children[0]?.type, (second.children[0] as any).children[0].type]).toMatchInlineSnapshot(`
    [
      "paragraph",
      "linkReference",
    ]
  `)
})

test('an invalid MDX tail returns the parse error, then streaming continues', () => {
  const syntax = [mdx()]
  const stream = createStreamParser({ syntax })
  const ok = stream.parse('# Stable\n\nDone\n\nTail\n\n') as Root
  const broken = stream.parse('# Stable\n\nDone\n\nTail\n\n<Card')
  const fixed = stream.parse('# Stable\n\nDone\n\nTail\n\n<Card />\n') as Root
  expect(String(broken)).toBe(String(parse('# Stable\n\nDone\n\nTail\n\n<Card', { syntax })))
  expect(String(broken)).toMatchInlineSnapshot(
    `"7:6: Unexpected end of file in name, expected a name character such as letters, digits, \`$\`, or \`_\`; whitespace before attributes; or the end of the tag"`,
  )
  expect(fixed.children[0]).toBe(ok.children[0])
  expect(snapshot(fixed)).toBe(snapshot(parse('# Stable\n\nDone\n\nTail\n\n<Card />\n', { syntax })))
})

test('MDX imports are validated across blocks', () => {
  const syntax = [mdx()]
  const stream = createStreamParser({ syntax })
  const source = "import a from 'a'\n\ntext\n\nimport a from 'b'\n"
  stream.parse("import a from 'a'\n\ntext\n\n")
  expect(snapshot(stream.parse(source))).toBe(snapshot(parse(source, { syntax })))
})

test('edits anywhere reparse from the start', () => {
  const stream = createStreamParser()
  stream.parse('# One\n\nTwo\n\nThree')
  const edited = stream.parse('# Uno\n\nTwo\n\nThree') as Root
  expect(snapshot(edited)).toBe(snapshot(parse('# Uno\n\nTwo\n\nThree')))
  // The line after the cut decided it: `b` closed the list, `1. c` continues it.
  stream.parse('1. a\n\nb\n')
  expect(snapshot(stream.parse('1. a\n\n1. c\n'))).toBe(snapshot(parse('1. a\n\n1. c\n')))
})

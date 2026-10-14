import { expect, test } from 'vitest'
import { parse, stringify } from 'mdastic'
import { headingId } from 'mdastic/heading-id'
import { mdx } from 'mdastic/mdx'
import { expectedParse, loadFixtureFiles, mdasticParse } from './harness.ts'
import { oracleStringify } from './oracle.ts'
import { remark } from 'remark'
import remarkMdx from 'remark-mdx'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import { micromarkHeadingId } from 'micromark-heading-id'
import { mdastHeadingId } from 'mdast-heading-id'

test('heading IDs preserve decoded values on a round trip', () => {
  const syntax = [headingId()]
  const tree = parse('# Title {#a&#123;&#125;&#92;&amp;&#10;&#13;}', { syntax })
  if (tree instanceof Error) throw tree
  const markdown = stringify(tree, { syntax })
  expect(markdown).toMatchInlineSnapshot(`
    "Title {#a&#123;&#125;&#92;&#38;&#10;&#13;}
    ==========================================
    "
  `)
  const reparsed = parse(markdown, { syntax, positions: false })
  expect(reparsed).toEqual(parse('# Title {#a&#123;&#125;&#92;&amp;&#10;&#13;}', { syntax, positions: false }))
  expect(() => oracleStringify(tree as any, ['headingId'])).toThrow('idString')
})

test('heading ID syntax follows the real-world remark stack', () => {
  for (const { file, fixtures } of loadFixtureFiles()) {
    if (!file.startsWith('realworld-')) continue
    for (const fixture of fixtures) {
      const syntax = [...fixture.syntax, 'headingId' as const]
      expect(mdasticParse(fixture.input, syntax), fixture.name).toEqual(expectedParse(fixture.input, syntax))
    }
  }
})

test('inline ID wins over MDX text expressions, not flow expressions', () => {
  expect(parse('# Title {#id} {expr}', { syntax: [mdx(), headingId()] })).toEqual(
    expectedParse('# Title {#id} {expr}', ['mdx', 'headingId']),
  )
  expect(parse('{#id}', { syntax: [mdx(), headingId()] })).toBeInstanceOf(Error)
})

test('the oracle uses the same extension order as Holocron', () => {
  const processor = remark().use(remarkMdx).use(remarkFrontmatter, ['yaml', 'toml']).use(remarkGfm).use(function () {
    const data = this.data()
    const micromark = data.micromarkExtensions ??= []
    const fromMarkdown = data.fromMarkdownExtensions ??= []
    micromark.push(micromarkHeadingId())
    fromMarkdown.push(mdastHeadingId())
  })
  for (const source of ['# Title {#id} {expr}', 'x <Box>{#id} {expr}</Box>', '| x {#id} |\n| --- |']) {
    expect(processor.parse(source)).toEqual(expectedParse(source, ['mdx', 'frontmatter', 'gfm', 'headingId']))
  }
})

test('empty IDs have an empty value at the content position', () => {
  // The pinned micromark oracle loops forever on an empty chunkString, so this is mdastic-only.
  expect(parse('x {#} y', { syntax: [headingId()] })).toMatchInlineSnapshot(`
    {
      "children": [
        {
          "children": [
            {
              "position": {
                "end": {
                  "column": 3,
                  "line": 1,
                  "offset": 2,
                },
                "start": {
                  "column": 1,
                  "line": 1,
                  "offset": 0,
                },
              },
              "type": "text",
              "value": "x ",
            },
            {
              "position": {
                "end": {
                  "column": 5,
                  "line": 1,
                  "offset": 4,
                },
                "start": {
                  "column": 5,
                  "line": 1,
                  "offset": 4,
                },
              },
              "type": "idString",
              "value": "",
            },
            {
              "position": {
                "end": {
                  "column": 8,
                  "line": 1,
                  "offset": 7,
                },
                "start": {
                  "column": 6,
                  "line": 1,
                  "offset": 5,
                },
              },
              "type": "text",
              "value": " y",
            },
          ],
          "position": {
            "end": {
              "column": 8,
              "line": 1,
              "offset": 7,
            },
            "start": {
              "column": 1,
              "line": 1,
              "offset": 0,
            },
          },
          "type": "paragraph",
        },
      ],
      "position": {
        "end": {
          "column": 8,
          "line": 1,
          "offset": 7,
        },
        "start": {
          "column": 1,
          "line": 1,
          "offset": 0,
        },
      },
      "type": "root",
    }
  `)
})

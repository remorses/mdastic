import { expect, test } from 'vitest'
import { EXIT, MdxParseError, SKIP, createProcessor, parse, stringify, toString, visit, type Root } from './index.ts'
import { gfm } from './gfm.ts'
import { headingId } from './heading-id.ts'
import { mdx, unravel } from './mdx.ts'

test('visit: typed filter, SKIP, splice with returned index, EXIT', () => {
  const tree = parse('# A *b*\n\n- x ~~y~~\n- z\n\n> q\n', { syntax: [gfm()], positions: false }) as Root
  const seen: string[] = []
  visit(tree, (node, index, parent) => {
    seen.push(node.type)
    if (node.type === 'blockquote') return SKIP
    // replace list items' emphasis-like nodes by their children, continue at same index
    if (node.type === 'delete' && parent && index !== undefined) {
      parent.children.splice(index, 1, ...(node.children as any))
      return index
    }
  })
  expect(seen).toMatchInlineSnapshot(`
    [
      "root",
      "heading",
      "text",
      "emphasis",
      "text",
      "list",
      "listItem",
      "paragraph",
      "text",
      "delete",
      "text",
      "text",
      "listItem",
      "paragraph",
      "text",
      "blockquote",
    ]
  `)
  expect(stringify(tree, { syntax: [gfm()] })).toMatchInlineSnapshot(`
    "# A *b*

    * x y
    * z

    > q
    "
  `)

  const headings: number[] = []
  visit(tree, ['heading', 'listItem'], (node) => {
    if (node.type === 'heading') headings.push(node.depth)
    if (node.type === 'listItem') return EXIT
  })
  expect(headings).toEqual([1])
  expect(toString(tree)).toBe('A bx yzq')
})

test('MdxParseError has the same name, message and String() as micromark VFileMessage', () => {
  const errors = ['<Card', '{1 +}', '<Card>\ntext'].map((source) => {
    const error = parse(source, { syntax: [mdx()] })
    if (!(error instanceof MdxParseError)) throw new Error('expected MdxParseError')
    return { name: error.name, message: error.message, string: String(error), line: error.line, ruleId: error.ruleId }
  })
  expect(errors).toMatchInlineSnapshot(`
    [
      {
        "line": 1,
        "message": "Unexpected end of file in name, expected a name character such as letters, digits, \`$\`, or \`_\`; whitespace before attributes; or the end of the tag",
        "name": "1:6",
        "ruleId": "unexpected-eof",
        "string": "1:6: Unexpected end of file in name, expected a name character such as letters, digits, \`$\`, or \`_\`; whitespace before attributes; or the end of the tag",
      },
      {
        "line": 1,
        "message": "Could not parse expression with acorn",
        "name": "1:5",
        "ruleId": "acorn",
        "string": "1:5: Could not parse expression with acorn",
      },
      {
        "line": undefined,
        "message": "Expected a closing tag for \`<Card>\` (1:1-1:7)",
        "name": "1:1",
        "ruleId": "end-tag-mismatch",
        "string": "1:1: Expected a closing tag for \`<Card>\` (1:1-1:7)",
      },
    ]
  `)
})

test('visit: [SKIP, index] skips the replaced node children and continues at index', () => {
  const tree = parse('a *b **c***\n', { positions: false }) as Root
  const seen: string[] = []
  visit(tree, (node, index, parent) => {
    seen.push(node.type)
    if (node.type === 'emphasis' && parent && index !== undefined) {
      parent.children.splice(index, 1, { type: 'text', value: 'X' })
      return [SKIP, index + 1]
    }
  })
  expect(seen).toEqual(['root', 'paragraph', 'text', 'emphasis'])
  expect(stringify(tree)).toBe('a X\n')
})

test('createProcessor: one syntax list for parse and stringify, transforms run after parse', () => {
  const processor = createProcessor({
    syntax: [mdx(), gfm(), headingId()],
    transforms: [unravel, (tree) => visit(tree, 'text', (node) => { node.value = node.value.toUpperCase() })],
    stringify: { bullet: '-' },
  })
  const tree = processor.parse('# Title {#intro}\n\n<Card />\n\n* ~~done~~\n')
  if (tree instanceof Error) throw tree
  expect(tree.children.map((node) => node.type)).toEqual(['heading', 'mdxJsxFlowElement', 'list'])
  expect(processor.stringify(tree)).toMatchInlineSnapshot(`
    "# TITLE {#intro}

    <Card />

    - ~~DONE~~
    "
  `)
  expect(processor.stringify(tree, { bullet: '*' })).toContain('* ~~DONE~~')
  expect(processor.parse('<Card')).toBeInstanceOf(MdxParseError)
})

test('unravel: paragraphs of only JSX, expressions and whitespace become flow nodes', () => {
  const types = (source: string) => {
    const tree = parse(source, { syntax: [mdx()], positions: false }) as Root
    unravel(tree)
    return tree.children.map((node) => ('children' in node ? `${node.type}(${node.children.map((c) => c.type)})` : node.type))
  }
  expect(types('<A /> <B>x</B>\n\n{1}\n\ntext <A />\n')).toMatchInlineSnapshot(`
    [
      "mdxJsxFlowElement()",
      "mdxJsxFlowElement(text)",
      "mdxFlowExpression",
      "paragraph(text,mdxJsxTextElement)",
    ]
  `)
})

import { expect, test } from 'vitest'
import { EXIT, MdxParseError, SKIP, parse, stringify, toString, visit, type Root } from './index.ts'
import { gfm } from './gfm.ts'
import { mdx } from './mdx.ts'

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

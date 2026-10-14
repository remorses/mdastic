import { expect, test } from 'vitest'
import { EXIT, SKIP, parse, stringify, toString, visit, type Root } from './index.ts'
import { gfm } from './gfm.ts'

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

import { expect, test } from 'vitest'
import { EXIT, MdxParseError, SKIP, createProcessor, parse, stringify, toString, visit, type Root } from './index.ts'
import { gfm } from './gfm.ts'
import { headingId } from './heading-id.ts'
import { expression, getAttribute, isJsx, mdx, removeAttribute, setAttribute, unravel } from './mdx.ts'

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

test('visit with a visitor per type runs them all in one walk', () => {
  const tree = parse('# A\n\n```js\nx\n```\n\n## B\n', { positions: false }) as Root
  const seen: string[] = []
  visit(tree, {
    heading: (node) => void seen.push(`h${node.depth}`),
    code: (node) => void seen.push(`code:${node.lang}`),
  })
  expect(seen).toEqual(['h1', 'code:js', 'h2'])
})

test('JSX helpers read, write and remove attributes; expression() builds estree values', () => {
  const syntax = [mdx()]
  const tree = createProcessor({ syntax, transforms: [unravel], positions: false }).parse('<Card href="/a" open {...rest}>x</Card>\n') as Root
  const card = tree.children[0]!
  expect(isJsx(card, 'Card')).toBe(true)
  expect(isJsx(card, 'Note')).toBe(false)
  if (!isJsx(card)) throw new Error('expected JSX')
  expect(getAttribute(card, 'href')?.value).toBe('/a')
  expect(getAttribute(card, 'open')?.value).toBe(null)
  expect(getAttribute(card, 'rest')).toBeUndefined()

  setAttribute(card, 'href', '/b')
  setAttribute(card, 'title', expression('<Markdown inline children="**hi**" />'))
  removeAttribute(card, 'open')
  expect(stringify(tree, { syntax })).toMatchInlineSnapshot(`
    "<Card href="/b" {...rest} title={<Markdown inline children="**hi**" />}>x</Card>
    "
  `)
  const title = getAttribute(card, 'title')?.value
  expect(typeof title === 'object' && title?.data?.estree?.body[0]?.type).toBe('ExpressionStatement')
  expect(() => expression('a b')).toThrow()
})

test('flow JSX with only phrasing children stringifies inline and round-trips through unravel', () => {
  const processor = createProcessor({ syntax: [mdx()], transforms: [unravel], positions: false })
  const source = '<Note>Use `Note` for *info*.</Note>\n\n<Steps>\n  <Step>Run **it**.</Step>\n</Steps>\n'
  const tree = processor.parse(source) as Root
  expect(tree.children[0]!.type).toBe('mdxJsxFlowElement')
  const output = processor.stringify(tree)
  expect(output).toMatchInlineSnapshot(`
    "<Note>Use \`Note\` for *info*.</Note>

    <Steps>
      <Step>Run **it**.</Step>
    </Steps>
    "
  `)
  expect(processor.parse(output)).toEqual(tree)
})

test('mdx({ htmlComments: true }) parses <!-- --> as html nodes in flow and inline', () => {
  const source = [
    '<!-- top -->',
    '',
    'Text <!-- inline --> and `<!-- code -->`.',
    '',
    '<Note>',
    '  <!-- multi',
    '  line -->',
    '',
    '  Body.',
    '</Note>',
    '',
    '```md',
    '<!-- fenced -->',
    '```',
    '',
    '> <!-- quoted -->',
    '',
  ].join('\n')
  expect(parse(source, { syntax: [mdx()] })).toBeInstanceOf(MdxParseError)
  const syntax = [mdx({ htmlComments: true })]
  const tree = parse(source, { syntax, positions: false }) as Root
  const html: string[] = []
  visit(tree, 'html', (node) => void html.push(node.value))
  expect(html).toMatchInlineSnapshot(`
    [
      "<!-- top -->",
      "<!-- inline -->",
      "<!-- multi
    line -->",
      "<!-- quoted -->",
    ]
  `)
  const output = stringify(tree, { syntax })
  expect(output).toMatchInlineSnapshot(`
    "<!-- top -->

    Text <!-- inline --> and \`<!-- code -->\`.

    <Note>
      <!-- multi
      line -->

      Body.
    </Note>

    \`\`\`md
    <!-- fenced -->
    \`\`\`

    > <!-- quoted -->
    "
  `)
  expect(parse(output, { syntax, positions: false })).toEqual(tree)
})

test('htmlComments: an unclosed comment that starts a block runs to the end of its container', () => {
  const syntax = [mdx({ htmlComments: true })]
  const values = (source: string) => {
    const tree = parse(source, { syntax, positions: false })
    if (tree instanceof Error) return String(tree)
    const html: string[] = []
    visit(tree, 'html', (node) => void html.push(node.value))
    return { types: tree.children.map((node) => node.type), html }
  }
  expect(values('Before.\n\n<!-- unfinished\nhidden text\n')).toMatchInlineSnapshot(`
    {
      "html": [
        "<!-- unfinished
    hidden text",
      ],
      "types": [
        "paragraph",
        "html",
      ],
    }
  `)
  expect(values('> <!-- open\n> quoted\n\nAfter.\n')).toMatchInlineSnapshot(`
    {
      "html": [
        "<!-- open
    quoted",
      ],
      "types": [
        "blockquote",
        "paragraph",
      ],
    }
  `)
  expect(values('Inline <!-- open text\n')).toMatchInlineSnapshot(`"1:9: Unexpected character \`!\` (U+0021) before name, expected a character that can start a name, such as a letter, \`$\`, or \`_\` (note: to create a comment in MDX, use \`{/* text */}\`)"`)
})

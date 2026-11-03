// MDX syntax: JSX, `{expressions}` and ESM. Same defaults as micromark-extension-mdxjs.
import { Parser } from 'acorn'
import jsx from 'acorn-jsx'
import { visit } from './index.ts'
import type { MdxSyntax } from './syntax.ts'
import type {
  MdxFlowExpression,
  MdxJsxAttribute,
  MdxJsxAttributeValueExpression,
  MdxJsxFlowElement,
  MdxJsxTextElement,
  Nodes,
  Root,
  RootContent,
} from './types.ts'

const AcornJsx = /* @__PURE__ */ Parser.extend(jsx())

export interface MdxOptions {
  /** Attach `data.estree` to ESM, expressions and expression attributes. Default true. */
  estree?: boolean
  /**
   * Parse `<!-- comments -->` as `html` nodes, in flow and inline, instead of returning an error.
   * Off by default, because MDX has no HTML comments: remark-mdx rejects them. Use it for content
   * written as Markdown. Renderers that skip `html` nodes then drop the comments.
   */
  htmlComments?: boolean
}

export function mdx(options: MdxOptions = {}): MdxSyntax {
  return { name: 'mdx', acorn: AcornJsx, estree: options.estree ?? true, htmlComments: options.htmlComments ?? false }
}

/**
 * Unwrap paragraphs that hold only JSX elements, `{expressions}` and whitespace, and make those
 * children flow nodes: `<Card />` alone on a line becomes a block, not `<p><Card /></p>`.
 * Same as @mdx-js/mdx's remark-mark-and-unravel, without its `_mdxExplicitJsx` mark.
 * A transform: pass it to `createProcessor({ transforms: [unravel] })` or call it on a tree.
 */
export function unravel(tree: Root): void {
  visit(tree, (node, index, parent) => {
    if (!parent || index === undefined || node.type !== 'paragraph') return
    let oneOrMore = false
    for (const child of node.children) {
      if (child.type === 'mdxJsxTextElement' || child.type === 'mdxTextExpression') oneOrMore = true
      // collapse-white-space with `style: 'html', trim: true` leaves nothing
      else if (child.type !== 'text' || !/^[\t\n\f\r ]*$/.test(child.value)) return
    }
    if (!oneOrMore) return
    const unraveled: RootContent[] = []
    for (const child of node.children) {
      // Mutate the type in place, like upstream: the children are valid flow content too.
      if (child.type === 'mdxJsxTextElement') (child as unknown as MdxJsxFlowElement).type = 'mdxJsxFlowElement'
      else if (child.type === 'mdxTextExpression') (child as unknown as MdxFlowExpression).type = 'mdxFlowExpression'
      else if (child.type === 'text' && /^[\t\r\n ]+$/.test(child.value)) continue
      unraveled.push(child)
    }
    parent.children.splice(index, 1, ...(unraveled as typeof parent.children))
    return index
  })
}

// ── JSX helpers ─────────────────────────────────────────────────────────────

export type MdxJsxElement = MdxJsxFlowElement | MdxJsxTextElement

/** True for flow and text JSX elements. With `name`, only elements with that tag: `isJsx(node, 'Card')`. */
export function isJsx(node: Nodes, name?: string): node is MdxJsxElement {
  return (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && (name === undefined || node.name === name)
}

/**
 * The attribute named `name`, or undefined. Its `value` is a string for `a="x"`, null for a bare
 * `a`, and an expression for `a={x}`. Spread attributes (`{...props}`) are never returned.
 */
export function getAttribute(node: MdxJsxElement, name: string): MdxJsxAttribute | undefined {
  for (const attribute of node.attributes) {
    if (attribute.type === 'mdxJsxAttribute' && attribute.name === name) return attribute
  }
  return undefined
}

/** Set the value of `name`, or append the attribute. `null` writes a bare attribute: `<Accordion open>`. */
export function setAttribute(node: MdxJsxElement, name: string, value: MdxJsxAttribute['value']): void {
  const attribute = getAttribute(node, name)
  if (attribute) attribute.value = value
  else node.attributes.push({ type: 'mdxJsxAttribute', name, value })
}

/** Remove every attribute named `name`. */
export function removeAttribute(node: MdxJsxElement, name: string): void {
  node.attributes = node.attributes.filter((attribute) => attribute.type !== 'mdxJsxAttribute' || attribute.name !== name)
}

/**
 * An attribute value from JavaScript source, with `data.estree` like remark-mdx attaches:
 * `setAttribute(node, 'title', expression('<Markdown inline children={text} />'))`.
 * ESTree offsets are relative to `source`, since the node is not in a document yet.
 * Throws on invalid JavaScript: the source comes from code, not from a document.
 */
export function expression(source: string): MdxJsxAttributeValueExpression {
  const comments: any[] = []
  const parsed = AcornJsx.parseExpressionAt(source, 0, {
    ecmaVersion: 2024,
    sourceType: 'module',
    locations: true,
    ranges: true,
    onComment: comments,
  })
  if (source.slice(parsed.end).trim()) throw new SyntaxError(`Expected one expression, got: ${source}`)
  const program = {
    type: 'Program',
    start: 0,
    end: source.length,
    body: [{ type: 'ExpressionStatement', expression: parsed, start: 0, end: source.length }],
    sourceType: 'module',
    comments,
  }
  return { type: 'mdxJsxAttributeValueExpression', value: source, data: { estree: program as any } }
}

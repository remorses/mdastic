// MDX syntax: JSX, `{expressions}` and ESM. Same defaults as micromark-extension-mdxjs.
import { Parser } from 'acorn'
import jsx from 'acorn-jsx'
import { visit } from './index.ts'
import type { MdxSyntax } from './syntax.ts'
import type { MdxFlowExpression, MdxJsxFlowElement, Root, RootContent } from './types.ts'

const AcornJsx = /* @__PURE__ */ Parser.extend(jsx())

export function mdx(options: { estree?: boolean } = {}): MdxSyntax {
  return { name: 'mdx', acorn: AcornJsx, estree: options.estree ?? true }
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

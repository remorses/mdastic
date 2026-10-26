// Every mdast node type mdastic can produce, in one place. Shapes match @types/mdast plus the
// mdast-util-{gfm,mdx-jsx,mdx-expression,mdxjs-esm,frontmatter,math} augmentations exactly.
import type { Program } from 'estree'

export interface Point {
  line: number
  column: number
  offset: number
}

export interface Position {
  start: Point
  end: Point
}

export interface Data {
  [key: string]: unknown
}

interface NodeBase {
  position?: Position
  data?: Data
}

interface LiteralBase extends NodeBase {
  value: string
}

export type AlignType = 'left' | 'right' | 'center' | null
export type ReferenceType = 'shortcut' | 'collapsed' | 'full'

// ── Flow ────────────────────────────────────────────────────────────────────

export interface Root extends NodeBase {
  type: 'root'
  children: RootContent[]
}
export interface Paragraph extends NodeBase {
  type: 'paragraph'
  children: PhrasingContent[]
}
export interface Heading extends NodeBase {
  type: 'heading'
  depth: 1 | 2 | 3 | 4 | 5 | 6
  children: PhrasingContent[]
}
export interface ThematicBreak extends NodeBase {
  type: 'thematicBreak'
}
export interface Blockquote extends NodeBase {
  type: 'blockquote'
  children: FlowContent[]
}
export interface List extends NodeBase {
  type: 'list'
  ordered: boolean | null
  start: number | null
  spread: boolean | null
  children: ListItem[]
}
export interface ListItem extends NodeBase {
  type: 'listItem'
  spread: boolean | null
  checked?: boolean | null
  children: FlowContent[]
}
export interface Html extends LiteralBase {
  type: 'html'
}
export interface Code extends LiteralBase {
  type: 'code'
  lang: string | null
  meta: string | null
}
export interface Definition extends NodeBase {
  type: 'definition'
  identifier: string
  label: string | null
  url: string
  title: string | null
}

// ── Phrasing ───────────────────────────────────────────────────────────────

export interface Text extends LiteralBase {
  type: 'text'
}
export interface Emphasis extends NodeBase {
  type: 'emphasis'
  children: PhrasingContent[]
}
export interface Strong extends NodeBase {
  type: 'strong'
  children: PhrasingContent[]
}
export interface InlineCode extends LiteralBase {
  type: 'inlineCode'
}
export interface Break extends NodeBase {
  type: 'break'
}
export interface Link extends NodeBase {
  type: 'link'
  url: string
  title: string | null
  children: PhrasingContent[]
}
export interface Image extends NodeBase {
  type: 'image'
  url: string
  title: string | null
  alt: string | null
}
export interface LinkReference extends NodeBase {
  type: 'linkReference'
  identifier: string
  label: string | null
  referenceType: ReferenceType
  children: PhrasingContent[]
}
export interface ImageReference extends NodeBase {
  type: 'imageReference'
  identifier: string
  label: string | null
  referenceType: ReferenceType
  alt: string | null
}

// ── GFM ────────────────────────────────────────────────────────────────────

export interface Delete extends NodeBase {
  type: 'delete'
  children: PhrasingContent[]
}
export interface Table extends NodeBase {
  type: 'table'
  align: AlignType[] | null
  children: TableRow[]
}
export interface TableRow extends NodeBase {
  type: 'tableRow'
  children: TableCell[]
}
export interface TableCell extends NodeBase {
  type: 'tableCell'
  children: PhrasingContent[]
}
export interface FootnoteDefinition extends NodeBase {
  type: 'footnoteDefinition'
  identifier: string
  label: string | null
  children: FlowContent[]
}
export interface FootnoteReference extends NodeBase {
  type: 'footnoteReference'
  identifier: string
  label: string | null
}

// ── Frontmatter ────────────────────────────────────────────────────────────

export interface Yaml extends LiteralBase {
  type: 'yaml'
}
export interface Toml extends LiteralBase {
  type: 'toml'
}

// ── MDX ────────────────────────────────────────────────────────────────────

export interface MdxEstreeData extends Data {
  estree?: Program | null
}
export interface MdxjsEsm extends LiteralBase {
  type: 'mdxjsEsm'
  data?: MdxEstreeData
}
export interface MdxFlowExpression extends LiteralBase {
  type: 'mdxFlowExpression'
  data?: MdxEstreeData
}
export interface MdxTextExpression extends LiteralBase {
  type: 'mdxTextExpression'
  data?: MdxEstreeData
}
export interface MdxJsxAttributeValueExpression extends LiteralBase {
  type: 'mdxJsxAttributeValueExpression'
  data?: MdxEstreeData
}
export interface MdxJsxAttribute extends NodeBase {
  type: 'mdxJsxAttribute'
  name: string
  value?: MdxJsxAttributeValueExpression | string | null
}
export interface MdxJsxExpressionAttribute extends LiteralBase {
  type: 'mdxJsxExpressionAttribute'
  data?: MdxEstreeData
}
export interface MdxJsxFlowElement extends NodeBase {
  type: 'mdxJsxFlowElement'
  name: string | null
  attributes: (MdxJsxAttribute | MdxJsxExpressionAttribute)[]
  children: (FlowContent | PhrasingContent)[]
}
export interface MdxJsxTextElement extends NodeBase {
  type: 'mdxJsxTextElement'
  name: string | null
  attributes: (MdxJsxAttribute | MdxJsxExpressionAttribute)[]
  children: PhrasingContent[]
}

// ── Heading ids ({#id}) ───────────────────────────────────────────────────

export interface IdString extends NodeBase {
  type: 'idString'
  value: string
}

// ── Math ───────────────────────────────────────────────────────────────────

export interface MathData extends Data {
  hName?: string
  hProperties?: Record<string, unknown>
  hChildren?: unknown[]
}
export interface Math extends LiteralBase {
  type: 'math'
  meta?: string | null
  data?: MathData
}
export interface InlineMath extends LiteralBase {
  type: 'inlineMath'
  data?: MathData
}

// ── Unions ─────────────────────────────────────────────────────────────────

export type PhrasingContent =
  | Text | Emphasis | Strong | Delete | InlineCode | Break | Link | Image
  | LinkReference | ImageReference | FootnoteReference | Html
  | MdxJsxTextElement | MdxTextExpression | IdString | InlineMath

export type FlowContent =
  | Paragraph | Heading | ThematicBreak | Blockquote | List | Html | Code
  | Definition | Table | FootnoteDefinition
  | MdxJsxFlowElement | MdxFlowExpression | MdxjsEsm | Math

export type RootContent =
  | FlowContent | PhrasingContent | ListItem | TableRow | TableCell | Yaml | Toml

export type Nodes = Root | RootContent

export type Parents = Extract<Nodes, { children: unknown[] }>
export type Literals = Extract<Nodes, { value: string }>

export type NodeType = Nodes['type']
export type NodeOf<T extends NodeType> = Extract<Nodes, { type: T }>

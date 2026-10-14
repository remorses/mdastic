// Reusable structure-of-arrays arena; IDs link siblings without mdast allocations.
// Materialize ordinary mdast objects only after all parser passes finish.
import { position } from './scan.ts'
import type { Root, RootContent } from './types.ts'

export enum Kind {
  Root,
  Paragraph,
  Heading,
  ThematicBreak,
  Blockquote,
  List,
  ListItem,
  Html,
  Code,
  Definition,
  Text,
  Emphasis,
  Strong,
  InlineCode,
  Break,
  Link,
  Image,
  LinkReference,
  ImageReference,
  Delete,
  Table,
  TableRow,
  TableCell,
  FootnoteDefinition,
  FootnoteReference,
  Yaml,
  Toml,
  Mdx,
  IdString,
}

const parents = new Uint8Array(29)
for (const kind of [
  Kind.Root,
  Kind.Paragraph,
  Kind.Heading,
  Kind.Blockquote,
  Kind.List,
  Kind.ListItem,
  Kind.Emphasis,
  Kind.Strong,
  Kind.Link,
  Kind.LinkReference,
  Kind.Delete,
  Kind.Table,
  Kind.TableRow,
  Kind.TableCell,
  Kind.FootnoteDefinition,
])
  parents[kind] = 1
export const enum TaskState {
  None = 0,
  Unchecked = 1,
  Checked = 2,
}

// Index 0 is a defensive depth-1 fallback; parser-produced headings use indices 1..6.
const headingDepths = [1, 1, 2, 3, 4, 5, 6] as const
const values: (string | undefined)[] = []
const extras: any[] = []

const INITIAL_NODE_CAPACITY = 2048
let capacity = INITIAL_NODE_CAPACITY
// Node 0 is the null sentinel; the first allocated node is the root.
// child/last bound a sibling chain; next/prev link siblings, not parents.
// Payload contract (unused slots are zero):
// Kind                  a                       b                  extra
// Heading               depth                   unused             unused
// Paragraph             task cleanup pending    unused             position override
// List                  ordered flag            start number       spread boolean
// ListItem              spread flag             TaskState          unused
// MDX flow JSX          opening-tag end         closing-tag start  MDX fields
// Other MDX             unused                  unused             MDX fields
// Links / definitions   unused                  unused             named metadata
// Table                 unused                  unused             alignment array
export const tree = {
  count: 0,
  kind: new Uint8Array(capacity),
  start: new Int32Array(capacity),
  end: new Int32Array(capacity),
  child: new Int32Array(capacity),
  next: new Int32Array(capacity),
  prev: new Int32Array(capacity),
  last: new Int32Array(capacity),
  a: new Int32Array(capacity),
  b: new Int32Array(capacity),
  positionless: new Uint8Array(capacity),
  value: values,
  extra: extras,
}

export function resetTree(): void {
  // Clear logical contents, retaining typed-array capacity for the next document.
  tree.count = 0
  tree.value.length = 0
  tree.extra.length = 0
}

export function node(kind: Kind, start: number, end: number, parent = 0): number {
  const n = ++tree.count
  if (n >= capacity) {
    capacity *= 2
    const kinds = new Uint8Array(capacity)
    kinds.set(tree.kind)
    tree.kind = kinds
    const positionless = new Uint8Array(capacity)
    positionless.set(tree.positionless)
    tree.positionless = positionless
    for (const key of ['start', 'end', 'child', 'next', 'prev', 'last', 'a', 'b'] as const) {
      const old = tree[key]
      const grown = new Int32Array(capacity)
      grown.set(old)
      tree[key] = grown
    }
  }
  tree.kind[n] = kind
  tree.positionless[n] = 0
  tree.start[n] = start
  tree.end[n] = end
  tree.child[n] = tree.next[n] = tree.prev[n] = tree.last[n] = tree.a[n] = tree.b[n] = 0
  if (parent) append(parent, n)
  return n
}

export function append(parent: number, n: number): void {
  // Callers must detach n first; append does not repair its previous sibling chain.
  tree.prev[n] = tree.last[parent]
  if (tree.last[parent]) tree.next[tree.last[parent]] = n
  else tree.child[parent] = n
  tree.last[parent] = n
}

export function materialize(n: number): RootContent {
  // MDX metadata marks parent nodes; task cleanup may override the paragraph start.
  const children: any[] =
    parents[tree.kind[n]] || (tree.kind[n] === Kind.Mdx && tree.extra[n]?.children)
      ? []
      : undefined!
  for (let c = tree.child[n]; c; c = tree.next[c]) children.push(materialize(c))
  const value = tree.value[n] ?? ''
  const e = tree.extra[n]
  const p = tree.positionless[n]
    ? undefined
    : position(tree.start[n], tree.end[n], e?.positionStart)
  switch (tree.kind[n]) {
    // Omit absent positions entirely, rather than emitting position: undefined.
    case Kind.Mdx: {
      const result = { ...e }
      if (children) result.children = children
      if (p) result.position = p
      return result
    }
    case Kind.Paragraph:
      return p ? { type: 'paragraph', children, position: p } : { type: 'paragraph', children }
    case Kind.Heading:
      return p
        ? { type: 'heading', depth: headingDepths[tree.a[n]], children, position: p }
        : { type: 'heading', depth: headingDepths[tree.a[n]], children }
    case Kind.ThematicBreak:
      return p ? { type: 'thematicBreak', position: p } : { type: 'thematicBreak' }
    case Kind.Blockquote:
      return p
        ? { type: 'blockquote', children, position: p }
        : { type: 'blockquote', children }
    case Kind.List:
      return p
        ? {
            type: 'list',
            ordered: !!tree.a[n],
            start: tree.a[n] ? tree.b[n] : null,
            spread: !!e,
            children,
            position: p,
          }
        : {
            type: 'list',
            ordered: !!tree.a[n],
            start: tree.a[n] ? tree.b[n] : null,
            spread: !!e,
            children,
          }
    case Kind.ListItem:
      return p
        ? {
            type: 'listItem',
            spread: !!tree.a[n],
            checked: tree.b[n] ? tree.b[n] === TaskState.Checked : null,
            children,
            position: p,
          }
        : {
            type: 'listItem',
            spread: !!tree.a[n],
            checked: tree.b[n] ? tree.b[n] === TaskState.Checked : null,
            children,
          }
    case Kind.Html:
      return p ? { type: 'html', value, position: p } : { type: 'html', value }
    case Kind.Code:
      return p
        ? { type: 'code', lang: e?.lang ?? null, meta: e?.meta ?? null, value, position: p }
        : { type: 'code', lang: e?.lang ?? null, meta: e?.meta ?? null, value }
    case Kind.Definition:
      return p
        ? {
            type: 'definition',
            identifier: e.identifier,
            label: e.label,
            title: e.title,
            url: e.url,
            position: p,
          }
        : {
            type: 'definition',
            identifier: e.identifier,
            label: e.label,
            title: e.title,
            url: e.url,
          }
    case Kind.Text:
      return p ? { type: 'text', value, position: p } : { type: 'text', value }
    case Kind.IdString:
      return p ? { type: 'idString', value, position: p } : { type: 'idString', value }
    case Kind.Emphasis:
      return p ? { type: 'emphasis', children, position: p } : { type: 'emphasis', children }
    case Kind.Strong:
      return p ? { type: 'strong', children, position: p } : { type: 'strong', children }
    case Kind.InlineCode:
      return p ? { type: 'inlineCode', value, position: p } : { type: 'inlineCode', value }
    case Kind.Break:
      return p ? { type: 'break', position: p } : { type: 'break' }
    case Kind.Delete:
      return p ? { type: 'delete', children, position: p } : { type: 'delete', children }
    case Kind.Link:
      return p
        ? { type: 'link', title: e.title, url: e.url, children, position: p }
        : { type: 'link', title: e.title, url: e.url, children }
    case Kind.Image:
      return p
        ? { type: 'image', title: e.title, url: e.url, alt: value, position: p }
        : { type: 'image', title: e.title, url: e.url, alt: value }
    case Kind.LinkReference:
      return p
        ? {
            type: 'linkReference',
            children,
            position: p,
            label: e.label,
            identifier: e.identifier,
            referenceType: e.referenceType,
          }
        : {
            type: 'linkReference',
            children,
            label: e.label,
            identifier: e.identifier,
            referenceType: e.referenceType,
          }
    case Kind.ImageReference:
      return p
        ? {
            type: 'imageReference',
            alt: value,
            position: p,
            label: e.label,
            identifier: e.identifier,
            referenceType: e.referenceType,
          }
        : {
            type: 'imageReference',
            alt: value,
            label: e.label,
            identifier: e.identifier,
            referenceType: e.referenceType,
          }
    case Kind.Table:
      return p
        ? { type: 'table', align: e, children, position: p }
        : { type: 'table', align: e, children }
    case Kind.TableRow:
      return p ? { type: 'tableRow', children, position: p } : { type: 'tableRow', children }
    case Kind.TableCell:
      return p ? { type: 'tableCell', children, position: p } : { type: 'tableCell', children }
    case Kind.FootnoteDefinition:
      return p
        ? {
            type: 'footnoteDefinition',
            identifier: e.identifier,
            label: e.label,
            children,
            position: p,
          }
        : { type: 'footnoteDefinition', identifier: e.identifier, label: e.label, children }
    case Kind.FootnoteReference:
      return p
        ? { type: 'footnoteReference', identifier: e.identifier, label: e.label, position: p }
        : { type: 'footnoteReference', identifier: e.identifier, label: e.label }
    case Kind.Yaml:
      return p ? { type: 'yaml', value, position: p } : { type: 'yaml', value }
    case Kind.Toml:
      return p ? { type: 'toml', value, position: p } : { type: 'toml', value }
    default:
      throw new Error('Unknown parser node kind')
  }
}

export function materializeRoot(n: number): Root {
  const children: RootContent[] = []
  for (let c = tree.child[n]; c; c = tree.next[c]) children.push(materialize(c))
  const p = position(tree.start[n], tree.end[n])
  return p ? { type: 'root', children, position: p } : { type: 'root', children }
}

// Recognize inline {#id} before MDX expressions; positions cover only the ID value.
import type { HeadingIdSyntax } from './syntax.ts'
import { Char, decode } from './scan.ts'
import { offset, type View } from './inline.ts'
import { Kind, node, tree } from './tree.ts'

export type { HeadingIdSyntax } from './syntax.ts'

export function headingId(): HeadingIdSyntax {
  return { name: 'headingId' }
}

export function headingIdInline(view: View, start: number, end: number) {
  const source = view.source
  if (source.charCodeAt(start) !== Char.LeftBrace || source.charCodeAt(start + 1) !== Char.Hash)
    return
  for (let i = start + 2; i < end; i++) {
    const c = source.charCodeAt(i)
    if (
      c === Char.LineFeed ||
      c === Char.CarriageReturn ||
      c === Char.Backslash ||
      c === Char.LeftBrace
    )
      return
    if (c === Char.RightBrace) {
      const n = node(Kind.IdString, offset(view, start + 2), offset(view, i))
      tree.value[n] = decode(source.slice(start + 2, i))
      return { node: n, end: i + 1 }
    }
  }
}

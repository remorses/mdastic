import type { HeadingIdSyntax } from './syntax.ts'
import { decode } from './scan.ts'
import { offset, type View } from './inline.ts'
import { Kind, node, tree } from './tree.ts'

export type { HeadingIdSyntax } from './syntax.ts'

export function headingId(): HeadingIdSyntax {
  return { name: 'headingId' }
}

export function headingIdInline(view: View, start: number, end: number) {
  const source = view.source
  if (source.charCodeAt(start) !== 123 || source.charCodeAt(start + 1) !== 35) return
  for (let i = start + 2; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c === 10 || c === 13 || c === 92 || c === 123) return
    if (c === 125) {
      const n = node(Kind.IdString, offset(view, start + 2), offset(view, i))
      tree.value[n] = decode(source.slice(start + 2, i))
      return { node: n, end: i + 1 }
    }
  }
}

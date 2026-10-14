// GFM syntax: tables, strikethrough, footnotes, task lists, autolink literals.
import type { GfmSyntax } from './syntax.ts'

export function gfm(options: { singleTilde?: boolean } = {}): GfmSyntax {
  return { name: 'gfm', singleTilde: options.singleTilde ?? true }
}

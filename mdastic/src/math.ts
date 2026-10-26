// Math syntax: `$$` fenced blocks and `$`/`$$` inline spans, like remark-math. Off by default.
import type { MathSyntax } from './syntax.ts'

export type { MathSyntax } from './syntax.ts'

export function math(options: { singleDollarTextMath?: boolean } = {}): MathSyntax {
  return { name: 'math', singleDollarTextMath: options.singleDollarTextMath ?? true }
}

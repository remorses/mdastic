import type { MdxSyntax } from './syntax.ts'
import { MdxParseError } from './syntax.ts'
import { isWhitespace, point, space } from './scan.ts'
import { offset, type View } from './inline.ts'

const options = {
  ecmaVersion: 2024 as const,
  sourceType: 'module' as const,
  locations: true,
  preserveParens: true,
}

function empty(value: string): boolean {
  let start = 0
  let stripped = ''
  for (;;) {
    const open = value.indexOf('/*', start)
    if (open < 0) break
    const close = value.indexOf('*/', open + 2)
    if (close < 0) break
    stripped += value.slice(start, open)
    start = close + 2
  }
  if (start) value = stripped + value.slice(start)
  for (let i = 0; i < value.length;) {
    const c = value.charCodeAt(i)
    if (isWhitespace(c)) {
      i++
      continue
    }
    if (c !== 47) return false
    if (value.charCodeAt(i + 1) === 47) {
      i += 2
      while (i < value.length && value.charCodeAt(i) !== 10 && value.charCodeAt(i) !== 13) i++
      if (i === value.length) return false
    } else return false
  }
  return true
}

export function mdxError(
  reason: string,
  at: number,
  ruleId: string,
  source = 'micromark-extension-mdx-expression',
): never {
  throw new MdxParseError({ reason, place: point(at), ruleId, source })
}

function remap(value: any, map: (i: number) => number): void {
  if (!value || typeof value !== 'object') return
  if (typeof value.type === 'string' && typeof value.start === 'number') {
    const start = point(map(value.start))
    const end = point(map(value.end))
    value.start = start.offset
    value.end = end.offset
    value.loc = {
      start: { line: start.line, column: start.column - 1, offset: start.offset },
      end: { line: end.line, column: end.column - 1, offset: end.offset },
    }
    value.range = [start.offset, end.offset]
  }
  for (const key of Object.keys(value)) {
    if (key === 'loc' || key === 'range') continue
    const child = value[key]
    if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i++) {
        remap(child[i], map)
        if (child[i]?.type === 'ParenthesizedExpression') child[i] = child[i].expression
      }
    } else if (child && typeof child === 'object') {
      remap(child, map)
      if (child.type === 'ParenthesizedExpression') value[key] = child.expression
    }
  }
}

export function acornProgram(
  value: string,
  syntax: MdxSyntax,
  map: (i: number) => number,
  expression = false,
  spread = false,
  allowEmpty = true,
): { program?: any; error?: any; swallow?: boolean } {
  const comments: any[] = []
  const prefix = spread ? '({' : ''
  const suffix = spread ? '})' : ''
  const source = prefix + value + suffix
  const isEmpty = expression && empty(value)
  if (isEmpty && !allowEmpty)
    mdxError('Unexpected empty expression', map(0), 'unexpected-empty-expression')
  const mapped = (i: number) => map(Math.max(0, Math.min(value.length, i - prefix.length)))
  let program: any
  try {
    program =
      expression && !isEmpty
        ? syntax.acorn.parseExpressionAt(source, 0, { ...options, onComment: comments })
        : syntax.acorn.parse(source, { ...options, onComment: comments })
  } catch (error: any) {
    return {
      error: { cause: error, at: mapped(error.pos) },
      swallow:
        error.raisedAt >= prefix.length + value.length ||
        error.message.startsWith('Unterminated comment'),
    }
  }
  if (expression && !isEmpty) {
    if (!empty(source.slice(program.end, source.length - suffix.length)))
      return { error: { at: mapped(program.end) } }
    if (!syntax.estree && !spread) return { program }
    program = {
      type: 'Program',
      start: 0,
      end: prefix.length + value.length,
      body: [
        {
          type: 'ExpressionStatement',
          expression: program,
          start: 0,
          end: prefix.length + value.length,
        },
      ],
      sourceType: 'module',
      comments: [],
    }
  }
  program.comments = comments
  if (syntax.estree || spread || !expression) remap(program, mapped)
  if (spread) {
    const head = program.body[0]
    if (head.type !== 'ExpressionStatement' || head.expression.type !== 'ObjectExpression')
      mdxError(
        'Unexpected `' + head.type + '` in code: expected an object spread (`{...spread}`)',
        head.start,
        'non-spread',
      )
    const properties = head.expression.properties
    if (properties[1])
      mdxError(
        'Unexpected extra content in spread: only a single spread is supported',
        properties[1].start,
        'spread-extra',
      )
    if (properties[0] && properties[0].type !== 'SpreadElement')
      mdxError(
        'Unexpected `' + properties[0].type + '` in code: only spread elements are supported',
        properties[0].start,
        'non-spread',
      )
  }
  return { program }
}

// Acorn's tokenizer tracks strings, templates, regular expressions and JSX without parsing.
function candidate(source: string, start: number, syntax: MdxSyntax): number {
  try {
    const tokens = syntax.acorn.tokenizer(source.slice(start), options)
    let braces = 0
    for (;;) {
      const token = tokens.getToken()
      const label = token.type.label
      if (label === 'eof') return -1
      if (label === '{' || label === '${') braces++
      else if (label === '}') {
        if (!braces) return start + token.start
        braces--
      }
    }
  } catch {
    return -1
  }
}

interface Expression {
  end: number
  value: string
  data?: { estree: any }
}
const expressions = new WeakMap<View, Map<number, Expression>>()

export function expression(
  view: View,
  start: number,
  end: number,
  syntax: MdxSyntax,
  spread = false,
  allowEmpty = true,
): Expression {
  const key = start * 4 + (spread ? 2 : 0) + (allowEmpty ? 1 : 0)
  const cached = expressions.get(view)?.get(key)
  if (cached && cached.end <= end) return cached
  const source = view.source
  const predicted = candidate(source.slice(0, end), start + 1, syntax)
  let lastCrash: any
  const first = predicted >= 0 ? predicted : start + 1
  for (let close = first; close < end; close++) {
    if (source.charCodeAt(close) !== 125) continue
    const content = collect(view, start + 1, close, true)
    const parsed = content.virtual ? collect(view, start + 1, close, true, false) : content
    const result = acornProgram(parsed.value, syntax, parsed.map, true, spread, allowEmpty)
    if (result.program) {
      const match: Expression = { end: close + 1, value: content.value }
      if (syntax.estree) match.data = { estree: result.program }
      let cache = expressions.get(view)
      if (!cache) {
        cache = new Map()
        expressions.set(view, cache)
      }
      cache.set(key, match)
      return match
    }
    lastCrash = result.error
  }
  if (view.boundary !== undefined)
    mdxError(
      'Unexpected lazy line in expression in container, expected line to be prefixed with `>` when in a block quote, whitespace when in a list, etc',
      view.boundary,
      'unexpected-lazy',
    )
  if (lastCrash) mdxError('Could not parse expression with acorn', lastCrash.at, 'acorn')
  mdxError(
    'Unexpected end of file in expression, expected a corresponding closing brace for `{`',
    offset(view, end),
    'unexpected-eof',
  )
}

export function collect(
  view: View,
  start: number,
  end: number,
  strip: boolean,
  keepVirtual = true,
): { value: string; map: (i: number) => number; virtual: boolean } {
  const indices: number[] = []
  let value = ''
  let virtual = false
  let ending = offset(view, start)
  for (let i = start; i < end; i++) {
    if (view.lazy?.has(i))
      mdxError(
        'Unexpected lazy line in expression in container, expected line to be prefixed with `>` when in a block quote, whitespace when in a list, etc',
        offset(view, i),
        'unexpected-lazy',
      )
    const c = view.source.charCodeAt(i)
    indices.push(offset(view, i))
    value += view.source[i]
    ending = offset(view, i) + 1
    if (strip && (c === 10 || (c === 13 && view.source.charCodeAt(i + 1) !== 10))) {
      let size = 0
      while (i + 1 < end && space(view.source.charCodeAt(i + 1)) && size < 2) {
        const tab = view.source.charCodeAt(i + 1) === 9
        let width = 1
        if (tab) {
          let lineStart = i + 1
          while (
            lineStart > 0 &&
            view.source.charCodeAt(lineStart - 1) !== 10 &&
            view.source.charCodeAt(lineStart - 1) !== 13
          )
            lineStart--
          width = 4 - ((i + 1 - lineStart) % 4)
        }
        size += width
        i++
        if (size > 2) {
          virtual = true
          ending = offset(view, i) + 1
          // mdast retains virtual spaces; Acorn collection drops leading virtual spaces.
          if (keepVirtual) {
            value += ' '.repeat(size - 2)
            for (let k = 2; k < size; k++) indices.push(offset(view, i) + 1)
          }
        }
      }
    }
  }
  indices.push(ending)
  return { value, map: (i) => indices[i], virtual }
}

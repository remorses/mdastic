import type { MdxSyntax } from './syntax.ts'
import { MdxParseError } from './syntax.ts'
import { alpha, digit, entity, isWhitespace, point, position, space } from './scan.ts'
import { append, Kind, node, tree } from './tree.ts'
import { offset, type View } from './inline.ts'
import type { BlockContext, Line } from './block.ts'
import type { MdxJsxAttribute, MdxJsxExpressionAttribute } from './types.ts'
import { acornProgram, expression, mdxError } from './mdx-scan.ts'

interface Tag {
  type: 'tag'
  start: number
  end: number
  name: string | null
  attributes: (MdxJsxAttribute | MdxJsxExpressionAttribute)[]
  close: boolean
  selfClosing: boolean
}
const nameStart = (c: number) =>
  alpha(c) || c === 36 || c === 95 || (c > 127 && /\p{ID_Start}/u.test(String.fromCharCode(c)))
const nameContinue = (c: number) =>
  nameStart(c) ||
  digit(c) ||
  c === 45 ||
  (c > 127 && /\p{ID_Continue}/u.test(String.fromCharCode(c)))
const beforeName = 'a character that can start a name, such as a letter, `$`, or `_`'
const beforeAttribute =
  'a character that can start an attribute name, such as a letter, `$`, or `_`; whitespace before attributes; or the end of the tag'
const inName =
  'a name character such as letters, digits, `$`, or `_`; whitespace before attributes; or the end of the tag'
const inAttribute =
  'an attribute name character such as letters, digits, `$`, or `_`; `=` to initialize a value; whitespace before attributes; or the end of the tag'
const afterAttribute =
  'a character that can start an attribute name, such as a letter, `$`, or `_`; `=` to initialize a value; or the end of the tag'

function tag(view: View, start: number, end: number, syntax: MdxSyntax): Tag | undefined {
  const source = view.source
  if (
    space(source.charCodeAt(start + 1)) ||
    source.charCodeAt(start + 1) === 10 ||
    source.charCodeAt(start + 1) === 13
  )
    return
  let i = start + 1
  const checkLazy = () => {
    if (view.lazy?.has(i))
      mdxError(
        'Unexpected lazy line in container, expected line to be prefixed with `>` when in a block quote, whitespace when in a list, etc',
        offset(view, i),
        'unexpected-lazy',
        'micromark-extension-mdx-jsx',
      )
  }
  const skip = () => {
    while (i < end && isWhitespace(source.charCodeAt(i))) {
      checkLazy()
      i++
    }
    checkLazy()
  }
  const crash = (at: string, expected: string): never => {
    if (i >= end && view.boundary !== undefined)
      mdxError(
        'Unexpected lazy line in container, expected line to be prefixed with `>` when in a block quote, whitespace when in a list, etc',
        view.boundary,
        'unexpected-lazy',
        'micromark-extension-mdx-jsx',
      )
    const c = source.charCodeAt(i)
    const eof = i >= end
    const char = c === 96 ? '` ` `' : source[i]
    const reason =
      'Unexpected ' +
      (eof
        ? 'end of file'
        : 'character `' + char + '` (U+' + c.toString(16).toUpperCase().padStart(4, '0') + ')') +
      ' ' +
      at +
      ', expected ' +
      expected
    mdxError(
      reason,
      offset(view, i),
      eof ? 'unexpected-eof' : 'unexpected-character',
      'micromark-extension-mdx-jsx',
    )
  }
  skip()
  const close = source.charCodeAt(i) === 47
  if (close) {
    i++
    skip()
  }
  const readName = (mode: string, expected: string): string => {
    if (!nameStart(source.charCodeAt(i))) crash('before ' + mode, expected)
    const begin = i++
    while (i < end && nameContinue(source.charCodeAt(i))) i++
    return source.slice(begin, i)
  }
  let name: string | null = null
  if (source.charCodeAt(i) !== 62) {
    const c = source.charCodeAt(i)
    name = readName(
      'name',
      beforeName +
        (c === 33
          ? ' (note: to create a comment in MDX, use `{/* text */}`)'
          : close && (c === 42 || c === 47)
            ? ' (note: JS comments in JSX tags are not supported in MDX)'
            : ''),
    )
    let mode = 'name'
    for (;;) {
      const c = source.charCodeAt(i)
      if (
        !isWhitespace(c) &&
        ((c === 46 && mode === 'local name') ||
          (c === 58 && mode !== 'name') ||
          (c !== 46 && c !== 58 && c !== 47 && c !== 62 && c !== 123))
      )
        crash(
          'in ' + mode,
          inName +
            (c === 64 && mode !== 'local name'
              ? ' (note: to create a link in MDX, use `[text](url)`)'
              : ''),
        )
      skip()
      const separator = source.charCodeAt(i)
      if ((separator === 46 && mode !== 'local name') || (separator === 58 && mode === 'name')) {
        i++
        skip()
        mode = separator === 46 ? 'member name' : 'local name'
        name +=
          (separator === 46 ? '.' : ':') +
          readName(
            mode,
            separator === 46
              ? beforeAttribute
              : beforeName +
                  (source.charCodeAt(i) === 43 ||
                  (source.charCodeAt(i) > 46 && source.charCodeAt(i) < 58)
                    ? ' (note: to create a link in MDX, use `[text](url)`)'
                    : ''),
          )
        continue
      }
      if (separator !== 47 && separator !== 62 && separator !== 123 && !nameStart(separator))
        crash('after ' + mode, beforeAttribute)
      break
    }
  }
  const attributes: Tag['attributes'] = []
  let selfClosing = false
  while (i < end && source.charCodeAt(i) !== 62) {
    skip()
    const c = source.charCodeAt(i)
    if (c === 62) break
    if (c === 47) {
      if (close)
        mdxError(
          'Unexpected self-closing slash `/` in closing tag, expected the end of the tag',
          offset(view, i),
          'unexpected-self-closing-slash',
          'mdast-util-mdx-jsx',
        )
      selfClosing = true
      i++
      skip()
      if (source.charCodeAt(i) !== 62)
        crash(
          'after self-closing slash',
          '`>` to end the tag' +
            (source.charCodeAt(i) === 42 || source.charCodeAt(i) === 47
              ? ' (note: JS comments in JSX tags are not supported in MDX)'
              : ''),
        )
      break
    }
    const attributeStart = i
    if (close)
      mdxError(
        'Unexpected attribute in closing tag, expected the end of the tag',
        offset(view, i),
        'unexpected-attribute',
        'mdast-util-mdx-jsx',
      )
    if (c === 123) {
      const result = expression(view, i, end, syntax, true, false)
      i = result.end
      const attribute: MdxJsxExpressionAttribute = {
        type: 'mdxJsxExpressionAttribute',
        value: result.value,
      }
      if (result.data) attribute.data = result.data
      const p = position(offset(view, attributeStart), offset(view, i))
      if (p) attribute.position = p
      attributes.push(attribute)
      continue
    }
    let attributeName = readName('attribute name', beforeAttribute)
    let local = false
    const after = source.charCodeAt(i)
    if (
      !isWhitespace(after) &&
      after !== 47 &&
      after !== 58 &&
      after !== 61 &&
      after !== 62 &&
      after !== 123
    )
      crash('in attribute name', inAttribute)
    let attributeEnd = i
    skip()
    if (source.charCodeAt(i) === 58) {
      local = true
      i++
      skip()
      attributeName += ':' + readName('local attribute name', afterAttribute)
      attributeEnd = i
      const c = source.charCodeAt(i)
      if (!isWhitespace(c) && c !== 47 && c !== 61 && c !== 62 && c !== 123)
        crash('in local attribute name', inAttribute)
      skip()
    }
    let value: MdxJsxAttribute['value'] = null
    if (source.charCodeAt(i) === 61) {
      i++
      skip()
      const quote = source.charCodeAt(i)
      if (quote === 34 || quote === 39) {
        i++
        value = ''
        while (i < end && source.charCodeAt(i) !== quote) {
          checkLazy()
          const c = source.charCodeAt(i)
          if (c === 38) {
            const ref = entity(source, i, end)
            if (ref) {
              value += ref.value
              i = ref.end
              continue
            }
          }
          value += source[i++]
          if (c === 10 || (c === 13 && source.charCodeAt(i) !== 10))
            while (space(source.charCodeAt(i))) i++
        }
        if (i >= end)
          crash(
            'in attribute value',
            'a corresponding closing quote `' + String.fromCharCode(quote) + '`',
          )
        i++
        attributeEnd = i
      } else if (quote === 123) {
        const result = expression(view, i, end, syntax, false, false)
        value = { type: 'mdxJsxAttributeValueExpression', value: result.value }
        if (result.data) value.data = result.data
        i = attributeEnd = result.end
      } else
        crash(
          'before attribute value',
          'a character that can start an attribute value, such as `"`, `\'`, or `{`' +
            (quote === 60
              ? ' (note: to use an element or fragment as a prop value in MDX, use `{<element />}`)'
              : ''),
        )
    } else if (
      source.charCodeAt(i) !== 47 &&
      source.charCodeAt(i) !== 62 &&
      source.charCodeAt(i) !== 123 &&
      !nameStart(source.charCodeAt(i))
    )
      crash(local ? 'after local attribute name' : 'after attribute name', afterAttribute)
    const p = position(offset(view, attributeStart), offset(view, attributeEnd))
    const attribute: MdxJsxAttribute = { type: 'mdxJsxAttribute', name: attributeName, value }
    if (p) attribute.position = p
    attributes.push(attribute)
    skip()
  }
  if (i >= end)
    crash(
      name === null ? 'before name' : 'before attribute name',
      name === null ? beforeName : beforeAttribute,
    )
  return { type: 'tag', start, end: i + 1, name, attributes, close, selfClosing }
}

function abbreviated(tag: Tag, closing = tag.close): string {
  return '<' + (closing ? '/' : '') + (tag.name ?? '') + '>'
}
function location(start: number, end?: number): string {
  const p = point(start)
  const q = end === undefined ? undefined : point(end)
  return p.line + ':' + p.column + (q ? '-' + q.line + ':' + q.column : '')
}

export function mdxHooks(source: string, syntax: MdxSyntax) {
  const rawView: View = { source, base: 0 }
  const stacks = new Map<number, { tag: Tag; node: number }[]>()
  const imports: string[] = []
  const views = new WeakMap<Line[], { view: View; starts: Int32Array }>()
  const current = (parent: number) => stacks.get(parent)?.at(-1)?.node ?? parent
  function flowView(input: Line[], boundary?: Line): { view: View; starts: Int32Array } {
    const cached = views.get(input)
    if (cached) return cached
    const starts = new Int32Array(input.length)
    let length = 0
    let contiguous = true
    for (let j = 0; j < input.length; j++) {
      starts[j] = length
      length += input[j].next - input[j].start
      if (j && input[j].start !== input[j - 1].next) contiguous = false
    }
    const lazy = new Set<number>()
    for (let j = 0; j < input.length; j++) if (input[j].lazy) lazy.add(starts[j])
    let view: View
    if (contiguous)
      view =
        input[0].start === 0 && input.at(-1)!.next === source.length
          ? rawView
          : { source: source.slice(input[0].start, input.at(-1)!.next), base: input[0].start, lazy }
    else {
      const map = new Int32Array(length + 1)
      const chunks: string[] = []
      let k = 0
      for (const line of input) {
        chunks.push(source.slice(line.start, line.next))
        for (let i = line.start; i < line.next; i++) map[k++] = i
      }
      map[k] = input.at(-1)!.next
      view = { source: chunks.join(''), base: 0, map, lazy }
    }
    if (boundary && !source.slice(boundary.start, boundary.end).trimStart().startsWith('>'))
      view.boundary = boundary.start
    const result = { view, starts }
    views.set(input, result)
    return result
  }
  function mismatch(closing: Tag, open: Tag | undefined, view: View): never {
    if (open)
      mdxError(
        'Unexpected closing tag `' +
          abbreviated(closing) +
          '`, expected corresponding closing tag for `' +
          abbreviated(open, false) +
          '` (' +
          location(open.start, open.end) +
          ')',
        offset(view, closing.start),
        'end-tag-mismatch',
        'mdast-util-mdx-jsx',
      )
    mdxError(
      'Unexpected closing slash `/` in tag, expected an open tag first',
      offset(view, closing.start + 1),
      'unexpected-closing-slash',
      'mdast-util-mdx-jsx',
    )
  }
  function inline(
    view: View,
    start: number,
    end: number,
  ): { end: number; node: number } | undefined {
    const c = view.source.charCodeAt(start)
    if (c === 123) {
      const result = expression(view, start, end, syntax)
      const n = node(Kind.Mdx, offset(view, start), offset(view, result.end))
      tree.extra[n] = { type: 'mdxTextExpression', value: result.value }
      if (result.data) tree.extra[n].data = result.data
      return { end: result.end, node: n }
    }
    if (c !== 60) return
    const opening = tag(view, start, end, syntax)
    if (!opening) return
    const n = node(Kind.Mdx, offset(view, start), offset(view, opening.end))
    tree.extra[n] = {
      type: 'mdxJsxTextElement',
      name: opening.name,
      attributes: opening.attributes,
      children: [],
      tag: { ...opening, start: offset(view, opening.start), end: offset(view, opening.end) },
    }
    return { end: opening.end, node: n }
  }
  function flow(
    context: BlockContext,
    input: Line[],
    at: number,
    parent: number,
    boundary?: Line,
  ): number {
    const line = input[at]
    let begin = line.start
    while (space(source.charCodeAt(begin))) begin++
    if (
      begin === line.start &&
      point(begin).column === 1 &&
      (source.startsWith('import ', begin) || source.startsWith('export ', begin))
    ) {
      let j = at
      for (;;) {
        while (j + 1 < input.length && source.slice(input[j + 1].start, input[j + 1].end).trim())
          j++
        const end = input[j].end
        const value = source.slice(begin, end)
        const prefix = imports.length ? 'var ' + imports.join(',') + '\n' : ''
        const result = acornProgram(
          prefix + value,
          syntax,
          (i) => begin + Math.max(0, i - prefix.length),
        )
        if (!result.program) {
          if (j + 1 < input.length && result.swallow) {
            j++
            continue
          }
          mdxError(
            'Could not parse import/exports with acorn',
            result.error.at,
            'acorn',
            'micromark-extension-mdxjs-esm',
          )
        }
        const program = result.program
        if (prefix) program.body.shift()
        for (const statement of program.body) {
          if (
            ![
              'ExportAllDeclaration',
              'ExportDefaultDeclaration',
              'ExportNamedDeclaration',
              'ImportDeclaration',
            ].includes(statement.type)
          )
            mdxError(
              'Unexpected `' + statement.type + '` in code: only import/exports are supported',
              statement.start,
              'non-esm',
              'micromark-extension-mdxjs-esm',
            )
          if (statement.type === 'ImportDeclaration')
            for (const specifier of statement.specifiers) imports.push(specifier.local.name)
        }
        const n = node(Kind.Mdx, begin, end, current(parent))
        tree.extra[n] = { type: 'mdxjsEsm', value }
        if (syntax.estree) tree.extra[n].data = { estree: program }
        return j - at + 1
      }
    }
    if (source.charCodeAt(begin) !== 60 && source.charCodeAt(begin) !== 123) return 0
    const mapped = flowView(input, boundary)
    const view = mapped.view
    const text = view.source
    const found: (
      | Tag
      | { type: 'expression'; start: number; end: number; result: ReturnType<typeof expression> }
    )[] = []
    let i = mapped.starts[at] + begin - line.start
    for (;;) {
      const c = text.charCodeAt(i)
      if (c === 60) {
        const t = tag(view, i, text.length, syntax)
        if (!t) return 0
        found.push(t)
        i = t.end
      } else if (c === 123) {
        const result = expression(view, i, text.length, syntax)
        found.push({ type: 'expression', start: i, end: result.end, result })
        i = result.end
      } else return 0
      while (space(text.charCodeAt(i))) i++
      if (i >= text.length || text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13) break
      if (text.charCodeAt(i) === 123 && found.at(-1)!.type === 'expression') return 0
      if (text.charCodeAt(i) !== 60 && text.charCodeAt(i) !== 123) return 0
    }
    for (const item of found) {
      if (item.type === 'expression') {
        const n = node(Kind.Mdx, offset(view, item.start), offset(view, item.end), current(parent))
        tree.extra[n] = { type: 'mdxFlowExpression', value: item.result.value }
        if (item.result.data) tree.extra[n].data = item.result.data
        continue
      }
      const stack = stacks.get(parent) ?? []
      stacks.set(parent, stack)
      if (item.close) {
        const open = stack.at(-1)
        if (!open) {
          const n = node(
            Kind.Mdx,
            offset(view, item.start),
            offset(view, item.end),
            current(parent),
          )
          tree.extra[n] = {
            type: 'mdxJsxFlowElement',
            name: item.name,
            attributes: [],
            children: [],
            tag: { ...item, start: offset(view, item.start), end: offset(view, item.end) },
          }
          continue
        }
        if (open.tag.name !== item.name) mismatch(item, open.tag, view)
        tree.end[open.node] = offset(view, item.end)
        tree.b[open.node] = offset(view, item.start)
        stack.pop()
      } else {
        const n = node(Kind.Mdx, offset(view, item.start), offset(view, item.end), current(parent))
        tree.a[n] = offset(view, item.end)
        tree.extra[n] = {
          type: 'mdxJsxFlowElement',
          name: item.name,
          attributes: item.attributes,
          children: [],
        }
        if (!item.selfClosing)
          stack.push({
            node: n,
            tag: { ...item, start: offset(view, item.start), end: offset(view, item.end) },
          })
      }
    }
    const ending = offset(view, i)
    let j = at
    while (j < input.length && input[j].end < ending) j++
    return j - at + 1
  }
  return {
    inline,
    flow,
    flowParent: current,
    interrupt(line: Line) {
      let i = line.start
      while (space(source.charCodeAt(i))) i++
      if (source.charCodeAt(i) !== 60 && source.charCodeAt(i) !== 123) return false
      // Only complete tag/expression-only lines interrupt a paragraph.
      try {
        const view = rawView
        let previousExpression = false
        for (;;) {
          const c = source.charCodeAt(i)
          if (c === 123 && previousExpression) return false
          const end =
            c === 60
              ? tag(view, i, source.length, syntax)?.end
              : c === 123
                ? expression(view, i, source.length, syntax).end
                : undefined
          if (end === undefined) return false
          previousExpression = c === 123
          i = end
          while (space(source.charCodeAt(i))) i++
          if (i >= source.length || source.charCodeAt(i) === 10 || source.charCodeAt(i) === 13)
            return true
        }
      } catch {
        return true
      }
    },
    continuationEnd(line: Line) {
      let i = line.start
      while (space(source.charCodeAt(i))) i++
      if (source.charCodeAt(i) !== 60 && source.charCodeAt(i) !== 123) return line.end
      const view = rawView
      try {
        return source.charCodeAt(i) === 60
          ? (tag(view, i, source.length, syntax)?.end ?? line.end)
          : expression(view, i, source.length, syntax).end
      } catch {
        return line.end
      }
    },
    finish() {
      const types: Partial<Record<Kind, string>> = {
        [Kind.Root]: 'root',
        [Kind.Paragraph]: 'paragraph',
        [Kind.Heading]: 'heading',
        [Kind.Blockquote]: 'blockQuote',
        [Kind.List]: 'list',
        [Kind.ListItem]: 'listItem',
        [Kind.Emphasis]: 'emphasis',
        [Kind.Strong]: 'strong',
        [Kind.Delete]: 'delete',
        [Kind.Link]: 'link',
        [Kind.LinkReference]: 'linkReference',
        [Kind.Image]: 'image',
        [Kind.ImageReference]: 'imageReference',
      }
      function resolve(parent: number, active?: Tag): void {
        const pending: { tag: Tag; node: number }[] = []
        const children: number[] = []
        for (let n = tree.child[parent]; n; n = tree.next[n]) children.push(n)
        tree.child[parent] = tree.last[parent] = 0
        for (const n of children) {
          tree.next[n] = tree.prev[n] = 0
          const e = tree.extra[n]
          const t: Tag | undefined = e?.tag
          if (t) {
            delete e.tag
            if (t.close) {
              const open = pending.at(-1)
              if (!open) {
                if (active) {
                  const type = types[tree.kind[parent]] ?? 'paragraph'
                  mdxError(
                    'Expected the closing tag `' +
                      abbreviated(t) +
                      '` either after the end of `' +
                      type +
                      '` (' +
                      location(tree.end[parent]) +
                      ') or another opening tag after the start of `' +
                      type +
                      '` (' +
                      location(tree.start[parent]) +
                      ')',
                    t.start,
                    'end-tag-mismatch',
                    'mdast-util-mdx-jsx',
                  )
                }
                mismatch(t, undefined, { source, base: 0 })
              }
              if (open.tag.name !== t.name) mismatch(t, open.tag, { source, base: 0 })
              tree.end[open.node] = t.end
              pending.pop()
            } else {
              append(pending.at(-1)?.node ?? parent, n)
              if (!t.selfClosing) pending.push({ tag: t, node: n })
            }
          } else {
            const enclosing = pending.at(-1)?.tag ?? active
            const flowTag: Tag | undefined =
              e?.type === 'mdxJsxFlowElement'
                ? {
                    type: 'tag',
                    start: tree.start[n],
                    end: tree.end[n],
                    name: e.name,
                    attributes: e.attributes,
                    close: false,
                    selfClosing: false,
                  }
                : undefined
            if (tree.child[n]) resolve(n, flowTag ?? enclosing)
            if (tree.kind[n] === Kind.Image || tree.kind[n] === Kind.ImageReference) {
              function alt(parent: number): string {
                let value = ''
                for (let c = tree.child[parent]; c; c = tree.next[c])
                  value +=
                    tree.value[c] ??
                    (tree.extra[c]?.type === 'mdxTextExpression' ? tree.extra[c].value : alt(c))
                return value
              }
              tree.value[n] = alt(n)
              tree.child[n] = tree.last[n] = 0
            }
            append(pending.at(-1)?.node ?? parent, n)
          }
        }
        const open = pending.at(-1)
        if (open)
          mdxError(
            'Expected a closing tag for `' +
              abbreviated(open.tag, false) +
              '` (' +
              location(open.tag.start, open.tag.end) +
              ') before the end of `' +
              (types[tree.kind[parent]] ?? 'paragraph') +
              '`',
            tree.start[parent],
            'end-tag-mismatch',
            'mdast-util-mdx-jsx',
          )
        const flowOpen = stacks.get(parent)?.at(-1)
        if (flowOpen) {
          const reason =
            'Expected a closing tag for `' +
            abbreviated(flowOpen.tag, false) +
            '` (' +
            location(flowOpen.tag.start, flowOpen.tag.end) +
            ')'
          if (tree.kind[parent] === Kind.Root)
            throw new MdxParseError({
              reason,
              ruleId: 'end-tag-mismatch',
              source: 'mdast-util-mdx-jsx',
            })
          mdxError(
            reason +
              ' before the end of `' +
              (types[tree.kind[parent]] ?? 'footnoteDefinition') +
              '`',
            tree.start[parent],
            'end-tag-mismatch',
            'mdast-util-mdx-jsx',
          )
        }
      }
      resolve(1)
    },
  }
}

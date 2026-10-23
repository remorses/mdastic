// MDX hooks scan JSX, attributes and ESM, then resolve deferred JSX nesting.
// Inline tags remain tokens until Markdown links and attention have resolved.
import type { MdxSyntax } from './syntax.ts'
import { MdxParseError } from './syntax.ts'
import { alpha, Char, digit, entity, isWhitespace, point, position, space } from './scan.ts'
import { append, Kind, node, tree } from './tree.ts'
import { offset, type View } from './inline.ts'
import { blank, type BlockContext, type Line, startsContainer } from './block.ts'
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
  alpha(c) ||
  c === Char.Dollar ||
  c === Char.Underscore ||
  (c > Char.Delete && /\p{ID_Start}/u.test(String.fromCharCode(c)))
const nameContinue = (c: number) =>
  nameStart(c) ||
  digit(c) ||
  c === Char.Hyphen ||
  (c > Char.Delete && /\p{ID_Continue}/u.test(String.fromCharCode(c)))
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
  // ── Cursor helpers retain the exact upstream diagnostic wording ──
  const source = view.source
  if (
    space(source.charCodeAt(start + 1)) ||
    source.charCodeAt(start + 1) === Char.LineFeed ||
    source.charCodeAt(start + 1) === Char.CarriageReturn
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
    const char = c === Char.Backtick ? '` ` `' : source[i]
    const reason =
      'Unexpected ' +
      (eof
        ? 'end of file'
        : 'character `' +
          char +
          '` (U+' +
          c.toString(16).toUpperCase().padStart(4, '0') +
          ')') +
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
  // ── Opening/closing prefix, then qualified element name ──
  skip()
  const close = source.charCodeAt(i) === Char.Slash
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
  if (source.charCodeAt(i) !== Char.GreaterThan) {
    const c = source.charCodeAt(i)
    name = readName(
      'name',
      beforeName +
        (c === Char.Exclamation
          ? ' (note: to create a comment in MDX, use `{/* text */}`)'
          : close && (c === Char.Asterisk || c === Char.Slash)
            ? ' (note: JS comments in JSX tags are not supported in MDX)'
            : ''),
    )
    // Member names allow dots; namespace local names cannot continue with dots or colons.
    let mode = 'name'
    for (;;) {
      const c = source.charCodeAt(i)
      if (
        !isWhitespace(c) &&
        ((c === Char.Dot && mode === 'local name') ||
          (c === Char.Colon && mode !== 'name') ||
          (c !== Char.Dot &&
            c !== Char.Colon &&
            c !== Char.Slash &&
            c !== Char.GreaterThan &&
            c !== Char.LeftBrace))
      )
        crash(
          'in ' + mode,
          inName +
            (c === Char.At && mode !== 'local name'
              ? ' (note: to create a link in MDX, use `[text](url)`)'
              : ''),
        )
      skip()
      const separator = source.charCodeAt(i)
      if (
        (separator === Char.Dot && mode !== 'local name') ||
        (separator === Char.Colon && mode === 'name')
      ) {
        i++
        skip()
        mode = separator === Char.Dot ? 'member name' : 'local name'
        name +=
          (separator === Char.Dot ? '.' : ':') +
          readName(
            mode,
            separator === Char.Dot
              ? beforeAttribute
              : beforeName +
                  (source.charCodeAt(i) === Char.Plus ||
                  (source.charCodeAt(i) > Char.Dot && source.charCodeAt(i) < Char.Colon)
                    ? ' (note: to create a link in MDX, use `[text](url)`)'
                    : ''),
          )
        continue
      }
      if (
        separator !== Char.Slash &&
        separator !== Char.GreaterThan &&
        separator !== Char.LeftBrace &&
        !nameStart(separator)
      )
        crash('after ' + mode, beforeAttribute)
      break
    }
  }
  // ── Attributes and the optional self-closing suffix ──
  const attributes: Tag['attributes'] = []
  let selfClosing = false
  while (i < end && source.charCodeAt(i) !== Char.GreaterThan) {
    skip()
    const c = source.charCodeAt(i)
    if (c === Char.GreaterThan) break
    if (c === Char.Slash) {
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
      if (source.charCodeAt(i) !== Char.GreaterThan)
        crash(
          'after self-closing slash',
          '`>` to end the tag' +
            (source.charCodeAt(i) === Char.Asterisk || source.charCodeAt(i) === Char.Slash
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
    if (c === Char.LeftBrace) {
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
      after !== Char.Slash &&
      after !== Char.Colon &&
      after !== Char.Equals &&
      after !== Char.GreaterThan &&
      after !== Char.LeftBrace
    )
      crash('in attribute name', inAttribute)
    let attributeEnd = i
    skip()
    if (source.charCodeAt(i) === Char.Colon) {
      local = true
      i++
      skip()
      attributeName += ':' + readName('local attribute name', afterAttribute)
      attributeEnd = i
      const c = source.charCodeAt(i)
      if (
        !isWhitespace(c) &&
        c !== Char.Slash &&
        c !== Char.Equals &&
        c !== Char.GreaterThan &&
        c !== Char.LeftBrace
      )
        crash('in local attribute name', inAttribute)
      skip()
    }
    let value: MdxJsxAttribute['value'] = null
    if (source.charCodeAt(i) === Char.Equals) {
      i++
      skip()
      const quote = source.charCodeAt(i)
      if (quote === Char.DoubleQuote || quote === Char.SingleQuote) {
        i++
        value = ''
        // Quoted JSX values decode entities and remove continuation indentation.
        while (i < end && source.charCodeAt(i) !== quote) {
          checkLazy()
          const c = source.charCodeAt(i)
          if (c === Char.Ampersand) {
            const ref = entity(source, i, end)
            if (ref) {
              value += ref.value
              i = ref.end
              continue
            }
          }
          value += source[i++]
          if (
            c === Char.LineFeed ||
            (c === Char.CarriageReturn && source.charCodeAt(i) !== Char.LineFeed)
          ) {
            // Continuation indentation is any whitespace, skipped after the lazy check.
            checkLazy()
            while (
              isWhitespace(source.charCodeAt(i)) &&
              source.charCodeAt(i) !== Char.LineFeed &&
              source.charCodeAt(i) !== Char.CarriageReturn
            )
              i++
          }
        }
        if (i >= end)
          crash(
            'in attribute value',
            'a corresponding closing quote `' + String.fromCharCode(quote) + '`',
          )
        i++
        attributeEnd = i
      } else if (quote === Char.LeftBrace) {
        const result = expression(view, i, end, syntax, false, false)
        value = { type: 'mdxJsxAttributeValueExpression', value: result.value }
        if (result.data) value.data = result.data
        i = attributeEnd = result.end
      } else
        crash(
          'before attribute value',
          'a character that can start an attribute value, such as `"`, `\'`, or `{`' +
            (quote === Char.LessThan
              ? ' (note: to use an element or fragment as a prop value in MDX, use `{<element />}`)'
              : ''),
        )
    } else if (
      source.charCodeAt(i) !== Char.Slash &&
      source.charCodeAt(i) !== Char.GreaterThan &&
      source.charCodeAt(i) !== Char.LeftBrace &&
      !nameStart(source.charCodeAt(i))
    )
      crash(local ? 'after local attribute name' : 'after attribute name', afterAttribute)
    const p = position(offset(view, attributeStart), offset(view, attributeEnd))
    const attribute: MdxJsxAttribute = { type: 'mdxJsxAttribute', name: attributeName, value }
    if (p) attribute.position = p
    attributes.push(attribute)
    skip()
  }
  // ── Require a complete closing angle before committing the tag ──
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

function imageAlt(parent: number): string {
  let value = ''
  for (let c = tree.child[parent]; c; c = tree.next[c])
    value +=
      tree.value[c] ??
      (tree.extra[c]?.type === 'mdxTextExpression' ? tree.extra[c].value : imageAlt(c))
  return value
}

export function mdxHooks(source: string, syntax: MdxSyntax) {
  // Per-document stacks/imports and cached container views never escape this closure.
  const rawView: View = { source, base: 0 }
  const stacks = new Map<number, { tag: Tag; node: number }[]>()
  const imports: string[] = []
  const views = new WeakMap<Line[], { view: View; starts: Int32Array }>()
  const current = (parent: number) => stacks.get(parent)?.at(-1)?.node ?? parent
  // mdast-util-mdx-jsx reports tag mismatches after micromark tokenized the whole document.
  let mismatched: (() => never) | undefined
  function flowView(
    context: BlockContext,
    input: Line[],
    boundary?: Line,
  ): { view: View; starts: Int32Array } {
    // Cache the remaining container once, rather than rebuilding it for each flow tag.
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
          : {
              source: source.slice(input[0].start, input.at(-1)!.next),
              base: input[0].start,
              lazy,
            }
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
    // A line that starts a new container ends the flow; any other next line is lazy.
    if (boundary && !startsContainer(context, boundary)) view.boundary = boundary.start
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
    // Tags are temporary tokens; finish() checks nesting after Markdown resolves spans.
    const c = view.source.charCodeAt(start)
    if (c === Char.LeftBrace) {
      const result = expression(view, start, end, syntax)
      const n = node(Kind.Mdx, offset(view, start), offset(view, result.end))
      tree.extra[n] = { type: 'mdxTextExpression', value: result.value }
      if (result.data) tree.extra[n].data = result.data
      return { end: result.end, node: n }
    }
    if (c !== Char.LessThan) return
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
  function parseEsmFlow(input: Line[], at: number, begin: number, parent: number): number {
    let j = at
    // Incomplete ESM retries another blank-delimited chunk, not every source line.
    for (;;) {
      while (j + 1 < input.length && !blank(source, input[j + 1])) j++
      const end = input[j].end
      const value = source.slice(begin, end)
      // Prior imports satisfy Acorn scope validation; remove this declaration afterward.
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
  function esm(line: Line): boolean {
    return (
      (source.startsWith('import ', line.start) || source.startsWith('export ', line.start)) &&
      point(line.start).column === 1
    )
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
    if (esm(line)) return parseEsmFlow(input, at, begin, parent)
    if (
      source.charCodeAt(begin) !== Char.LessThan &&
      source.charCodeAt(begin) !== Char.LeftBrace
    )
      return 0
    // ── Probe a line containing only qualifying tags/expressions ──
    const mapped = flowView(context, input, boundary)
    const view = mapped.view
    const text = view.source
    const found: (
      | Tag
      | {
          type: 'expression'
          start: number
          end: number
          result: ReturnType<typeof expression>
        }
    )[] = []
    let i = mapped.starts[at] + begin - line.start
    for (;;) {
      const c = text.charCodeAt(i)
      if (c === Char.LessThan) {
        const t = tag(view, i, text.length, syntax)
        if (!t) return 0
        found.push(t)
        i = t.end
      } else if (c === Char.LeftBrace) {
        const result = expression(view, i, text.length, syntax)
        found.push({ type: 'expression', start: i, end: result.end, result })
        i = result.end
      } else return 0
      while (space(text.charCodeAt(i))) i++
      if (
        i >= text.length ||
        text.charCodeAt(i) === Char.LineFeed ||
        text.charCodeAt(i) === Char.CarriageReturn
      )
        break
      if (text.charCodeAt(i) === Char.LeftBrace && found.at(-1)!.type === 'expression') return 0
      if (text.charCodeAt(i) !== Char.LessThan && text.charCodeAt(i) !== Char.LeftBrace)
        return 0
    }
    // ── Apply the committed tokens to this Markdown container's JSX stack ──
    for (const item of found) {
      if (item.type === 'expression') {
        const n = node(
          Kind.Mdx,
          offset(view, item.start),
          offset(view, item.end),
          current(parent),
        )
        tree.extra[n] = { type: 'mdxFlowExpression', value: item.result.value }
        if (item.result.data) tree.extra[n].data = item.result.data
        continue
      }
      const stack = stacks.get(parent) ?? []
      stacks.set(parent, stack)
      if (item.close) {
        const open = stack.at(-1)
        if (!open) {
          // Defer unmatched closes so finish() can report the enclosing boundary.
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
        if (open.tag.name !== item.name)
          mismatched ??= () => mismatch(item, open.tag, view)
        tree.end[open.node] = offset(view, item.end)
        tree.b[open.node] = offset(view, item.start)
        stack.pop()
      } else {
        const n = node(
          Kind.Mdx,
          offset(view, item.start),
          offset(view, item.end),
          current(parent),
        )
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
    // ── Translate the virtual ending back into consumed block lines ──
    const ending = offset(view, i)
    let j = at
    while (j < input.length && input[j].end < ending) j++
    return j - at + 1
  }
  return {
    inline,
    flow,
    flowParent: current,
    esm,
    interrupt(line: Line) {
      let i = line.start
      while (space(source.charCodeAt(i))) i++
      if (source.charCodeAt(i) !== Char.LessThan && source.charCodeAt(i) !== Char.LeftBrace)
        return false
      // Only complete tag/expression-only lines interrupt a paragraph.
      try {
        const view = rawView
        let previousExpression = false
        for (;;) {
          const c = source.charCodeAt(i)
          if (c === Char.LeftBrace && previousExpression) return false
          const end =
            c === Char.LessThan
              ? tag(view, i, source.length, syntax)?.end
              : c === Char.LeftBrace
                ? expression(view, i, source.length, syntax).end
                : undefined
          if (end === undefined) return false
          previousExpression = c === Char.LeftBrace
          i = end
          while (space(source.charCodeAt(i))) i++
          if (
            i >= source.length ||
            source.charCodeAt(i) === Char.LineFeed ||
            source.charCodeAt(i) === Char.CarriageReturn
          )
            return true
        }
      } catch {
        // Commit the flow attempt so its real MDX error is reported, not swallowed.
        return true
      }
    },
    continuationEnd(line: Line) {
      let i = line.start
      while (space(source.charCodeAt(i))) i++
      if (source.charCodeAt(i) !== Char.LessThan && source.charCodeAt(i) !== Char.LeftBrace)
        return line.end
      const view = rawView
      try {
        return source.charCodeAt(i) === Char.LessThan
          ? (tag(view, i, source.length, syntax)?.end ?? line.end)
          : expression(view, i, source.length, syntax).end
      } catch (error) {
        // Failed expressions and unclosed tags read every following line before failing.
        return source.charCodeAt(i) === Char.LeftBrace ||
          (error as MdxParseError).ruleId === 'unexpected-eof'
          ? source.length
          : line.end
      }
    },
    finish() {
      mismatched?.()
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
      function resolveInlineJsx(parent: number, active?: Tag): void {
        const pending: { tag: Tag; node: number }[] = []
        const children: number[] = []
        // Snapshot before destructive sibling rewiring; the old chain cannot be traversed later.
        for (let n = tree.child[parent]; n; n = tree.next[n]) children.push(n)
        tree.child[parent] = tree.last[parent] = 0
        // ── Match deferred tags and rebuild sibling chains under their JSX parents ──
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
                  // Active JSX cannot close across a Markdown container boundary.
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
            if (tree.child[n]) resolveInlineJsx(n, flowTag ?? enclosing)
            if (tree.kind[n] === Kind.Image || tree.kind[n] === Kind.ImageReference) {
              // Image alt can only be finalized after expressions and JSX have nested.
              tree.value[n] = imageAlt(n)
              tree.child[n] = tree.last[n] = 0
            }
            append(pending.at(-1)?.node ?? parent, n)
          }
        }
        // ── Reject unfinished inline and flow stacks at their owning boundary ──
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
          // Upstream root-level unfinished-flow diagnostics deliberately have no place.
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
      resolveInlineJsx(1)
    },
  }
}

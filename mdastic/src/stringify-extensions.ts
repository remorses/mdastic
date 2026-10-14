// GFM and MDX serializer ports (MIT, Titus Wormer and contributors; license in stringify.ts).
import type * as M from './types.ts'
import type { Unsafe } from './stringify-safe.ts'
import {
  inlineCode,
  listItem,
  type StringifyOptions,
  type State,
  type Info,
  type TrackerInfo,
  type Handler,
} from './stringify.ts'
function ccount(value: string, character: string) {
  const source = String(value)
  if (typeof character !== 'string') {
    throw new TypeError('Expected character')
  }
  let count = 0
  let index = source.indexOf(character)
  while (index !== -1) {
    count++
    index = source.indexOf(character, index + character.length)
  }
  return count
}
const inConstruct = 'phrasing'
const notInConstruct = ['autolink', 'link', 'image', 'label']
function gfmAutolinkLiteralToMarkdown() {
  return {
    unsafe: [
      {
        character: '@',
        before: '[+\\-.\\w]',
        after: '[\\-.\\w]',
        inConstruct,
        notInConstruct,
      },
      {
        character: '.',
        before: '[Ww]',
        after: '[\\-.\\w]',
        inConstruct,
        notInConstruct,
      },
      {
        character: ':',
        before: '[ps]',
        after: '\\/',
        inConstruct,
        notInConstruct,
      },
    ],
  }
}
footnoteReference.peek = footnoteReferencePeek
function footnoteReferencePeek() {
  return '['
}
function footnoteReference(
  node: M.FootnoteReference,
  _: any,
  state: State,
  info: Info,
) {
  const tracker = state.createTracker(info)
  let value = tracker.move('[^')
  const exit = state.enter('footnoteReference')
  const subexit = state.enter('reference')
  value += tracker.move(
    state.safe(state.associationId(node), { after: ']', before: value }),
  )
  subexit()
  exit()
  value += tracker.move(']')
  return value
}
function gfmFootnoteToMarkdown(options: StringifyOptions) {
  let firstLineBlank = false
  if (options && options.firstLineBlank) {
    firstLineBlank = true
  }
  return {
    handlers: { footnoteDefinition, footnoteReference },
    unsafe: [
      { character: '[', inConstruct: ['label', 'phrasing', 'reference'] },
    ],
  }
  function footnoteDefinition(
    node: M.FootnoteDefinition,
    _: any,
    state: State,
    info: Info,
  ) {
    const tracker = state.createTracker(info)
    let value = tracker.move('[^')
    const exit = state.enter('footnoteDefinition')
    const subexit = state.enter('label')
    value += tracker.move(
      state.safe(state.associationId(node), { before: value, after: ']' }),
    )
    subexit()
    value += tracker.move(']:')
    if (node.children && node.children.length > 0) {
      tracker.shift(4)
      value += tracker.move(
        (firstLineBlank ? '\n' : ' ') +
          state.indentLines(
            state.containerFlow(node, tracker.current()),
            firstLineBlank ? mapAll : mapExceptFirst,
          ),
      )
    }
    exit()
    return value
  }
}
function mapExceptFirst(line: string, index: number, blank: boolean) {
  return index === 0 ? line : mapAll(line, index, blank)
}
function mapAll(line: string, index: number, blank: boolean) {
  return (blank ? '' : '    ') + line
}
const constructsWithoutStrikethrough = [
  'autolink',
  'destinationLiteral',
  'destinationRaw',
  'reference',
  'titleQuote',
  'titleApostrophe',
]
handleDelete.attention = attentionDelete
handleDelete.peek = peekDelete
function gfmStrikethroughToMarkdown() {
  return {
    handlers: { delete: handleDelete },
    unsafe: [
      {
        character: '~',
        inConstruct: 'phrasing',
        notInConstruct: constructsWithoutStrikethrough,
      },
    ],
  }
}
function handleDelete(node: M.Delete, _: any, state: State, info: Info) {
  const tracker = state.createTracker(info)
  const sequence = state.stack.includes('strikethrough') ? '~' : '~~'
  const exit = state.enter('strikethrough')
  let value = tracker.move(sequence)
  value += state.containerPhrasing(node, {
    ...tracker.current(),
    before: value,
    after: '~',
  })
  value += tracker.move(sequence)
  exit()
  return value
}
function attentionDelete() {
  return { construct: 'strikethrough', markers: ['~'], sizes: [2, 1] }
}
function peekDelete() {
  return '~'
}
function defaultStringLength(value: string) {
  return value.length
}
interface TableOptions {
  align?: (string | null | undefined)[] | string | null
  stringLength?: ((value: string) => number) | null
  alignDelimiters?: boolean | null
  padding?: boolean | null
  delimiterStart?: boolean
  delimiterEnd?: boolean
}
function markdownTable(table: string[][], options: TableOptions) {
  const settings = options || {}
  const align = (settings.align || []).concat()
  const stringLength = settings.stringLength || defaultStringLength
  const alignments: number[] = []
  const cellMatrix: string[][] = []
  const sizeMatrix: number[][] = []
  const longestCellByColumn: number[] = []
  let mostCellsPerRow = 0
  let rowIndex = -1
  while (++rowIndex < table.length) {
    const row2: string[] = []
    const sizes2: number[] = []
    let columnIndex2 = -1
    if (table[rowIndex].length > mostCellsPerRow) {
      mostCellsPerRow = table[rowIndex].length
    }
    while (++columnIndex2 < table[rowIndex].length) {
      const cell = serialize(table[rowIndex][columnIndex2])
      if (settings.alignDelimiters !== false) {
        const size = stringLength(cell)
        sizes2[columnIndex2] = size
        if (
          longestCellByColumn[columnIndex2] === void 0 ||
          size > longestCellByColumn[columnIndex2]
        ) {
          longestCellByColumn[columnIndex2] = size
        }
      }
      row2.push(cell)
    }
    cellMatrix[rowIndex] = row2
    sizeMatrix[rowIndex] = sizes2
  }
  let columnIndex = -1
  if (Array.isArray(align)) {
    while (++columnIndex < mostCellsPerRow) {
      alignments[columnIndex] = toAlignment(align[columnIndex])
    }
  } else {
    const code2 = toAlignment(align)
    while (++columnIndex < mostCellsPerRow) {
      alignments[columnIndex] = code2
    }
  }
  columnIndex = -1
  const row: string[] = []
  const sizes: number[] = []
  while (++columnIndex < mostCellsPerRow) {
    const code2 = alignments[columnIndex]
    let before = ''
    let after = ''
    if (code2 === 99) {
      before = ':'
      after = ':'
    } else if (code2 === 108) {
      before = ':'
    } else if (code2 === 114) {
      after = ':'
    }
    let size =
      settings.alignDelimiters === false
        ? 1
        : Math.max(
            1,
            longestCellByColumn[columnIndex] - before.length - after.length,
          )
    const cell = before + '-'.repeat(size) + after
    if (settings.alignDelimiters !== false) {
      size = before.length + size + after.length
      if (size > longestCellByColumn[columnIndex]) {
        longestCellByColumn[columnIndex] = size
      }
      sizes[columnIndex] = size
    }
    row[columnIndex] = cell
  }
  cellMatrix.splice(1, 0, row)
  sizeMatrix.splice(1, 0, sizes)
  rowIndex = -1
  const lines: string[] = []
  while (++rowIndex < cellMatrix.length) {
    const row2 = cellMatrix[rowIndex]
    const sizes2 = sizeMatrix[rowIndex]
    columnIndex = -1
    const line: string[] = []
    while (++columnIndex < mostCellsPerRow) {
      const cell = row2[columnIndex] || ''
      let before = ''
      let after = ''
      if (settings.alignDelimiters !== false) {
        const size =
          longestCellByColumn[columnIndex] - (sizes2[columnIndex] || 0)
        const code2 = alignments[columnIndex]
        if (code2 === 114) {
          before = ' '.repeat(size)
        } else if (code2 === 99) {
          if (size % 2) {
            before = ' '.repeat(size / 2 + 0.5)
            after = ' '.repeat(size / 2 - 0.5)
          } else {
            before = ' '.repeat(size / 2)
            after = before
          }
        } else {
          after = ' '.repeat(size)
        }
      }
      if (settings.delimiterStart !== false && !columnIndex) {
        line.push('|')
      }
      if (
        settings.padding !== false &&
        !(settings.alignDelimiters === false && cell === '') &&
        (settings.delimiterStart !== false || columnIndex)
      ) {
        line.push(' ')
      }
      if (settings.alignDelimiters !== false) {
        line.push(before)
      }
      line.push(cell)
      if (settings.alignDelimiters !== false) {
        line.push(after)
      }
      if (settings.padding !== false) {
        line.push(' ')
      }
      if (
        settings.delimiterEnd !== false ||
        columnIndex !== mostCellsPerRow - 1
      ) {
        line.push('|')
      }
    }
    lines.push(
      settings.delimiterEnd === false
        ? line.join('').replace(/ +$/, '')
        : line.join(''),
    )
  }
  return lines.join('\n')
}
function serialize(value: string | null | undefined) {
  return value === null || value === void 0 ? '' : String(value)
}
function toAlignment(value: string | null | undefined) {
  const code2 = typeof value === 'string' ? value.codePointAt(0) : 0
  return code2 === 67 || code2 === 99
    ? 99
    : code2 === 76 || code2 === 108
      ? 108
      : code2 === 82 || code2 === 114
        ? 114
        : 0
}
function gfmTableToMarkdown(options: StringifyOptions) {
  const settings = options || {}
  const padding = settings.tableCellPadding
  const alignDelimiters = settings.tablePipeAlign
  const stringLength = settings.stringLength
  const around = padding ? ' ' : '|'
  return {
    unsafe: [
      { character: '\r', inConstruct: 'tableCell' },
      { character: '\n', inConstruct: 'tableCell' },
      { atBreak: true, character: '|', after: '[	 :-]' },
      { character: '|', inConstruct: 'tableCell' },
      { atBreak: true, character: ':', after: '-' },
      { atBreak: true, character: '-', after: '[:|-]' },
    ],
    handlers: {
      inlineCode: inlineCodeWithTable,
      table: handleTable,
      tableCell: handleTableCell,
      tableRow: handleTableRow,
    },
  }
  function handleTable(node: M.Table, _: any, state: State, info: Info) {
    return serializeData(handleTableAsData(node, state, info), node.align)
  }
  function handleTableRow(node: M.TableRow, _: any, state: State, info: Info) {
    const row = handleTableRowAsData(node, state, info)
    const value = serializeData([row], undefined)
    return value.slice(0, value.indexOf('\n'))
  }
  function handleTableCell(
    node: M.TableCell,
    _: any,
    state: State,
    info: Info,
  ) {
    const exit = state.enter('tableCell')
    const subexit = state.enter('phrasing')
    const value = state.containerPhrasing(node, {
      ...info,
      before: around,
      after: around,
    })
    subexit()
    exit()
    return value
  }
  function serializeData(matrix: string[][], align?: M.AlignType[] | null) {
    return markdownTable(matrix, {
      align,
      alignDelimiters,
      padding,
      stringLength,
    })
  }
  function handleTableAsData(node: M.Table, state: State, info: Info) {
    const children = node.children
    let index = -1
    const result: string[][] = []
    const subexit = state.enter('table')
    while (++index < children.length) {
      result[index] = handleTableRowAsData(children[index], state, info)
    }
    subexit()
    return result
  }
  function handleTableRowAsData(node: M.TableRow, state: State, info: Info) {
    const children = node.children
    let index = -1
    const result: string[] = []
    const subexit = state.enter('tableRow')
    while (++index < children.length) {
      result[index] = handleTableCell(children[index], node, state, info)
    }
    subexit()
    return result
  }
  function inlineCodeWithTable(node: M.InlineCode, parent: any, state: State) {
    let value = inlineCode(node, parent, state)
    if (state.stack.includes('tableCell')) {
      value = value.replace(/\|/g, '\\$&')
    }
    return value
  }
}
function gfmTaskListItemToMarkdown() {
  return {
    unsafe: [{ atBreak: true, character: '-', after: '[:|-]' }],
    handlers: { listItem: listItemWithTaskListItem },
  }
}
function listItemWithTaskListItem(
  node: M.ListItem,
  parent: any,
  state: State,
  info: Info,
) {
  const head = node.children[0]
  const checkable =
    typeof node.checked === 'boolean' && head && head.type === 'paragraph'
  const checkbox = '[' + (node.checked ? 'x' : ' ') + '] '
  const tracker = state.createTracker(info)
  if (checkable) {
    tracker.move(checkbox)
  }
  let value = listItem(node, parent, state, {
    ...info,
    ...tracker.current(),
  })
  if (checkable) {
    value = value.replace(/^(?:[*+-]|\d+\.)([\r\n]| {1,3})/, check)
  }
  return value
  function check($0: any) {
    return $0 + checkbox
  }
}
export function gfmToMarkdown(options: StringifyOptions) {
  return {
    extensions: [
      gfmAutolinkLiteralToMarkdown(),
      gfmFootnoteToMarkdown(options),
      gfmStrikethroughToMarkdown(),
      gfmTableToMarkdown(options),
      gfmTaskListItemToMarkdown(),
    ],
  }
}
function mdxExpressionToMarkdown() {
  return {
    handlers: {
      mdxFlowExpression: handleMdxExpression,
      mdxTextExpression: handleMdxExpression,
    },
    unsafe: [
      { character: '{', inConstruct: ['phrasing'] },
      { atBreak: true, character: '{' },
    ],
  }
}
function handleMdxExpression(
  node: M.MdxFlowExpression | M.MdxTextExpression,
  parent: any,
  state: State,
) {
  const value = node.value || ''
  const result = state.indentLines(value, function (line, index, blank) {
    return (index === 0 || blank ? '' : '  ') + line
  })
  return '{' + result + '}'
}
function stringifyEntitiesLight(value: string, options: { subset: string[] }) {
  const quote = options.subset[0]
  return value
    .split(quote)
    .join('&#x' + quote.charCodeAt(0).toString(16).toUpperCase() + ';')
}
const indent = '  '
function mdxJsxToMarkdown(options: StringifyOptions) {
  const options_ = options || {}
  const quote = options_.quote || '"'
  const quoteSmart = options_.quoteSmart || false
  const tightSelfClosing = options_.tightSelfClosing || false
  const printWidth = options_.printWidth || Number.POSITIVE_INFINITY
  const alternative = quote === '"' ? "'" : '"'
  if (quote !== '"' && quote !== "'") {
    throw new Error(
      'Cannot serialize attribute values with `' +
        quote +
        '` for `options.quote`, expected `"`, or `\'`',
    )
  }
  mdxElement.peek = peekElement
  return {
    handlers: {
      mdxJsxFlowElement: mdxElement,
      mdxJsxTextElement: mdxElement,
    },
    unsafe: [
      { character: '<', inConstruct: ['phrasing'] },
      { atBreak: true, character: '<' },
    ],
    fences: true,
    resourceLink: true,
  }
  function mdxElement(
    node: M.MdxJsxFlowElement | M.MdxJsxTextElement,
    _: any,
    state: State,
    info: Info,
  ) {
    const flow = node.type === 'mdxJsxFlowElement'
    const selfClosing = node.name
      ? !node.children || node.children.length === 0
      : false
    const depth = inferDepth(state)
    const currentIndent = createIndent(depth)
    const trackerOneLine = state.createTracker(info)
    const trackerMultiLine = state.createTracker(info)
    const serializedAttributes: string[] = []
    const prefix = (flow ? currentIndent : '') + '<' + (node.name || '')
    const exit = state.enter(node.type)
    trackerOneLine.move(prefix)
    trackerMultiLine.move(prefix)
    if (node.attributes && node.attributes.length > 0) {
      if (!node.name) {
        throw new Error('Cannot serialize fragment w/ attributes')
      }
      let index = -1
      while (++index < node.attributes.length) {
        const attribute = node.attributes[index]
        let result: string
        if (attribute.type === 'mdxJsxExpressionAttribute') {
          result = '{' + (attribute.value || '') + '}'
        } else {
          if (!attribute.name) {
            throw new Error('Cannot serialize attribute w/o name')
          }
          const value2 = attribute.value
          const left = attribute.name
          let right = ''
          if (value2 === null || value2 === void 0) {
          } else if (typeof value2 === 'object') {
            right = '{' + (value2.value || '') + '}'
          } else {
            const appliedQuote =
              quoteSmart && ccount(value2, quote) > ccount(value2, alternative)
                ? alternative
                : quote
            right =
              appliedQuote +
              stringifyEntitiesLight(value2, { subset: [appliedQuote] }) +
              appliedQuote
          }
          result = left + (right ? '=' : '') + right
        }
        serializedAttributes.push(result)
      }
    }
    let attributesOnTheirOwnLine = false
    const attributesOnOneLine = serializedAttributes.join(' ')
    if (
      flow &&
      (/\r?\n|\r/.test(attributesOnOneLine) ||
        trackerOneLine.current().now.column +
          attributesOnOneLine.length +
          (selfClosing ? (tightSelfClosing ? 2 : 3) : 1) >
          printWidth)
    ) {
      attributesOnTheirOwnLine = true
    }
    let tracker = trackerOneLine
    let value = prefix
    if (attributesOnTheirOwnLine) {
      tracker = trackerMultiLine
      let index = -1
      while (++index < serializedAttributes.length) {
        serializedAttributes[index] =
          currentIndent + indent + serializedAttributes[index]
      }
      value += tracker.move(
        '\n' + serializedAttributes.join('\n') + '\n' + currentIndent,
      )
    } else if (attributesOnOneLine) {
      value += tracker.move(' ' + attributesOnOneLine)
    }
    if (selfClosing) {
      value += tracker.move(
        (tightSelfClosing || attributesOnTheirOwnLine ? '' : ' ') + '/',
      )
    }
    value += tracker.move('>')
    if (node.children && node.children.length > 0) {
      if (node.type === 'mdxJsxTextElement') {
        value += tracker.move(
          state.containerPhrasing(node, {
            ...tracker.current(),
            before: '>',
            after: '<',
          }),
        )
      } else {
        tracker.shift(2)
        value += tracker.move('\n')
        value += tracker.move(containerFlow2(node, state, tracker.current()))
        value += tracker.move('\n')
      }
    }
    if (!selfClosing) {
      value += tracker.move(
        (flow ? currentIndent : '') + '</' + (node.name || '') + '>',
      )
    }
    exit()
    return value
  }
}
function containerFlow2(parent: any, state: State, info: TrackerInfo) {
  const indexStack = state.indexStack
  const children = parent.children
  const tracker = state.createTracker(info)
  const currentIndent = createIndent(inferDepth(state))
  const results: string[] = []
  let index = -1
  indexStack.push(-1)
  while (++index < children.length) {
    const child = children[index]
    indexStack[indexStack.length - 1] = index
    const childInfo: Info = { before: '\n', after: '\n', ...tracker.current() }
    const result = state.handle(child, parent, state, childInfo)
    const serializedChild =
      child.type === 'mdxJsxFlowElement'
        ? result
        : state.indentLines(result, function (line, _, blank) {
            return (blank ? '' : currentIndent) + line
          })
    results.push(tracker.move(serializedChild))
    if (child.type !== 'list') {
      state.bulletLastUsed = void 0
    }
    if (index < children.length - 1) {
      results.push(tracker.move('\n\n'))
    }
  }
  indexStack.pop()
  return results.join('')
}
function inferDepth(state: State) {
  let depth = 0
  let index = state.stack.length
  while (--index > -1) {
    const name = state.stack[index]
    if (name === 'blockquote' || name === 'listItem') break
    if (name === 'mdxJsxFlowElement') depth++
  }
  return depth
}
function createIndent(depth: number) {
  return indent.repeat(depth)
}
function peekElement() {
  return '<'
}
function mdxjsEsmToMarkdown() {
  return { handlers: { mdxjsEsm: handleMdxjsEsm } }
}
function handleMdxjsEsm(node: M.MdxjsEsm) {
  return node.value || ''
}
export function mdxToMarkdown(options: StringifyOptions) {
  return {
    extensions: [
      mdxExpressionToMarkdown(),
      mdxJsxToMarkdown(options),
      mdxjsEsmToMarkdown(),
    ],
  }
}
export function frontmatterToMarkdown(types: string[]) {
  const handlers: Record<string, Handler> = {}
  const unsafe: Unsafe[] = []
  for (const type of types) {
    const marker = type === 'yaml' ? '-' : '+'
    handlers[type] = (node: any) =>
      marker.repeat(3) +
      (node.value ? '\n' + node.value : '') +
      '\n' +
      marker.repeat(3)
    unsafe.push({ atBreak: true, character: marker, after: '\\' + marker })
  }
  return { handlers, unsafe }
}

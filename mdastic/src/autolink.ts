// Remark has tokenizer autolinks with positions, then positionless fallback replacements.
// Tokenizer and fallback rules differ intentionally; do not merge their recognizers.
import { alpha, Char, digit, isPunctuation, isWhitespace } from './scan.ts'
import { Kind, node, tree } from './tree.ts'

export interface LiteralLink {
  end: number
  prefix: string
}
const ASCII_CASE_BIT = 0x20
const HTTP_PREFIX_LENGTH = 7
const HTTPS_PREFIX_LENGTH = 8
const WWW_PREFIX_LENGTH = 4
const WWW_MARKER_LENGTH = 3

function atext(c: number): boolean {
  return (
    alpha(c) ||
    digit(c) ||
    c === Char.Plus ||
    c === Char.Hyphen ||
    c === Char.Dot ||
    c === Char.Underscore
  )
}
function word(source: string, at: number, value: string): boolean {
  for (let i = 0; i < value.length; i++)
    if ((source.charCodeAt(at + i) | ASCII_CASE_BIT) !== value.charCodeAt(i)) return false
  return true
}

function trail(source: string, at: number, end: number): boolean {
  for (let i = at; i < end; i++) {
    const c = source.charCodeAt(i)
    if (isWhitespace(c) || c === 60) return true
    if (
      c === 33 ||
      c === 34 ||
      c === 39 ||
      c === 41 ||
      c === 42 ||
      c === 44 ||
      c === 46 ||
      c === 58 ||
      c === 59 ||
      c === 63 ||
      c === 95 ||
      c === 126
    )
      continue
    if (c === 93) {
      const next = source.charCodeAt(i + 1)
      if (i + 1 === end || next === 40 || next === 91 || isWhitespace(next)) return true
      continue
    }
    if (c === 38) {
      let j = i + 1
      while (j < end && alpha(source.charCodeAt(j))) j++
      if (j === i + 1 || source.charCodeAt(j) !== 59) return false
      i = j
      continue
    }
    return false
  }
  return true
}

function domain(source: string, start: number, end: number): number {
  // GFM forbids underscores in the final two domain labels.
  let underscore = false
  let previousUnderscore = false
  let seen = false
  let i = start
  for (; i < end; i++) {
    const c = source.charCodeAt(i)
    if (c === 46 || c === 95) {
      if (trail(source, i, end)) break
      if (c === 95) underscore = true
      else {
        previousUnderscore = underscore
        underscore = false
      }
      continue
    }
    if (isWhitespace(c) || (c !== 45 && isPunctuation(c))) break
    seen = true
  }
  return seen && !underscore && !previousUnderscore ? i : -1
}

function path(source: string, start: number, end: number): number {
  // Keep trailing closing parentheses only while they balance URL-internal opens.
  let opens = 0
  let closes = 0
  let i = start
  for (; i < end; i++) {
    const c = source.charCodeAt(i)
    if (isWhitespace(c)) break
    if (c === 40) {
      opens++
      continue
    }
    if (c === 41 && closes < opens) {
      closes++
      continue
    }
    if ('!"&\')*,.:;<?]_~'.includes(source[i]) && trail(source, i, end)) break
    if (c === 41) closes++
  }
  return i
}

export function rawLiteralLink(
  source: string,
  start: number,
  end: number,
  previous: number,
  email = true,
): LiteralLink | undefined {
  const c = source.charCodeAt(start)
  if (email && atext(c) && previous !== 47 && !atext(previous)) {
    let i = start
    while (i < end && atext(source.charCodeAt(i))) i++
    if (source.charCodeAt(i) === 64) {
      i++
      let dot = false
      let data = false
      for (; i < end; i++) {
        const d = source.charCodeAt(i)
        if (d === 46 && (alpha(source.charCodeAt(i + 1)) || digit(source.charCodeAt(i + 1))))
          dot = true
        else if (alpha(d) || digit(d) || d === 45 || d === 95) data = true
        else break
      }
      if (dot && data && alpha(source.charCodeAt(i - 1))) return { end: i, prefix: 'mailto:' }
    }
  }
  if ((c === 72 || c === 104) && !alpha(previous)) {
    const prefix = word(source, start, 'http://')
      ? HTTP_PREFIX_LENGTH
      : word(source, start, 'https://')
        ? HTTPS_PREFIX_LENGTH
        : 0
    if (prefix) {
      const first = source.charCodeAt(start + prefix)
      if (start + prefix < end && first > 32 && !isPunctuation(first) && !isWhitespace(first)) {
        const stop = domain(source, start + prefix, end)
        if (stop > start + prefix) return { end: path(source, stop, end), prefix: '' }
      }
    }
  }
  if (
    (c === 87 || c === 119) &&
    word(source, start, 'www.') &&
    start + WWW_PREFIX_LENGTH < end &&
    (previous === -1 ||
      previous === 40 ||
      previous === 42 ||
      previous === 95 ||
      previous === 91 ||
      previous === 93 ||
      previous === 126 ||
      previous === 32 ||
      previous === 9 ||
      previous === 10 ||
      previous === 13)
  ) {
    const stop = domain(source, start, end)
    if (stop > start) return { end: path(source, stop, end), prefix: 'http://' }
  }
}

function correctDomain(source: string, start: number, end: number): boolean {
  let count = 0
  let begin = start
  let previousValid = true
  let valid = true
  for (let i = start; i <= end; i++) {
    if (i !== end && source.charCodeAt(i) !== 46) continue
    previousValid = valid
    valid = true
    let alnum = false
    for (let j = begin; j < i; j++) {
      if (source.charCodeAt(j) === 95) valid = false
      if (alpha(source.charCodeAt(j)) || digit(source.charCodeAt(j))) alnum = true
    }
    if (i > begin && !alnum) valid = false
    count++
    begin = i + 1
  }
  return count >= 2 && valid && previousValid
}

function splitEnd(source: string, start: number, end: number): number {
  let tail = end
  while (tail > start && '!"&\'),.:;<>?]}'.includes(source[tail - 1])) tail--
  if (tail === end) return end
  let opens = 0
  let closes = 0
  for (let i = start; i < tail; i++) {
    if (source.charCodeAt(i) === 40) opens++
    else if (source.charCodeAt(i) === 41) closes++
  }
  let result = tail
  for (let i = tail; i < end && opens > closes; i++)
    if (source.charCodeAt(i) === 41) {
      result = i + 1
      closes++
    }
  return result
}

// The fallback is a port of the find-and-replace transform in
// mdast-util-gfm-autolink-literal@2.1.0: same regexes, same pass order, same retries.
interface FallbackLink {
  end: number
  url: string
}
interface FallbackPass {
  /** Cheap test that must pass whenever `pattern` can match, so most text skips the regex. */
  guard(value: string): boolean
  pattern: RegExp
  find(match: RegExpExecArray): FallbackLink | false
}
interface Piece {
  value: string
  url: string | undefined
}

function badLabel(label: string): boolean {
  const c = label.charCodeAt(label.length - 1)
  return digit(c) || c === Char.Hyphen || c === Char.Underscore
}

const URL_HINT = /https?:\/\/|www\./i

const PASSES: FallbackPass[] = [
  {
    guard: (value) => URL_HINT.test(value),
    pattern: /(?<![\da-z])(https?:\/\/|www(?=\.))([\w-]*\.[\w\-.]*)([^\t\n\r ]*)/gi,
    find(match) {
      const { index, input } = match
      const previous = input.charCodeAt(index - 1)
      if (index && !isWhitespace(previous) && !isPunctuation(previous)) return false
      const www = (match[1].charCodeAt(0) | ASCII_CASE_BIT) === Char.LowerW
      const host = www ? index : index + match[1].length
      const hostEnd = index + match[1].length + match[2].length
      if (isPunctuation(input.charCodeAt(host)) || !correctDomain(input, host, hostEnd)) return false
      const end = splitEnd(input, host, index + match[0].length)
      return { end, url: (www ? 'http://' : '') + input.slice(index, end) }
    },
  },
  {
    guard: (value) => value.indexOf('@') >= 0 && value.indexOf('xmpp:') >= 0,
    pattern:
      /(?<![\w+\-.@])xmpp:([\w+\-.]+)@([\w-]+(?:\.[\w-]+)+)(\/(?:[\w\-/]|\.(?=[\dA-Za-z]))*)?/g,
    find(match) {
      const resource = match[3]
      const end = match.index + match[0].length
      if (
        badLabel(match[2]) ||
        (resource &&
          (!alpha(resource.charCodeAt(resource.length - 1)) ||
            match.input.charCodeAt(end) === Char.At))
      )
        return false
      return { end, url: match[0] }
    },
  },
  {
    guard: (value) => value.indexOf('@') >= 0 && value.indexOf('mailto:') >= 0,
    pattern: /(?<![\w+\-.@])mailto:([\w+\-.]+)@([\w-]+(?:\.[\w-]+)+)/g,
    find(match) {
      if (badLabel(match[2])) return false
      return { end: match.index + match[0].length, url: match[0] }
    },
  },
  {
    guard: (value) => value.indexOf('@') >= 0,
    pattern: /(?<![\w+\-.]|(?:^|[^\d@A-Za-z])(?:mailto|xmpp):)([\w+\-.]+)@([\w-]+(?:\.[\w-]+)+)/g,
    find(match) {
      if (badLabel(match[2])) return false
      return { end: match.index + match[0].length, url: 'mailto:' + match[0] }
    },
  },
]

function splitPass(value: string, pass: FallbackPass): Piece[] | undefined {
  if (!pass.guard(value)) return
  const pattern = pass.pattern
  pattern.lastIndex = 0
  let pieces: Piece[] | undefined
  let segment = 0
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const link = pass.find(match)
    if (!link) {
      // A rejected match retries one character later, like find-and-replace.
      pattern.lastIndex = match.index + 1
      continue
    }
    pieces ??= []
    if (segment < match.index)
      pieces.push({ value: value.slice(segment, match.index), url: undefined })
    pieces.push({ value: value.slice(match.index, link.end), url: link.url })
    // URL trails stay outside the link but merge with the following text.
    segment = link.end
  }
  if (pieces && segment < value.length) pieces.push({ value: value.slice(segment), url: undefined })
  return pieces
}

function replaceText(parent: number, n: number): void {
  // Each pass runs over the text pieces left by the previous one, as remark runs
  // one tree-wide find-and-replace per pattern. Replacing any part drops positions.
  const value = tree.value[n] ?? ''
  // Every pattern needs a dot in its domain.
  if (value.indexOf('.') < 0) return
  let pieces: Piece[] | undefined
  for (const pass of PASSES) {
    if (!pieces) {
      pieces = splitPass(value, pass)
      continue
    }
    const next: Piece[] = []
    for (const piece of pieces) {
      const split = piece.url === undefined ? splitPass(piece.value, pass) : undefined
      if (split) next.push(...split)
      else next.push(piece)
    }
    pieces = next
  }
  if (!pieces) return
  let first = 0
  let last = 0
  for (const piece of pieces) {
    let child: number
    if (piece.url === undefined) {
      child = node(Kind.Text, 0, 0)
      tree.value[child] = piece.value
    } else {
      child = node(Kind.Link, 0, 0)
      tree.extra[child] = { title: null, url: piece.url }
      const text = node(Kind.Text, 0, 0, child)
      tree.value[text] = piece.value
      tree.positionless[text] = 1
    }
    tree.positionless[child] = 1
    if (last) {
      tree.next[last] = child
      tree.prev[child] = last
    } else first = child
    last = child
  }
  const before = tree.prev[n]
  const after = tree.next[n]
  if (before) tree.next[before] = first
  else tree.child[parent] = first
  tree.prev[first] = before
  tree.next[last] = after
  if (after) tree.prev[after] = last
  else tree.last[parent] = last
}

export function transformLiteralLinks(parent: number): void {
  // Existing links and link references are never transformed again.
  for (let n = tree.child[parent]; n; ) {
    const next = tree.next[n]
    if (tree.kind[n] === Kind.Text) replaceText(parent, n)
    else if (tree.kind[n] !== Kind.Link && tree.kind[n] !== Kind.LinkReference && tree.child[n])
      transformLiteralLinks(n)
    n = next
  }
}

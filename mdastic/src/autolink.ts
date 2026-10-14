// Remark has tokenizer autolinks with positions, then positionless fallback replacements.
import { alpha, digit, isPunctuation, isWhitespace } from './scan.ts'
import { Kind, node, tree } from './tree.ts'

export interface LiteralLink {
  end: number
  prefix: string
}
function atext(c: number): boolean {
  return alpha(c) || digit(c) || c === 43 || c === 45 || c === 46 || c === 95
}
function word(source: string, at: number, value: string): boolean {
  for (let i = 0; i < value.length; i++)
    if ((source.charCodeAt(at + i) | 32) !== value.charCodeAt(i)) return false
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
    const prefix = word(source, start, 'http://') ? 7 : word(source, start, 'https://') ? 8 : 0
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
    start + 4 < end &&
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

function fallbackUrl(source: string, start: number): LiteralLink | undefined {
  const previous = start ? source.charCodeAt(start - 1) : -1
  if (start && !isWhitespace(previous) && !isPunctuation(previous)) return
  const protocol = word(source, start, 'http://')
    ? 7
    : word(source, start, 'https://')
      ? 8
      : word(source, start, 'www.')
        ? 3
        : 0
  if (!protocol) return
  let i = start + protocol
  const begin = i
  while (
    i < source.length &&
    (alpha(source.charCodeAt(i)) ||
      digit(source.charCodeAt(i)) ||
      source.charCodeAt(i) === 95 ||
      source.charCodeAt(i) === 45 ||
      source.charCodeAt(i) === 46)
  )
    i++
  if (i === begin || !correctDomain(source, protocol === 3 ? start : begin, i)) return
  while (
    i < source.length &&
    source.charCodeAt(i) !== 32 &&
    source.charCodeAt(i) !== 9 &&
    source.charCodeAt(i) !== 10 &&
    source.charCodeAt(i) !== 13
  )
    i++
  const stop = splitEnd(source, start + protocol, i)
  if (stop > start + protocol || (protocol === 3 && stop === start + protocol))
    return { end: stop, prefix: protocol === 3 ? 'http://' : '' }
}

function fallbackEmail(source: string, start: number): LiteralLink | undefined {
  const previous = start ? source.charCodeAt(start - 1) : -1
  if (previous === 47 || (start && !isWhitespace(previous) && !isPunctuation(previous))) return
  let i = start
  while (i < source.length && atext(source.charCodeAt(i))) i++
  if (i === start || source.charCodeAt(i) !== 64) return
  const domainStart = ++i
  let dot = false
  let label = false
  while (i < source.length) {
    const c = source.charCodeAt(i)
    if (alpha(c) || digit(c) || c === 95 || c === 45) {
      label = true
      i++
    } else if (
      c === 46 &&
      label &&
      (alpha(source.charCodeAt(i + 1)) ||
        digit(source.charCodeAt(i + 1)) ||
        source.charCodeAt(i + 1) === 95 ||
        source.charCodeAt(i + 1) === 45)
    ) {
      dot = true
      label = false
      i++
    } else break
  }
  if (dot && i > domainStart && alpha(source.charCodeAt(i - 1)))
    return { end: i, prefix: 'mailto:' }
}

const fallbackUrlStart = /https?:\/\/|www\./gi

function emailStart(source: string, from: number): number {
  const at = source.indexOf('@', from)
  if (at < 0) return -1
  let start = at
  while (start > from && atext(source.charCodeAt(start - 1))) start--
  return start
}

function replaceText(parent: number, n: number, email: boolean): void {
  const value = tree.value[n] ?? ''
  if (value.indexOf(email ? '@' : '.') < 0) return
  let segment = 0
  let first = 0
  let last = 0
  fallbackUrlStart.lastIndex = 0
  let candidate = email ? emailStart(value, 0) : (fallbackUrlStart.exec(value)?.index ?? -1)
  while (candidate >= 0) {
    const i = candidate
    const link = email ? fallbackEmail(value, i) : fallbackUrl(value, i)
    if (!link) {
      candidate = email ? emailStart(value, i + 1) : (fallbackUrlStart.exec(value)?.index ?? -1)
      continue
    }
    if (segment < i) {
      const text = node(Kind.Text, 0, 0)
      tree.value[text] = value.slice(segment, i)
      tree.positionless[text] = 1
      if (last) {
        tree.next[last] = text
        tree.prev[text] = last
      } else first = text
      last = text
    }
    const wrapper = node(Kind.Link, 0, 0)
    tree.extra[wrapper] = { title: null, url: link.prefix + value.slice(i, link.end) }
    tree.positionless[wrapper] = 1
    const text = node(Kind.Text, 0, 0, wrapper)
    tree.value[text] = value.slice(i, link.end)
    tree.positionless[text] = 1
    if (last) {
      tree.next[last] = wrapper
      tree.prev[wrapper] = last
    } else first = wrapper
    last = wrapper
    segment = link.end
    if (email) candidate = emailStart(value, link.end)
    else {
      fallbackUrlStart.lastIndex = link.end
      candidate = fallbackUrlStart.exec(value)?.index ?? -1
    }
  }
  if (!first) return
  if (segment < value.length) {
    const text = node(Kind.Text, 0, 0)
    tree.value[text] = value.slice(segment)
    tree.positionless[text] = 1
    tree.next[last] = text
    tree.prev[text] = last
    last = text
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
  for (let n = tree.child[parent]; n;) {
    const next = tree.next[n]
    if (tree.kind[n] === Kind.Text) replaceText(parent, n, false)
    else if (tree.kind[n] !== Kind.Link && tree.kind[n] !== Kind.LinkReference && tree.child[n])
      transformLiteralLinks(n)
    n = next
  }
  for (let n = tree.child[parent]; n;) {
    const next = tree.next[n]
    if (tree.kind[n] === Kind.Text) replaceText(parent, n, true)
    n = next
  }
}

import { entities } from './entities.ts'
import { punctuation } from './punctuation.ts'
import type { Point, Position } from './types.ts'

export const ascii = new Uint8Array(128)
for (let i = 0; i < 128; i++) {
  if ((i >= 9 && i <= 13) || i === 32) ascii[i] |= 1
  if (
    (i >= 33 && i <= 47) ||
    (i >= 58 && i <= 64) ||
    (i >= 91 && i <= 96) ||
    (i >= 123 && i <= 126)
  )
    ascii[i] |= 2
  if (i >= 48 && i <= 57) ascii[i] |= 4
  if ((i >= 65 && i <= 90) || (i >= 97 && i <= 122)) ascii[i] |= 8
}

export function isWhitespace(c: number): boolean {
  return c < 128
    ? !!(ascii[c] & 1)
    : c === 160 ||
        c === 5760 ||
        (c >= 8192 && c <= 8202) ||
        c === 8232 ||
        c === 8233 ||
        c === 8239 ||
        c === 8287 ||
        c === 12288 ||
        c === 65279
}

export function isPunctuation(c: number): boolean {
  if (c < 128) return !!(ascii[c] & 2)
  let lo = 0
  let hi = punctuation.length >> 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (c < punctuation[mid * 2]) hi = mid
    else if (c > punctuation[mid * 2 + 1]) lo = mid + 1
    else return true
  }
  return false
}

export function space(c: number): boolean {
  return c === 32 || c === 9
}
export function digit(c: number): boolean {
  return c >= 48 && c <= 57
}
export function alpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
}

export function entity(
  source: string,
  start: number,
  end: number,
): { value: string; end: number } | undefined {
  let i = start + 1
  if (source.charCodeAt(i) === 35) {
    i++
    const hex = source.charCodeAt(i) === 120 || source.charCodeAt(i) === 88
    if (hex) i++
    const begin = i
    let n = 0
    while (i < end && i - begin < (hex ? 6 : 7)) {
      const c = source.charCodeAt(i)
      const d = digit(c)
        ? c - 48
        : hex && c >= 65 && c <= 70
          ? c - 55
          : hex && c >= 97 && c <= 102
            ? c - 87
            : -1
      if (d < 0) break
      n = n * (hex ? 16 : 10) + d
      i++
    }
    if (i === begin || source.charCodeAt(i) !== 59) return
    if (
      n < 9 ||
      n === 11 ||
      (n > 13 && n < 32) ||
      (n > 126 && n < 160) ||
      n > 1114111 ||
      (n >= 55296 && n <= 57343) ||
      (n >= 64976 && n <= 65007) ||
      (n & 65535) >= 65534
    )
      n = 65533
    return { value: String.fromCodePoint(n), end: i + 1 }
  }
  const begin = i
  while (i < end && i - begin < 31 && (alpha(source.charCodeAt(i)) || digit(source.charCodeAt(i))))
    i++
  if (source.charCodeAt(i) !== 59) return
  const name = source.slice(begin, i)
  const value = Object.hasOwn(entities, name) ? entities[name] : undefined
  if (value !== undefined) return { value, end: i + 1 }
}

const needsDecode = /[\\&\0]/

export function decode(value: string): string {
  if (!needsDecode.test(value)) return value
  let result = ''
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 92 && value.charCodeAt(i + 1) < 128 && isPunctuation(value.charCodeAt(i + 1))) {
      result += value.slice(start, i) + value[i + 1]
      start = ++i + 1
    } else if (c === 38) {
      const ref = entity(value, i, value.length)
      if (ref) {
        result += value.slice(start, i) + ref.value
        start = ref.end
        i = ref.end - 1
      }
    } else if (c === 0) {
      result += value.slice(start, i) + '\uFFFD'
      start = i + 1
    }
  }
  return result ? result + value.slice(start) : value
}

export function normalizeIdentifier(value: string): string {
  // Identifiers collapse markdown whitespace only, not Unicode whitespace.
  let result = ''
  let whitespace = false
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (space(c) || c === 10 || c === 13) whitespace = result.length > 0
    else {
      if (whitespace) result += ' '
      result += value[i]
      whitespace = false
    }
  }
  return result.toLowerCase().toUpperCase().toLowerCase()
}

export let lineStarts = new Int32Array(1024)
export let lineCount = 0
let count = 0
let cursor = 0
let positions = true
export function indexLines(source: string, enabled: boolean): void {
  positions = enabled
  count = 1
  cursor = 0
  lineStarts[0] = 0
  lineCount = 0
  let lf = source.indexOf('\n')
  let cr = source.indexOf('\r')
  while (lf >= 0 || cr >= 0) {
    let i = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr)
    if (i === cr) {
      if (lf === cr + 1) i++
      cr = source.indexOf('\r', i + 1)
    }
    if (i === lf) lf = source.indexOf('\n', i + 1)
    if (count === lineStarts.length) {
      const grown = new Int32Array(count * 2)
      grown.set(lineStarts)
      lineStarts = grown
    }
    lineStarts[count++] = i + 1
  }
  lineCount = count - (lineStarts[count - 1] === source.length ? 1 : 0)
}

export function point(offset: number): Point {
  if (offset < lineStarts[cursor] || (cursor + 1 < count && offset >= lineStarts[cursor + 1])) {
    let steps = 0
    while (cursor + 1 < count && offset >= lineStarts[cursor + 1] && steps++ < 4) cursor++
    while (cursor && offset < lineStarts[cursor] && steps++ < 4) cursor--
    if (offset < lineStarts[cursor] || (cursor + 1 < count && offset >= lineStarts[cursor + 1])) {
      let lo = 0
      let hi = count
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1
        if (lineStarts[mid] <= offset) lo = mid
        else hi = mid
      }
      cursor = lo
    }
  }
  return { line: cursor + 1, column: offset - lineStarts[cursor] + 1, offset }
}

export function position(start: number, end: number, override?: Point): Position | undefined {
  return positions ? { start: override ?? point(start), end: point(end) } : undefined
}

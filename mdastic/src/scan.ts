// Shared character classification, decoding, and UTF-16 source positions.
// The line index is reused by one synchronous parse at a time.
import { entities, legacyEntities } from './entities.ts'
import { punctuation } from './punctuation.ts'
import type { Point, Position } from './types.ts'

// Internal enums are inlined by tsc; they are not part of the public barrel.
export const enum Char {
  Tab = 9,
  LineFeed = 10,
  VerticalTab = 11,
  CarriageReturn = 13,
  Space = 32,
  Exclamation = 33,
  DoubleQuote = 34,
  Hash = 35,
  Dollar = 36,
  Ampersand = 38,
  SingleQuote = 39,
  LeftParen = 40,
  RightParen = 41,
  Asterisk = 42,
  Plus = 43,
  Comma = 44,
  Hyphen = 45,
  Dot = 46,
  Slash = 47,
  Digit0 = 48,
  Digit1 = 49,
  Digit9 = 57,
  Colon = 58,
  Semicolon = 59,
  LessThan = 60,
  Equals = 61,
  GreaterThan = 62,
  Question = 63,
  At = 64,
  UpperA = 65,
  UpperC = 67,
  UpperF = 70,
  UpperH = 72,
  UpperL = 76,
  UpperR = 82,
  UpperW = 87,
  UpperX = 88,
  UpperZ = 90,
  LeftBracket = 91,
  Backslash = 92,
  RightBracket = 93,
  Caret = 94,
  Underscore = 95,
  Backtick = 96,
  LowerA = 97,
  LowerC = 99,
  LowerF = 102,
  LowerH = 104,
  LowerL = 108,
  LowerR = 114,
  LowerW = 119,
  LowerX = 120,
  LowerZ = 122,
  LeftBrace = 123,
  Pipe = 124,
  RightBrace = 125,
  Tilde = 126,
  Delete = 127,
  NoBreakSpace = 160,
  Bom = 65279,
}

export const enum AsciiFlag {
  Whitespace = 1,
  Punctuation = 2,
  Digit = 4,
  Letter = 8,
  Alphanumeric = Digit | Letter,
}

export const ASCII_SIZE = 128
export const TAB_SIZE = 4
const MAX_HEX_REFERENCE_DIGITS = 6
const MAX_DECIMAL_REFERENCE_DIGITS = 7
const MAX_NAMED_REFERENCE_LENGTH = 31
const MAX_UNICODE_CODE_POINT = 0x10ffff
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff
const NONCHARACTER_START = 0xfdd0
const NONCHARACTER_END = 0xfdef
const UNICODE_PLANE_MASK = 0xffff
const PLANE_NONCHARACTER_START = 0xfffe
const REPLACEMENT_CHARACTER = 0xfffd
const MAX_LEGACY_REFERENCE_LENGTH = 6
const C1_START = 0x80
const C1_END = 0x9f
// HTML maps C1 references to windows-1252; unmapped ones stay as they are.
const WINDOWS_1252 =
  '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f\x90‘’“”•–—˜™š›œ\x9džŸ'
const legacy = new Set(legacyEntities)
const INITIAL_LINE_CAPACITY = 1024
const POSITION_CURSOR_SCAN_LIMIT = 4

export const ascii = new Uint8Array(ASCII_SIZE)
for (let i = 0; i < ASCII_SIZE; i++) {
  if ((i >= Char.Tab && i <= Char.CarriageReturn) || i === Char.Space)
    ascii[i] |= AsciiFlag.Whitespace
  if (
    (i >= Char.Exclamation && i <= Char.Slash) ||
    (i >= Char.Colon && i <= Char.At) ||
    (i >= Char.LeftBracket && i <= Char.Backtick) ||
    (i >= Char.LeftBrace && i <= Char.Tilde)
  )
    ascii[i] |= AsciiFlag.Punctuation
  if (i >= Char.Digit0 && i <= Char.Digit9) ascii[i] |= AsciiFlag.Digit
  if ((i >= Char.UpperA && i <= Char.UpperZ) || (i >= Char.LowerA && i <= Char.LowerZ))
    ascii[i] |= AsciiFlag.Letter
}

export function isWhitespace(c: number): boolean {
  // Micromark classifies UTF-16 units using these Unicode whitespace ranges.
  return c < ASCII_SIZE
    ? !!(ascii[c] & AsciiFlag.Whitespace)
    : c === Char.NoBreakSpace ||
        c === 5760 ||
        (c >= 8192 && c <= 8202) ||
        c === 8232 ||
        c === 8233 ||
        c === 8239 ||
        c === 8287 ||
        c === 12288 ||
        c === Char.Bom
}

export function isPunctuation(c: number): boolean {
  if (c < ASCII_SIZE) return !!(ascii[c] & AsciiFlag.Punctuation)
  // Generated punctuation entries are inclusive start/end pairs.
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
  return c === Char.Space || c === Char.Tab
}
export function digit(c: number): boolean {
  return c >= Char.Digit0 && c <= Char.Digit9
}
export function alpha(c: number): boolean {
  return (c >= Char.UpperA && c <= Char.UpperZ) || (c >= Char.LowerA && c <= Char.LowerZ)
}

export function entity(
  source: string,
  start: number,
  end: number,
): { value: string; end: number } | undefined {
  let i = start + 1
  if (source.charCodeAt(i) === Char.Hash) {
    i++
    const hex = source.charCodeAt(i) === Char.LowerX || source.charCodeAt(i) === Char.UpperX
    if (hex) i++
    const begin = i
    let n = 0
    while (
      i < end &&
      i - begin < (hex ? MAX_HEX_REFERENCE_DIGITS : MAX_DECIMAL_REFERENCE_DIGITS)
    ) {
      const c = source.charCodeAt(i)
      const d = digit(c)
        ? c - Char.Digit0
        : hex && c >= Char.UpperA && c <= Char.UpperF
          ? c - (Char.UpperA - 10)
          : hex && c >= Char.LowerA && c <= Char.LowerF
            ? c - (Char.LowerA - 10)
            : -1
      if (d < 0) break
      n = n * (hex ? 16 : 10) + d
      i++
    }
    if (i === begin || source.charCodeAt(i) !== Char.Semicolon) return
    // CommonMark replaces invalid, control, surrogate and noncharacter references.
    if (
      n < Char.Tab ||
      n === Char.VerticalTab ||
      (n > Char.CarriageReturn && n < Char.Space) ||
      (n > Char.Tilde && n < Char.NoBreakSpace) ||
      n > MAX_UNICODE_CODE_POINT ||
      (n >= SURROGATE_START && n <= SURROGATE_END) ||
      (n >= NONCHARACTER_START && n <= NONCHARACTER_END) ||
      (n & UNICODE_PLANE_MASK) >= PLANE_NONCHARACTER_START
    )
      n = REPLACEMENT_CHARACTER
    return { value: String.fromCodePoint(n), end: i + 1 }
  }
  const begin = i
  while (
    i < end &&
    i - begin < MAX_NAMED_REFERENCE_LENGTH &&
    (alpha(source.charCodeAt(i)) || digit(source.charCodeAt(i)))
  )
    i++
  if (source.charCodeAt(i) !== Char.Semicolon) return
  const name = source.slice(begin, i)
  const value = Object.hasOwn(entities, name) ? entities[name] : undefined
  if (value !== undefined) return { value, end: i + 1 }
}

// JSX attribute values decode with parse-entities (`nonTerminated: false`), not
// CommonMark: numeric references take any number of digits and keep controls,
// and a terminated unknown name still decodes its longest legacy prefix
// (`&copye;` is `©e;`).
export function attributeEntity(
  source: string,
  start: number,
  end: number,
): { value: string; end: number } | undefined {
  let i = start + 1
  if (source.charCodeAt(i) === Char.Hash) {
    i++
    const hex = source.charCodeAt(i) === Char.LowerX || source.charCodeAt(i) === Char.UpperX
    if (hex) i++
    const begin = i
    while (i < end) {
      const c = source.charCodeAt(i)
      if (
        !digit(c) &&
        !(hex && ((c >= Char.UpperA && c <= Char.UpperF) || (c >= Char.LowerA && c <= Char.LowerF)))
      )
        break
      i++
    }
    if (i === begin || source.charCodeAt(i) !== Char.Semicolon) return
    const n = Number.parseInt(source.slice(begin, i), hex ? 16 : 10)
    const value =
      n > MAX_UNICODE_CODE_POINT || (n >= SURROGATE_START && n <= SURROGATE_END) || n === 0
        ? String.fromCharCode(REPLACEMENT_CHARACTER)
        : n >= C1_START && n <= C1_END
          ? WINDOWS_1252[n - C1_START]
          : String.fromCodePoint(n)
    return { value, end: i + 1 }
  }
  const begin = i
  let prefix = 0
  while (i < end && (alpha(source.charCodeAt(i)) || digit(source.charCodeAt(i)))) {
    i++
    if (i - begin <= MAX_LEGACY_REFERENCE_LENGTH && legacy.has(source.slice(begin, i))) prefix = i
  }
  if (source.charCodeAt(i) !== Char.Semicolon) return
  const name = source.slice(begin, i)
  if (Object.hasOwn(entities, name)) return { value: entities[name], end: i + 1 }
  if (prefix) return { value: entities[source.slice(begin, prefix)], end: prefix }
}

const needsDecode = /[\\&\0]/

export function decode(value: string): string {
  if (!needsDecode.test(value)) return value
  let result = ''
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (
      c === Char.Backslash &&
      value.charCodeAt(i + 1) < ASCII_SIZE &&
      isPunctuation(value.charCodeAt(i + 1))
    ) {
      result += value.slice(start, i) + value[i + 1]
      start = ++i + 1
    } else if (c === Char.Ampersand) {
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
    if (space(c) || c === Char.LineFeed || c === Char.CarriageReturn)
      whitespace = result.length > 0
    else {
      if (whitespace) result += ' '
      result += value[i]
      whitespace = false
    }
  }
  // The round trip canonicalizes case-equivalent identifiers, including Greek variants.
  return result.toLowerCase().toUpperCase().toLowerCase()
}

export let lineStarts = new Int32Array(INITIAL_LINE_CAPACITY)
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
  // Block lines exclude the trailing empty line; position queries retain its EOF slot.
  lineCount = count - (lineStarts[count - 1] === source.length ? 1 : 0)
}

export function point(offset: number): Point {
  if (offset < lineStarts[cursor] || (cursor + 1 < count && offset >= lineStarts[cursor + 1])) {
    let steps = 0
    // Walk nearby positions cheaply; binary search handles jumps between containers.
    while (
      cursor + 1 < count &&
      offset >= lineStarts[cursor + 1] &&
      steps++ < POSITION_CURSOR_SCAN_LIMIT
    )
      cursor++
    while (cursor && offset < lineStarts[cursor] && steps++ < POSITION_CURSOR_SCAN_LIMIT)
      cursor--
    if (
      offset < lineStarts[cursor] ||
      (cursor + 1 < count && offset >= lineStarts[cursor + 1])
    ) {
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

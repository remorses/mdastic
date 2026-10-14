// Extracts parser inputs from Rust test suites (wooorm/markdown-rs, wooorm/mdxjs-rs, satteri-pulldown-cmark).
// Inputs are the string literals passed as the first argument of known calls; options map to syntax.
// Usage: pnpm exec tsx ../scripts/extract-rust.ts
import fs from 'node:fs'
import path from 'node:path'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { opensrc, walk, writeFixtures } from './fixtures-lib.ts'

type Skip = { skip: string }

// ---------------------------------------------------------------- Rust lexing

/** Reads a string literal ("…", r#"…"#, b"…") at `i`. Returns undefined when `i` is not a literal. */
function readString(src: string, i: number): { value: string; end: number } | undefined {
  let j = i
  if (src[j] === 'b') j++
  if (src[j] === 'r') {
    j++
    let hashes = 0
    while (src[j] === '#') hashes++, j++
    if (src[j] !== '"') return undefined
    const close = '"' + '#'.repeat(hashes)
    const end = src.indexOf(close, j + 1)
    return { value: src.slice(j + 1, end), end: end + close.length }
  }
  if (src[j] !== '"') return undefined
  j++
  let out = ''
  while (j < src.length && src[j] !== '"') {
    const c = src[j]
    if (c !== '\\') {
      out += c
      j++
      continue
    }
    const n = src[j + 1]
    j += 2
    if (n === 'n') out += '\n'
    else if (n === 'r') out += '\r'
    else if (n === 't') out += '\t'
    else if (n === '0') out += '\0'
    else if (n === '\\' || n === '"' || n === "'") out += n
    else if (n === 'x') {
      out += String.fromCharCode(parseInt(src.slice(j, j + 2), 16))
      j += 2
    } else if (n === 'u') {
      const close = src.indexOf('}', j)
      out += String.fromCodePoint(parseInt(src.slice(j + 1, close), 16))
      j = close + 1
    } else if (n === '\n' || n === '\r') {
      // Line continuation: skip the newline and leading whitespace of the next line.
      while (/\s/.test(src[j])) j++
    } else throw new Error(`unknown escape \\${n}`)
  }
  return { value: out, end: j + 1 }
}

/** Skips a comment, string or char literal at `i`; returns the index after it, or `i` if none. */
function skipAtom(src: string, i: number): number {
  if (src.startsWith('//', i)) return src.indexOf('\n', i)
  if (src.startsWith('/*', i)) return src.indexOf('*/', i) + 2
  if (/["rb]/.test(src[i]) && !/\w/.test(src[i - 1] ?? '')) {
    const s = readString(src, i)
    if (s) return s.end
  }
  if (src[i] === "'") {
    const m = /^'(\\(u\{[0-9a-fA-F]+\}|x..|.)|[^\\'])'/.exec(src.slice(i, i + 12))
    if (m) return i + m[0].length
  }
  return i
}

/** Splits call arguments starting right after `(`. */
function splitArgs(src: string, start: number): { args: string[]; end: number } {
  const args: string[] = []
  let depth = 0
  let from = start
  let i = start
  while (i < src.length) {
    const next = skipAtom(src, i)
    if (next !== i) {
      i = next
      continue
    }
    const c = src[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) {
        if (src.slice(from, i).trim()) args.push(src.slice(from, i).trim())
        return { args, end: i + 1 }
      }
      depth--
    } else if (c === ',' && depth === 0) {
      args.push(src.slice(from, i).trim())
      from = i + 1
    }
    i++
  }
  return { args, end: i }
}

/** Expression text of the nearest `let name = …;` before `pos`. */
function letBefore(src: string, name: string, pos: number): string | undefined {
  const re = new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\s*(?::[^=]+)?=`, 'g')
  let found: number | undefined
  for (const m of src.matchAll(re)) if (m.index! < pos) found = m.index! + m[0].length
  if (found === undefined) return undefined
  // Reuse splitArgs: a `let` expression ends at `;` at depth 0, so scan manually.
  let depth = 0
  let i = found
  while (i < src.length) {
    const next = skipAtom(src, i)
    if (next !== i) {
      i = next
      continue
    }
    const c = src[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ';' && depth === 0) break
    i++
  }
  return src.slice(found, i).trim()
}

/** String value of an argument expression: literal, `"x".repeat(n)`, `.to_string()`, or a `let` variable. */
function argValue(src: string, expr: string, pos: number, depth = 0): string | undefined {
  let e = expr.trim().replace(/^&/, '').trim()
  e = e.replace(/\.(to_string|to_owned|into)\(\)$/, '').replace(/^String::from\((.*)\)$/s, '$1').trim()
  const s = /^[rb"]/.test(e) ? readString(e, 0) : undefined
  if (s) {
    const rest = e.slice(s.end).trim()
    if (!rest) return s.value
    const repeat = /^\.repeat\((\d+)\)$/.exec(rest)
    if (repeat) return s.value.repeat(Number(repeat[1]))
    return undefined
  }
  if (/^\w+$/.test(e) && depth < 3) {
    const def = letBefore(src, e, pos)
    if (def !== undefined) return argValue(src, def, pos, depth + 1)
  }
  return undefined
}

function lineOf(src: string, pos: number) {
  return src.slice(0, pos).split('\n').length
}

/** Every call `fn(` in `src` with its argument texts. */
function* calls(src: string, names: string[]) {
  const re = new RegExp(`(?<![\\w.:])(${names.join('|')})\\s*\\(`, 'g')
  for (const m of src.matchAll(re)) {
    // Skip function definitions like `fn to_html(`.
    if (/\bfn\s+$/.test(src.slice(Math.max(0, m.index! - 10), m.index!))) continue
    const { args } = splitArgs(src, m.index! + m[0].length)
    yield { name: m[1], args, pos: m.index! }
  }
}

// ---------------------------------------------------------------- markdown-rs options

function resolveOptionsText(src: string, expr: string | undefined, pos: number): string {
  if (!expr) return ''
  const e = expr.trim().replace(/^&/, '').trim()
  if (/^\w+$/.test(e)) return letBefore(src, e, pos) ?? `UNKNOWN ${e}`
  return e
}

/** Removes `key: Struct { … }` blocks (balanced) whose content does not affect parsing. */
function removeBlock(text: string, head: RegExp) {
  for (;;) {
    const m = head.exec(text)
    if (!m) return text
    const open = text.indexOf('{', m.index + m[0].length - 1)
    const { end } = splitArgs(text, open + 1)
    text = text.slice(0, m.index) + text.slice(end)
  }
}

function markdownRsSyntax(text: string): SyntaxName[] | Skip {
  if (!text) return []
  if (text.startsWith('UNKNOWN')) return { skip: text }
  let t = removeBlock(text, /compile\s*:\s*CompileOptions\s*\{/)
  t = t.replace(/mdx_(esm|expression)_parse\s*:\s*Some\(Box::new\(\w+\)\)/g, '')
  if (/math/i.test(t)) return { skip: 'math' }
  const out = new Set<SyntaxName>()
  if (/::gfm\(\)/.test(t)) out.add('gfm')
  if (/::mdx\(\)/.test(t)) out.add('mdx')
  for (const m of t.matchAll(/(?<![:\w])(\w+)\s*:(?!:)\s*([\w:]+)/g)) {
    const [, key, value] = m
    if (key === 'parse' || key === 'constructs') continue
    if (key === 'frontmatter' && value === 'true') out.add('frontmatter')
    else if (/^gfm_/.test(key) && value === 'true') out.add('gfm')
    else if (/^mdx_/.test(key) && value === 'true') out.add('mdx')
    else return { skip: `${key}: ${value}` }
  }
  return [...out]
}

// ---------------------------------------------------------------- sources

const skipped: Record<string, number> = {}
function countSkip(reason: string) {
  skipped[reason] = (skipped[reason] ?? 0) + 1
}

function extractMarkdownRs() {
  const dir = path.join(opensrc, 'wooorm/markdown-rs/main/tests')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.rs')).sort()) {
    const base = file.replace(/\.rs$/, '')
    if (/^math_/.test(base)) {
      console.log(`skip markdown-rs ${file}: math`)
      continue
    }
    if (base === 'commonmark') {
      console.log(`skip markdown-rs ${file}: same inputs as commonmark.json`)
      continue
    }
    const src = fs.readFileSync(path.join(dir, file), 'utf8')
    const fixtures: Fixture[] = []
    for (const call of calls(src, ['to_html', 'to_html_with_options', 'to_mdast', 'to_markdown', 'assert_serde'])) {
      const input = argValue(src, call.args[0] ?? '', call.pos)
      if (input === undefined) {
        countSkip('non-literal input')
        continue
      }
      const optsArg = call.name === 'assert_serde' ? call.args[2] : call.name === 'to_html' ? undefined : call.args[1]
      const syntax = markdownRsSyntax(resolveOptionsText(src, optsArg, call.pos))
      if ('skip' in syntax) {
        countSkip(`markdown-rs ${syntax.skip.split(':')[0]}`)
        continue
      }
      fixtures.push({ name: `${file}:${lineOf(src, call.pos)}`, input, syntax })
    }
    if (fixtures.length) writeFixtures(`markdown-rs-${base.replaceAll('_', '-')}.json`, fixtures)
  }
}

function extractMdxjsRs() {
  const root = path.join(opensrc, 'wooorm/mdxjs-rs/main')
  const fixtures: Fixture[] = []
  for (const file of walk(root, (p) => p.endsWith('.rs'))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const call of calls(src, ['compile', 'to_html_with_options', 'parse', 'hast_util_to_swc'])) {
      const input = argValue(src, call.args[0] ?? '', call.pos)
      if (input === undefined) continue
      const opts = resolveOptionsText(src, call.args[1], call.pos)
      if (/math/i.test(opts)) continue
      const syntax: SyntaxName[] = ['mdx']
      if (/gfm/.test(opts)) syntax.push('gfm')
      if (/frontmatter:\s*true/.test(opts)) syntax.push('frontmatter')
      fixtures.push({ name: `${path.relative(root, file)}:${lineOf(src, call.pos)}`, input, syntax })
    }
  }
  writeFixtures('mdxjs-rs.json', fixtures)
}

const BIT = {
  gfm: (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 11) | (1 << 21),
  frontmatter: (1 << 7) | (1 << 8),
  mdx: 1 << 17,
  unsupported: (1 << 5) | (1 << 6) | (1 << 10) | (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15) | (1 << 16) | (7 << 18) | (3 << 22),
}

function pulldownSyntax(text: string): SyntaxName[] | Skip {
  const flags = new Set(text.match(/ENABLE_[A-Z_]+/g) ?? [])
  if (text.includes('Options::all()')) return { skip: 'all options' }
  const out = new Set<SyntaxName>()
  for (const f of flags) {
    if (/MATH|SMART|DEFINITION|WIKILINK|SUBSCRIPT|SUPERSCRIPT|DIRECTIVE|HEADING_ATTRIBUTES/.test(f)) return { skip: f }
    if (/TABLES|FOOTNOTES|STRIKETHROUGH|TASKLISTS|GFM|ALERTS/.test(f)) out.add('gfm')
    if (/METADATA/.test(f)) out.add('frontmatter')
    if (/MDX/.test(f)) out.add('mdx')
  }
  return [...out]
}

function extractSatteriRust() {
  const root = path.join(opensrc, 'bruits/satteri/main/crates/satteri-pulldown-cmark/tests')
  // suite/*.rs: generated from pulldown-cmark spec files, all through test_markdown_html.
  for (const file of fs.readdirSync(path.join(root, 'suite')).filter((f) => f.endsWith('.rs') && f !== 'mod.rs').sort()) {
    if (file === 'spec.rs') {
      console.log('skip satteri suite spec.rs: same inputs as commonmark.json')
      continue
    }
    const src = fs.readFileSync(path.join(root, 'suite', file), 'utf8')
    const fixtures: Fixture[] = []
    for (const call of calls(src, ['test_markdown_html'])) {
      const input = argValue(src, call.args[0], call.pos)
      if (input === undefined) continue
      const [bits, smart, metadata, sub, wiki, deflist, container] = call.args.slice(2)
      let n = Number(bits)
      // Math, superscript and heading attributes only matter when their trigger character occurs.
      if (!input.includes('$')) n &= ~((1 << 10) | (3 << 22))
      if (!input.includes('^')) n &= ~(1 << 13)
      if (!input.includes('{')) n &= ~(1 << 6)
      if (n & BIT.unsupported || [smart, sub, wiki, deflist, container].includes('true')) {
        countSkip('satteri suite unsupported flag')
        continue
      }
      const syntax: SyntaxName[] = []
      if (n & BIT.mdx) syntax.push('mdx')
      if (n & BIT.frontmatter || metadata === 'true') syntax.push('frontmatter')
      if (n & BIT.gfm) syntax.push('gfm')
      const fn = /fn (\w+)\(\)[^]*$/.exec(src.slice(0, call.pos))?.[1]
      fixtures.push({ name: `${file}:${fn ?? lineOf(src, call.pos)}`, input, syntax })
    }
    if (fixtures.length) writeFixtures(`satteri-pulldown-${file.replace(/\.rs$/, '').replaceAll('_', '-')}.json`, fixtures)
    else console.log(`skip satteri suite ${file}: no supported cases`)
  }
  // Hand-written tests: per-file helper calls with known options.
  const handwritten: { file: string; fns: Record<string, (args: string[], src: string, pos: number) => SyntaxName[] | Skip> }[] = [
    { file: 'mdx.rs', fns: { mdx_events: () => ['mdx', 'gfm'] } },
    { file: 'errors.rs', fns: { parse: () => [], parse_all_options: () => ({ skip: 'all options' }) } },
    {
      file: 'html.rs',
      fns: {
        parse_to_html: () => [],
        parse_to_html_ext: (args, src, pos) => pulldownSyntax(resolveOptionsText(src, args[1], pos)),
      },
    },
    {
      file: 'gfm_autolink_markers.rs',
      fns: { html: () => ({ skip: 'math' }), assert_html: (args, src, pos) => pulldownSyntax(resolveOptionsText(src, args[1], pos)) },
    },
  ]
  const fixtures: Fixture[] = []
  for (const { file, fns } of handwritten) {
    const src = fs.readFileSync(path.join(root, file), 'utf8')
    for (const call of calls(src, Object.keys(fns))) {
      const input = argValue(src, call.args[0] ?? '', call.pos)
      if (input === undefined) {
        countSkip('non-literal input')
        continue
      }
      const syntax = fns[call.name](call.args, src, call.pos)
      if ('skip' in syntax) {
        countSkip(`satteri ${syntax.skip}`)
        continue
      }
      fixtures.push({ name: `${file}:${lineOf(src, call.pos)}`, input, syntax })
    }
  }
  writeFixtures('satteri-pulldown-tests.json', fixtures)
}

extractMarkdownRs()
extractMdxjsRs()
extractSatteriRust()
console.log('skipped:', skipped)

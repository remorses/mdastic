// Pathological inputs from cmark, cmark-gfm, commonmark.js, markdown-it, micromark, comrak and
// pulldown-cmark: deep nesting, unmatched delimiters, quadratic blowups.
//
//   fixtures  writes conformance/fixtures/pathological.json at 1/100 of the upstream size, small
//             enough for the remark oracle (it is quadratic on many of these), compared as trees.
//   check     runs mdastic only at 1/16, 1/4 and the full upstream size. Fails on a crash, on
//             more than BUDGET_MS, or on superlinear growth (time exponent vs input length).
//             Exits 1 when any case fails. Not part of vitest: it is a perf gate, not parity.
//
// Usage (from conformance/): pnpm exec tsx ../scripts/pathological.ts fixtures|check [name-filter]
import { performance } from 'node:perf_hooks'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { parse } from '../mdastic/src/index.ts'
import { toSyntax } from '../conformance/src/harness.ts'
import { writeFixtures } from './fixtures-lib.ts'

const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const gfm: SyntaxName[] = ['gfm']
const mdx: SyntaxName[] = ['mdx']
const math: SyntaxName[] = ['math']

// `n` is the upstream size. Generators must stay deterministic.
const cases: { name: string; n: number; syntax: SyntaxName[]; input: (n: number) => string }[] = [
  // cmark test/pathological_tests.py (cmark-gfm doubles most sizes)
  { name: 'cmark nested strong emph', n: 32500, syntax: [], input: (n) => '*a **a '.repeat(n) + 'b' + ' a** a*'.repeat(n) },
  { name: 'cmark many emph closers with no openers', n: 32500, syntax: [], input: (n) => 'a_ '.repeat(n) },
  { name: 'cmark many emph openers with no closers', n: 32500, syntax: [], input: (n) => '_a '.repeat(n) },
  { name: 'cmark many link closers with no openers', n: 32500, syntax: [], input: (n) => 'a]'.repeat(n) },
  { name: 'cmark many link openers with no closers', n: 32500, syntax: [], input: (n) => '[a'.repeat(n) },
  { name: 'cmark mismatched openers and closers', n: 25000, syntax: [], input: (n) => '*a_ '.repeat(n) },
  { name: 'cmark issue #389', n: 20000, syntax: [], input: (n) => '*a '.repeat(n) + '_a*_ '.repeat(n) },
  { name: 'cmark openers and closers multiple of 3', n: 25000, syntax: [], input: (n) => 'a**b' + 'c* '.repeat(n) },
  { name: 'cmark link openers and emph closers', n: 25000, syntax: [], input: (n) => '[ a_'.repeat(n) },
  { name: 'cmark pattern [ (]( repeated', n: 40000, syntax: [], input: (n) => '[ (]('.repeat(n) },
  { name: 'cmark pattern ![[]() repeated', n: 160000, syntax: [], input: (n) => '![[]()'.repeat(n) },
  { name: 'cmark nested brackets', n: 25000, syntax: [], input: (n) => '['.repeat(n) + 'a' + ']'.repeat(n) },
  { name: 'cmark nested block quotes', n: 25000, syntax: [], input: (n) => '> '.repeat(n) + 'a' },
  { name: 'cmark deeply nested lists', n: 500, syntax: [], input: (n) => range(n).map((i) => '  '.repeat(i) + '* a\n').join('') },
  { name: 'cmark backticks', n: 2500, syntax: [], input: (n) => range(n).map((i) => 'e' + '`'.repeat(i + 1)).join('') },
  { name: 'cmark unclosed links A', n: 30000, syntax: [], input: (n) => '[a](<b'.repeat(n) },
  { name: 'cmark unclosed links B', n: 30000, syntax: [], input: (n) => '[a](b'.repeat(n) },
  { name: 'cmark unclosed html comments', n: 300000, syntax: [], input: (n) => '</' + '<!--'.repeat(n) },
  { name: 'cmark empty lines in deeply nested lists', n: 30000, syntax: [], input: (n) => '- '.repeat(n) + 'x' + '\n'.repeat(n) },
  { name: 'cmark empty lines in nested lists in blockquote', n: 30000, syntax: [], input: (n) => '> ' + '- '.repeat(n) + 'x\n' + '>\n'.repeat(n) },
  { name: 'cmark emph in deep blockquote', n: 100000, syntax: [], input: (n) => '>'.repeat(n) + 'a*'.repeat(n) },
  { name: 'cmark many references', n: 80000, syntax: [], input: (n) => range(n).map((i) => `[${i}]: u\n`).join('') + '[0] '.repeat(Math.ceil(n / 16)) },
  { name: 'cmark nested inlines', n: 20000, syntax: [], input: (n) => '*'.repeat(n) + 'a' + '*'.repeat(n) },
  { name: 'cmark-gfm tables', n: 30000, syntax: gfm, input: (n) => 'aaa\rbbb\n-\v\n'.repeat(n) },
  // commonmark.js test/test.js
  { name: 'commonmark.js #172', n: 10000, syntax: [], input: (n) => '*_* _ '.repeat(n) },
  { name: 'commonmark.js deep backslash in link', n: 10000, syntax: [], input: (n) => '[' + '\\'.repeat(n) + '\n' },
  { name: 'commonmark.js backslashes in unclosed link title', n: 10000, syntax: [], input: (n) => '[test](\\url "' + '\\'.repeat(n) + '\n' },
  { name: 'commonmark.js unclosed empty links', n: 10000, syntax: [], input: (n) => '[]('.repeat(n) + '\n' },
  // markdown-it test/markdown-it/pathological.test.mjs
  { name: 'markdown-it emphasis **_* pattern', n: 50000, syntax: [], input: (n) => '**_* '.repeat(n) },
  { name: 'markdown-it backtick backslash pattern', n: 50000, syntax: [], input: (n) => '``\\'.repeat(n) },
  { name: 'markdown-it autolink <<<<> pattern', n: 400000, syntax: [], input: (n) => '<'.repeat(n) + '>' },
  { name: 'markdown-it hard break whitespace', n: 150000, syntax: [], input: (n) => 'x' + ' '.repeat(n) + 'x  \nx' },
  { name: 'markdown-it linkify trailing asterisks', n: 70000, syntax: gfm, input: (n) => 'https://test.com?' + '*'.repeat(n) + 'a' },
  { name: 'markdown-it linkify emails', n: 30000, syntax: gfm, input: (n) => 'ping a@b.co ok\n'.repeat(n) },
  { name: 'markdown-it linkify schemes', n: 70000, syntax: gfm, input: (n) => 'a://'.repeat(n) },
  { name: 'markdown-it quotes', n: 100000, syntax: [], input: (n) => '"a '.repeat(n) + "b' ".repeat(n) },
  // micromark test/perf.js
  { name: 'micromark strong', n: 10000, syntax: [], input: (n) => 'a**b'.repeat(n) },
  { name: 'micromark tons of definitions', n: 10000, syntax: [], input: (n) => '[a]: u\n'.repeat(n) },
  // comrak src/tests/pathological.rs and friends
  { name: 'comrak emphasis mod three', n: 20000, syntax: [], input: (n) => '*x '.repeat(n) + '.**'.repeat(n) },
  { name: 'comrak table columns', n: 100000, syntax: gfm, input: (n) => '|' + 'x|'.repeat(n) + '\n|' + '-|'.repeat(n) },
  { name: 'comrak table columns and rows', n: 2000, syntax: gfm, input: (n) => '|' + 'x|'.repeat(n) + '\n|' + '-|'.repeat(n) + '\n' + 'a\n'.repeat(n) },
  { name: 'comrak footnote definitions', n: 10000, syntax: gfm, input: (n) => '[^1]:'.repeat(n) + '\n'.repeat(n) },
  { name: 'comrak footnote label brackets', n: 20000, syntax: gfm, input: (n) => '[^'.repeat(n) + ']'.repeat(n) },
  { name: 'comrak autolink url dead zone', n: 40000, syntax: gfm, input: (n) => '://a'.repeat(n) + '](' },
  { name: 'comrak autolink www dead zone', n: 40000, syntax: gfm, input: (n) => '~www.a'.repeat(n) + '](' },
  { name: 'comrak autolink closing parens', n: 100000, syntax: gfm, input: (n) => 'http://a.b' + ')'.repeat(n) },
  { name: 'comrak many headings', n: 20000, syntax: [], input: (n) => '# a\n'.repeat(n) },
  { name: 'comrak deep blockquote markers', n: 150000, syntax: [], input: (n) => '>'.repeat(n) },
  // pulldown-cmark bench/benches/lib.rs and dos-fuzzer patterns
  { name: 'pulldown missing table cells', n: 2000, syntax: gfm, input: (n) => '|x'.repeat(n) + '\n' + '|-'.repeat(n) + '\n' + '|x\n'.repeat(n) },
  { name: 'pulldown link definition reuse', n: 2000, syntax: [], input: (n) => '[x]: ' + 'x'.repeat(n) + '\n[x]'.repeat(n) },
  { name: 'pulldown blank lines in nested lists', n: 2000, syntax: [], input: (n) => '- '.repeat(n) + 'a\n' + '\n'.repeat(n) },
  { name: 'pulldown emphasis strike pattern', n: 8000, syntax: gfm, input: (n) => 'a***b~~'.repeat(n) },
  { name: 'pulldown cdata pattern', n: 8000, syntax: [], input: (n) => 'a <![CDATA['.repeat(n) },
  { name: 'pulldown processing instruction pattern', n: 8000, syntax: [], input: (n) => 'a<?'.repeat(n) },
  { name: 'pulldown nested link destination pattern', n: 8000, syntax: [], input: (n) => '[](<'.repeat(n) },
  // MDX: nesting and unclosed expressions
  { name: 'mdx nested jsx', n: 20000, syntax: mdx, input: (n) => '<a>'.repeat(n) + '</a>'.repeat(n) },
  { name: 'mdx nested braces', n: 20000, syntax: mdx, input: (n) => '{'.repeat(n) + '}'.repeat(n) },
  { name: 'mdx expressions then unclosed', n: 20000, syntax: mdx, input: (n) => '{a}'.repeat(n) + '{' },
  { name: 'mdx many attributes', n: 20000, syntax: mdx, input: (n) => '<a ' + 'b={1} '.repeat(n) + '/>' },
  // Math: dollar runs mirror cmark backticks
  { name: 'math dollars', n: 2500, syntax: math, input: (n) => range(n).map((i) => 'e' + '$'.repeat(i + 1)).join('') },
  { name: 'math unmatched dollars', n: 100000, syntax: math, input: (n) => 'a $b '.repeat(n) },
  { name: 'math unclosed fences in quotes', n: 20000, syntax: math, input: (n) => '> $$\n'.repeat(n) },
]

const FIXTURE_SCALE = 100
const BUDGET_MS = 1000
const MAX_EXPONENT = 1.5
const all: SyntaxName[] = ['mdx', 'frontmatter', 'gfm']

const [command, filter = ''] = process.argv.slice(2)
const selected = cases.filter((c) => c.name.includes(filter))

if (command === 'fixtures') {
  const fixtures: Fixture[] = []
  for (const c of selected) {
    const n = Math.max(2, Math.round(c.n / FIXTURE_SCALE))
    fixtures.push({ name: `${c.name} n=${n}`, input: c.input(n), syntax: c.syntax })
    fixtures.push({ name: `${c.name} n=${n}`, input: c.input(n), syntax: all })
  }
  writeFixtures('pathological.json', fixtures)
} else if (command === 'check') {
  let failed = 0
  for (const c of selected) {
    for (const syntax of c.syntax.includes('mdx') ? [all] : [c.syntax, all]) {
      // Sizes n/16, n/4, n. Skip n when n/4 is already over budget: quadratic cases take minutes.
      const inputs = [16, 4, 1].map((d) => c.input(Math.max(1, Math.round(c.n / d))))
      time(inputs[0], syntax) // warm up the JIT
      const runs = [time(inputs[0], syntax), time(inputs[1], syntax)]
      if (runs[1].ms <= BUDGET_MS) runs.push(time(inputs[2], syntax))
      const [a, b] = runs.slice(-2)
      const ratio = inputs[runs.length - 1].length / inputs[runs.length - 2].length
      const exponent = Math.log(b.ms / Math.max(a.ms, 0.05)) / Math.log(ratio)
      const problems: string[] = []
      const crash = runs.find((r) => r.crash)?.crash
      if (crash) problems.push(`crash: ${crash}`)
      if (b.ms > BUDGET_MS) problems.push(`over ${BUDGET_MS} ms${runs.length < 3 ? ' at n/4' : ''}`)
      if (b.ms > 20 && exponent > MAX_EXPONENT) problems.push(`superlinear, exponent ${exponent.toFixed(2)}`)
      if (problems.length) failed++
      const status = problems.length ? 'FAIL' : 'ok  '
      const size = inputs[runs.length - 1].length
      const note = b.mdxError ? ' (returns MdxParseError)' : ''
      console.log(`${status} ${c.name} [${syntax.join(',')}] ${size} chars ${b.ms.toFixed(1)} ms${note} ${problems.join(', ')}`)
    }
  }
  console.log(`\npathological check: ${failed} failing`)
  process.exitCode = failed ? 1 : 0
} else {
  console.log('usage: pathological.ts fixtures|check [name-filter]')
  process.exitCode = 1
}

function time(input: string, syntax: SyntaxName[]) {
  const options = { syntax: toSyntax(syntax) }
  const start = performance.now()
  try {
    const result = parse(input, options)
    return { ms: performance.now() - start, crash: undefined, mdxError: result instanceof Error }
  } catch (error) {
    return { ms: performance.now() - start, crash: String(error).split('\n')[0], mdxError: false }
  }
}

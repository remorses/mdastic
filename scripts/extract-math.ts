// Math fixtures: inputs from the micromark-extension-math, mdast-util-math, remark-math and Sätteri
// math tests (run with capture stubs, see scripts/capture/), pulldown-cmark's math spec, d2l-en
// chapters, and existing real-world documents that contain `$`. Test inputs run with math alone,
// with gfm, and with mdx + frontmatter + gfm.
// Usage: pnpm exec tsx ../scripts/extract-math.ts
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { oracleStringifyWith } from '../conformance/src/oracle.ts'
import { fixturesDir, opensrc, sortSyntax, stringifyFixturesDir, walk, writeChunked, writeFixtures } from './fixtures-lib.ts'
import type { CaptureRecord } from './capture/runtime.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const register = path.join(__dirname, 'capture/register.ts')
const variants: SyntaxName[][] = [['math'], ['gfm', 'math'], ['mdx', 'frontmatter', 'gfm', 'math']]

const suites = [
  { out: 'math-micromark-extension-math', repo: 'micromark/micromark-extension-math/3.1.0', tests: ['test/index.js'] },
  { out: 'math-mdast-util-math', repo: 'syntax-tree/mdast-util-math/3.0.0', tests: ['test.js'] },
  {
    out: 'math-remark-math',
    repo: 'remarkjs/remark-math/main/packages',
    tests: ['remark-math/test.js', 'rehype-katex/test.js', 'rehype-mathjax/test.js', 'remark-html-katex/test.js'],
  },
  { out: 'math-satteri', repo: 'bruits/satteri/main/packages/satteri/test/conformance', tests: ['math.test.ts'] },
]

function shortName(name: string) {
  return name.length > 120 ? name.slice(0, 117) + '...' : name
}

function capture(file: string, tmp: string): CaptureRecord[] {
  const out = path.join(tmp, path.basename(path.dirname(file)) + '-' + path.basename(file) + '.json')
  const result = spawnSync(process.execPath, ['--no-warnings', '--import', register, file], {
    env: { ...process.env, CAPTURE_OUT: out },
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 1 << 28,
  })
  if (!fs.existsSync(out)) {
    console.log(`  ${file}: no capture (exit ${result.status})\n${(result.stderr || '').slice(0, 1500)}`)
    return []
  }
  const records = JSON.parse(fs.readFileSync(out, 'utf8')) as CaptureRecord[]
  console.log(`  ${file}: ${records.length} records (exit ${result.status})`)
  return records
}

function withVariants(fixtures: { name: string; input: string }[]): Fixture[] {
  return variants.flatMap((syntax) => fixtures.map((f) => ({ ...f, syntax })))
}

const mathHandlers = new Set(['math', 'inlineMath'])
const gfmHandlers = new Set(['delete', 'table', 'tableRow', 'tableCell', 'footnoteReference', 'footnoteDefinition'])

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdastic-math-'))
for (const suite of suites) {
  const repo = path.join(opensrc, suite.repo)
  if (!fs.existsSync(repo)) {
    console.log(`skip ${suite.out}: ${repo} missing`)
    continue
  }
  console.log(`== ${suite.out}`)
  const records = suite.tests.filter((t) => fs.existsSync(path.join(repo, t))).flatMap((t) => capture(path.join(repo, t), tmp))
  const inputs = records.flatMap((r) => (r.kind === 'parse' ? [{ name: shortName(r.name), input: r.value }] : []))
  writeFixtures(`${suite.out}.json`, withVariants(inputs))

  const trees = records.filter((r): r is Extract<CaptureRecord, { kind: 'tree' }> => r.kind === 'tree')
  if (!trees.length) continue
  const seen = new Set<string>()
  const entries: unknown[] = []
  for (const r of trees) {
    if (r.dropped.length) continue
    const syntax: SyntaxName[] = []
    if (r.handlers.some((h) => gfmHandlers.has(h))) syntax.push('gfm')
    // Processor captures carry no handler names; the processor uses remark-math.
    if (!r.handlers.length || r.handlers.some((h) => mathHandlers.has(h))) syntax.push('math')
    const key = JSON.stringify([r.tree, r.options, syntax])
    if (seen.has(key)) continue
    seen.add(key)
    try {
      oracleStringifyWith(structuredClone(r.tree) as any, syntax, structuredClone(r.options))
    } catch {
      continue
    }
    entries.push({ name: shortName(r.name), tree: r.tree, options: r.options, syntax: sortSyntax(syntax) })
  }
  if (!entries.length) continue
  writeChunked(stringifyFixturesDir, `${suite.out}.json`, entries)
  console.log(`wrote stringify-fixtures/${suite.out}.json: ${entries.length} trees`)
}
fs.rmSync(tmp, { recursive: true, force: true })

console.log('== pulldown-cmark math spec')
const spec = path.join(opensrc, 'pulldown-cmark/pulldown-cmark/main/pulldown-cmark/specs/math.txt')
if (fs.existsSync(spec)) {
  const text = fs.readFileSync(spec, 'utf8')
  const examples = [...text.matchAll(/^`{32} example[^\n]*\n([\s\S]*?)^\.$/gm)].map((m, i) => ({
    name: `math.txt example ${i + 1}`,
    input: m[1].replaceAll('→', '\t'),
  }))
  writeFixtures('math-pulldown-cmark.json', withVariants(examples))
}

console.log('== math-heavy documents')
const documents: Fixture[] = []
const d2l = path.join(opensrc, 'd2l-ai/d2l-en/main')
for (const file of walk(d2l, (p) => p.endsWith('.md') && path.relative(d2l, p).startsWith('chapter_'))) {
  const input = fs.readFileSync(file, 'utf8')
  if (input.includes('$')) documents.push({ name: 'd2l-en/' + path.relative(d2l, file), input, syntax: ['gfm', 'math'] })
}
for (const repo of ['micromark/micromark-extension-math/3.1.0', 'syntax-tree/mdast-util-math/3.0.0', 'remarkjs/remark-math/main']) {
  for (const file of walk(path.join(opensrc, repo), (p) => /readme\.md$/i.test(p))) {
    const input = fs.readFileSync(file, 'utf8')
    documents.push({ name: path.relative(opensrc, file), input, syntax: ['gfm', 'math'] }, { name: path.relative(opensrc, file), input, syntax: ['math'] })
  }
}
writeFixtures('math-realworld.json', documents)

// Real documents with incidental `$` (prices, shell prompts, template strings) under math.
const incidental: Fixture[] = []
for (const file of fs.readdirSync(fixturesDir).filter((f) => /^realworld-.*\.json$/.test(f)).sort()) {
  for (const f of JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as Fixture[]) {
    if (f.input.includes('$')) incidental.push({ name: `${file.replace(/\.json$/, '')}/${f.name}`, input: f.input, syntax: [...f.syntax, 'math'] })
  }
}
writeFixtures('math-realworld-dollars.json', incidental)

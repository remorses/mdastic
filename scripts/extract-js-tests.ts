// Runs upstream JS test suites (micromark, mdast-util-*, remark-*, mdx-js) with stubbed modules
// (see scripts/capture/) and turns the captured parser inputs and toMarkdown trees into fixtures.
// Usage: pnpm exec tsx ../scripts/extract-js-tests.ts [source-filter]
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { oracleStringifyWith } from '../conformance/src/oracle.ts'
import { opensrc, sortSyntax, stringifyFixturesDir, walk, writeChunked, writeFixtures } from './fixtures-lib.ts'
import type { CaptureRecord } from './capture/runtime.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const register = path.join(__dirname, 'capture/register.ts')

type Source = {
  out: string
  /** Repo dir relative to ~/.opensrc/repos/github.com. */
  repo: string
  tests: string[]
  syntax: SyntaxName[]
  /** Dirs (relative to repo) whose .md / .mdx files are added as fixtures, named by path. */
  fixtureDirs?: string[]
  /** Drop syntax [] inputs (used when they duplicate commonmark.json). */
  dropPlain?: boolean
  /** Extra copies of the parse fixtures with other syntax sets. */
  extraSyntax?: { out: string; syntax: SyntaxName[] }[]
}

const gfm: SyntaxName[] = ['gfm']
const mdx: SyntaxName[] = ['mdx']
const fm: SyntaxName[] = ['frontmatter']

const sources: Source[] = [
  { out: 'micromark-io', repo: 'micromark/micromark/main', tests: ['test/io/index.js'], syntax: [] },
  { out: 'micromark-misc', repo: 'micromark/micromark/main', tests: ['test/extension.js', 'test/index.js'], syntax: [] },
  { out: 'mdast-util-from-markdown', repo: 'syntax-tree/mdast-util-from-markdown/main', tests: ['test/index.js'], syntax: [], fixtureDirs: ['test/fixtures'] },
  { out: 'mdast-util-to-markdown', repo: 'syntax-tree/mdast-util-to-markdown/main', tests: ['test/index.js'], syntax: [] },
  { out: 'micromark-extension-gfm', repo: 'micromark/micromark-extension-gfm/main', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'micromark-extension-gfm-autolink-literal', repo: 'micromark/micromark-extension-gfm-autolink-literal/2.1.0', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'micromark-extension-gfm-footnote', repo: 'micromark/micromark-extension-gfm-footnote/2.1.0', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'micromark-extension-gfm-strikethrough', repo: 'micromark/micromark-extension-gfm-strikethrough/2.1.0', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'micromark-extension-gfm-table', repo: 'micromark/micromark-extension-gfm-table/2.1.1', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'micromark-extension-gfm-task-list-item', repo: 'micromark/micromark-extension-gfm-task-list-item/2.1.0', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'micromark-extension-mdx-jsx', repo: 'micromark/micromark-extension-mdx-jsx/3.0.2', tests: ['test/index.js'], syntax: mdx },
  { out: 'micromark-extension-mdx-expression', repo: 'micromark/micromark-extension-mdx-expression/main', tests: ['test/index.js'], syntax: mdx },
  { out: 'micromark-extension-mdxjs-esm', repo: 'micromark/micromark-extension-mdxjs-esm/3.0.0', tests: ['test/index.js'], syntax: mdx },
  { out: 'micromark-extension-mdx-md', repo: 'micromark/micromark-extension-mdx-md/main', tests: ['test.js', 'test/index.js'], syntax: mdx },
  {
    out: 'micromark-extension-mdxjs',
    repo: 'micromark/micromark-extension-mdxjs/main',
    tests: ['test.js', 'test/index.js'],
    syntax: mdx,
    extraSyntax: [{ out: 'micromark-extension-mdxjs-all', syntax: ['mdx', 'frontmatter', 'gfm'] }],
  },
  { out: 'micromark-extension-frontmatter', repo: 'micromark/micromark-extension-frontmatter/main', tests: ['test/index.js'], syntax: fm },
  { out: 'mdast-util-frontmatter', repo: 'syntax-tree/mdast-util-frontmatter/main', tests: ['test.js'], syntax: fm },
  { out: 'mdast-util-gfm', repo: 'syntax-tree/mdast-util-gfm/3.1.0', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixture'] },
  { out: 'mdast-util-gfm-autolink-literal', repo: 'syntax-tree/mdast-util-gfm-autolink-literal/main', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixture'] },
  { out: 'mdast-util-gfm-footnote', repo: 'syntax-tree/mdast-util-gfm-footnote/main', tests: ['test.js'], syntax: gfm },
  { out: 'mdast-util-gfm-strikethrough', repo: 'syntax-tree/mdast-util-gfm-strikethrough/main', tests: ['test.js'], syntax: gfm },
  { out: 'mdast-util-gfm-table', repo: 'syntax-tree/mdast-util-gfm-table/main', tests: ['test.js'], syntax: gfm },
  { out: 'mdast-util-gfm-task-list-item', repo: 'syntax-tree/mdast-util-gfm-task-list-item/main', tests: ['test.js'], syntax: gfm },
  { out: 'mdast-util-mdx', repo: 'syntax-tree/mdast-util-mdx/main', tests: ['test.js'], syntax: mdx },
  { out: 'mdast-util-mdx-jsx', repo: 'syntax-tree/mdast-util-mdx-jsx/main', tests: ['test.js'], syntax: mdx },
  { out: 'mdast-util-mdx-expression', repo: 'syntax-tree/mdast-util-mdx-expression/main', tests: ['test.js'], syntax: mdx },
  { out: 'mdast-util-mdxjs-esm', repo: 'syntax-tree/mdast-util-mdxjs-esm/main', tests: ['test.js'], syntax: mdx },
  { out: 'remark-gfm', repo: 'remarkjs/remark-gfm/main', tests: ['test/index.js'], syntax: gfm, fixtureDirs: ['test/fixtures'] },
  { out: 'remark-frontmatter', repo: 'remarkjs/remark-frontmatter/main', tests: ['test/index.js'], syntax: fm, fixtureDirs: ['test/fixtures'] },
  { out: 'remark-mdx', repo: 'mdx-js/mdx/main/packages/remark-mdx', tests: ['test/index.js'], syntax: mdx },
  {
    out: 'mdx-js-mdx',
    repo: 'mdx-js/mdx/main/packages/mdx',
    tests: ['test/compile.js', 'test/core.js', 'test/evaluate.js', 'test/syntax.js'],
    syntax: mdx,
  },
  // satteri conformance tests: helpers and src calls are replaced by recorders that set per-input syntax.
  ...fs
    .readdirSync(path.join(opensrc, 'bruits/satteri/main/packages/satteri/test/conformance'))
    .filter((f) => f.endsWith('.test.ts'))
    .filter((f) => !/^(directive|definition-list|math|hast-to-html|hast-data|hdata|svg|custom-node)\./.test(f))
    .map(
      (f): Source => ({
        out: 'satteri-' + f.replace(/\.test\.ts$/, ''),
        repo: 'bruits/satteri/main/packages/satteri/test/conformance',
        tests: [f],
        syntax: gfm,
        dropPlain: f === 'commonmark-spec-json.test.ts',
      }),
    ),
]

const mdxHandlers = new Set(['mdxJsxFlowElement', 'mdxJsxTextElement', 'mdxFlowExpression', 'mdxTextExpression', 'mdxjsEsm'])
const gfmHandlers = new Set(['delete', 'table', 'tableRow', 'tableCell', 'footnoteReference', 'footnoteDefinition', 'listItem', 'inlineCode'])
const fmHandlers = new Set(['yaml', 'toml'])

function treeSyntax(rec: Extract<CaptureRecord, { kind: 'tree' }>, fileSyntax: SyntaxName[]): SyntaxName[] {
  if (!rec.hasExtensions) return []
  const out = new Set<SyntaxName>()
  for (const h of rec.handlers) {
    if (mdxHandlers.has(h)) out.add('mdx')
    else if (gfmHandlers.has(h)) out.add('gfm')
    else if (fmHandlers.has(h)) out.add('frontmatter')
  }
  return out.size ? sortSyntax([...out]) : fileSyntax
}

function shortName(name: string) {
  return name.length > 120 ? name.slice(0, 117) + '...' : name
}

const filter = process.argv[2] ?? ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdastic-capture-'))

for (const source of sources) {
  if (filter && !source.out.includes(filter)) continue
  const repo = path.join(opensrc, source.repo)
  if (!fs.existsSync(repo)) {
    console.log(`skip ${source.out}: ${repo} missing`)
    continue
  }
  console.log(`== ${source.out}`)
  const records: CaptureRecord[] = []
  for (const test of source.tests) {
    const file = path.join(repo, test)
    if (!fs.existsSync(file)) continue
    const out = path.join(tmp, `${source.out}-${path.basename(test)}.json`)
    const result = spawnSync(process.execPath, ['--no-warnings', '--import', register, file], {
      env: { ...process.env, CAPTURE_OUT: out },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 1 << 28,
    })
    if (!fs.existsSync(out)) {
      console.log(`  ${test}: no capture (exit ${result.status})\n${(result.stderr || '').slice(0, 1500)}`)
      continue
    }
    const captured = JSON.parse(fs.readFileSync(out, 'utf8')) as CaptureRecord[]
    console.log(`  ${test}: ${captured.length} records (exit ${result.status})`)
    records.push(...captured)
  }

  const fixtures: Fixture[] = []
  for (const dir of source.fixtureDirs ?? []) {
    for (const file of walk(path.join(repo, dir), (p) => /\.mdx?$/.test(p))) {
      fixtures.push({ name: path.relative(path.join(repo, dir), file), input: fs.readFileSync(file, 'utf8'), syntax: source.syntax })
    }
  }
  let skippedInputs = 0
  for (const r of records) {
    if (r.kind !== 'parse') continue
    if (r.syntax === 'skip') {
      skippedInputs++
      continue
    }
    fixtures.push({ name: shortName(r.name), input: r.value, syntax: (r.syntax as SyntaxName[]) ?? source.syntax })
  }
  if (skippedInputs) console.log(`  skipped ${skippedInputs} inputs using unsupported constructs`)
  writeFixtures(`${source.out}.json`, source.dropPlain ? fixtures.filter((f) => f.syntax.length) : fixtures)
  for (const extra of source.extraSyntax ?? []) {
    writeFixtures(`${extra.out}.json`, fixtures.map((f) => ({ ...f, syntax: extra.syntax })))
  }

  const trees = records.filter((r): r is Extract<CaptureRecord, { kind: 'tree' }> => r.kind === 'tree')
  if (!trees.length) continue
  const seen = new Set<string>()
  const entries: unknown[] = []
  let throws = 0
  let skipped = 0
  for (const r of trees) {
    if (r.dropped.length) {
      skipped++
      continue
    }
    const syntax = treeSyntax(r, source.syntax)
    const key = JSON.stringify([r.tree, r.options, syntax])
    if (seen.has(key)) continue
    seen.add(key)
    try {
      oracleStringifyWith(structuredClone(r.tree) as any, syntax, structuredClone(r.options))
    } catch {
      throws++
      continue
    }
    entries.push({ name: shortName(r.name), tree: r.tree, options: r.options, syntax })
  }
  writeChunked(stringifyFixturesDir, `${source.out}.json`, entries)
  console.log(`wrote stringify-fixtures/${source.out}.json: ${entries.length} trees (${throws} oracle throws, ${skipped} with custom handlers/join dropped)`)
}
fs.rmSync(tmp, { recursive: true, force: true })

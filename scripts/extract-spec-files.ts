// Inputs from spec-format test files of other CommonMark implementations: pulldown-cmark specs,
// cmark / cmark-gfm / commonmark.js regression and extension files, comrak fixtures, md4c tests
// and markdown-it fixtures. Only inputs are kept; the remark oracle computes expected trees.
// Inputs already present in other fixture files (same syntax) are skipped.
// Usage (from conformance/): pnpm exec tsx ../scripts/extract-spec-files.ts
// Repos must be fetched first: opensrc path pulldown-cmark/pulldown-cmark kivikakk/comrak ...
import fs from 'node:fs'
import path from 'node:path'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { fixturesDir, opensrc, sortSyntax, syntaxKey, walk, writeFixtures } from './fixtures-lib.ts'

type Example = { name: string; input: string }

const fence = '`'.repeat(32)

/** `example` blocks of the CommonMark spec format: markdown, a `.` line, html, closing fence. `→` is a tab. */
function specExamples(file: string, prefix: string): Example[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out: Example[] = []
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    const heading = /^#{1,6} (.*)$/.exec(lines[i])
    if (heading) section = heading[1].trim()
    if (!lines[i].startsWith(fence + ' example')) continue
    const md: string[] = []
    i++
    while (i < lines.length && lines[i] !== '.') md.push(lines[i++])
    while (i < lines.length && lines[i] !== fence) i++
    out.push({ name: `${prefix} ${section} ${out.length + 1}`, input: md.map((l) => l + '\n').join('').replaceAll('→', '\t') })
  }
  return out
}

/** markdown-it fixture format: description lines, then `.` / input / `.` / output / `.`. */
function markdownItExamples(file: string, prefix: string): Example[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out: Example[] = []
  let description = ''
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '.') {
      if (lines[i].trim()) description = lines[i].trim()
      continue
    }
    const md: string[] = []
    i++
    while (i < lines.length && lines[i] !== '.') md.push(lines[i++])
    i++
    while (i < lines.length && lines[i] !== '.') i++
    out.push({ name: `${prefix} ${description} ${out.length + 1}`, input: md.map((l) => l + '\n').join('').replaceAll('→', '\t') })
    description = ''
  }
  return out
}

/** The checked-out branch folder of an opensrc repo (main or master). */
function repo(name: string) {
  const base = path.join(opensrc, name)
  const branch = fs.readdirSync(base).find((d) => d === 'main' || d === 'master')
  if (!branch) throw new Error(`fetch ${name} first: opensrc path ${name}`)
  return path.join(base, branch)
}

const existing = new Set<string>()
function loadExisting(skip: Set<string>) {
  for (const file of fs.readdirSync(fixturesDir)) {
    if (!file.endsWith('.json') || skip.has(file.replace(/(-\d+)?\.json$/, '.json'))) continue
    for (const f of JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as Fixture[]) {
      existing.add(syntaxKey(sortSyntax(f.syntax)) + '\0' + f.input)
    }
  }
}

function emit(file: string, groups: { examples: Example[]; syntax: SyntaxName[] }[]) {
  const fixtures: Fixture[] = []
  let known = 0
  for (const { examples, syntax } of groups) {
    for (const e of examples) {
      if (existing.has(syntaxKey(sortSyntax(syntax)) + '\0' + e.input)) {
        known++
        continue
      }
      fixtures.push({ name: e.name, input: e.input, syntax })
    }
  }
  console.log(`${file}: ${known} inputs already in other fixture files`)
  writeFixtures(file, fixtures)
}

const outputs = ['pulldown-cmark-specs.json', 'cmark-tests.json', 'comrak-fixtures.json', 'md4c-tests.json', 'markdown-it-fixtures.json']
loadExisting(new Set(outputs))
const gfm: SyntaxName[] = ['gfm']
const plain: SyntaxName[] = []
const txt = (dir: string) => walk(dir, (p) => p.endsWith('.txt'))

console.log('pulldown-cmark specs')
const pulldown = repo('pulldown-cmark/pulldown-cmark')
emit('pulldown-cmark-specs.json', [
  ...txt(path.join(pulldown, 'pulldown-cmark/specs')).map((f) => ({
    examples: specExamples(f, `pulldown ${path.basename(f, '.txt')}`),
    syntax: (f.includes('metadata_blocks') ? ['frontmatter', 'gfm'] : gfm) as SyntaxName[],
  })),
  ...txt(path.join(pulldown, 'pulldown-cmark/third_party')).map((f) => ({
    examples: specExamples(f, `pulldown ${path.relative(path.join(pulldown, 'pulldown-cmark/third_party'), f)}`),
    syntax: f.includes('/GitHub/') ? gfm : plain,
  })),
])

console.log('cmark, cmark-gfm, commonmark.js, commonmark-spec master')
const cmarkGroups: { examples: Example[]; syntax: SyntaxName[] }[] = []
for (const name of ['commonmark/cmark', 'commonmark/commonmark.js']) {
  for (const f of ['regression.txt', 'smart_punct.txt']) {
    cmarkGroups.push({ examples: specExamples(path.join(repo(name), 'test', f), `${name} ${f}`), syntax: plain })
  }
}
cmarkGroups.push({ examples: specExamples(path.join(repo('commonmark/commonmark-spec'), 'spec.txt'), 'commonmark-spec master'), syntax: plain })
for (const name of ['github/cmark-gfm', 'kivikakk/cmark-gfm']) {
  for (const f of txt(path.join(repo(name), 'test'))) {
    if (f.endsWith('spec.txt')) continue
    cmarkGroups.push({ examples: specExamples(f, `${name} ${path.basename(f)}`), syntax: gfm })
  }
}
emit('cmark-tests.json', cmarkGroups)

console.log('comrak fixtures')
const comrak = repo('kivikakk/comrak')
emit('comrak-fixtures.json', walk(path.join(comrak, 'src/tests/fixtures'), (p) => p.endsWith('.md')).map((f) => ({
  examples: specExamples(f, `comrak ${path.basename(f)}`),
  syntax: gfm,
})))

console.log('md4c tests')
const md4cPlain = new Set(['spec.txt', 'coverage.txt', 'regressions.txt', 'spec-hard-soft-breaks.txt'])
emit('md4c-tests.json', txt(path.join(repo('mity/md4c'), 'test')).map((f) => ({
  examples: specExamples(f, `md4c ${path.basename(f)}`),
  syntax: md4cPlain.has(path.basename(f)) ? plain : gfm,
})))

console.log('markdown-it fixtures')
const markdownIt = path.join(repo('markdown-it/markdown-it'), 'test/fixtures')
const markdownItGfm = new Set(['tables.txt', 'strikethrough.txt', 'linkify.txt'])
emit('markdown-it-fixtures.json', txt(markdownIt).map((f) => ({
  examples: markdownItExamples(f, `markdown-it ${path.relative(markdownIt, f)}`),
  syntax: markdownItGfm.has(path.basename(f)) ? gfm : plain,
})))

// Realistic benchmark: real documents, each parsed separately, like a docs site build or a renderer.
// Usage: NODE_ENV=production pnpm exec tsx src/bench.ts
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { parse, stringify } from 'mdastic/src'
import { gfm } from 'mdastic/src/gfm'
import { mdx } from 'mdastic/src/mdx'
import { frontmatter } from 'mdastic/src/frontmatter'
import { remark } from 'remark'
import remarkGfm from 'remark-gfm'
import remarkMdx from 'remark-mdx'
import remarkFrontmatter from 'remark-frontmatter'
import { toMarkdown } from 'mdast-util-to-markdown'
import { gfmToMarkdown } from 'mdast-util-gfm'
import { mdxToMarkdown } from 'mdast-util-mdx'
import { frontmatterToMarkdown } from 'mdast-util-frontmatter'
import { markdownToMdast, mdxToMdast } from 'satteri'
import MarkdownIt from 'markdown-it'
import { fixturesDir } from './harness.ts'
import type { Fixture } from './oracle.ts'

function corpus(file: string, syntax: string): string[] {
  const fixtures: Fixture[] = JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8'))
  return fixtures.filter((f) => f.syntax.join(',') === syntax).map((f) => f.input)
}

const markdownDocs = [...corpus('realworld-readmes.json', 'frontmatter,gfm'), ...corpus('realworld-mintlify.json', 'gfm')]
// Only documents remark accepts, so every tool does the same work.
const mdxDocs = corpus('realworld-holocron.json', 'mdx,frontmatter,gfm').filter((d) => {
  try {
    remark().use(remarkMdx).parse(d)
    return true
  } catch {
    return false
  }
})

function measure(docs: string[], fn: (doc: string) => unknown): number {
  const run = () => {
    for (const doc of docs) fn(doc)
  }
  const deadline = performance.now() + 400
  while (performance.now() < deadline) run()
  const samples: number[] = []
  for (let i = 0; i < 15; i++) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[7]!
}

function table(title: string, docs: string[], rows: [string, (doc: string) => unknown][]) {
  const kb = docs.reduce((n, d) => n + d.length, 0) / 1024
  console.log(`\n## ${title} (${docs.length} docs, ${kb.toFixed(0)} KB)\n`)
  console.log('| tool | ms | MB/s | vs remark |')
  console.log('| --- | ---: | ---: | ---: |')
  const results = rows.map(([name, fn]) => [name, measure(docs, fn)] as const)
  const base = results.find(([name]) => name.startsWith('remark'))![1]
  for (const [name, ms] of results) {
    console.log(`| ${name} | ${ms.toFixed(2)} | ${(kb / 1024 / (ms / 1000)).toFixed(1)} | ${(base / ms).toFixed(1)}x |`)
  }
}

const mdSyntax = [frontmatter(), gfm()]
const mdxSyntax = [mdx(), frontmatter(), gfm()]
const remarkMd = remark().use(remarkFrontmatter, ['yaml', 'toml']).use(remarkGfm).freeze()
const remarkMdxProcessor = remark().use(remarkMdx).use(remarkFrontmatter, ['yaml', 'toml']).use(remarkGfm).freeze()
const markdownIt = new MarkdownIt()
const mdToMarkdownExt = { extensions: [frontmatterToMarkdown(['yaml', 'toml']), gfmToMarkdown()] }
const mdxToMarkdownExt = { extensions: [mdxToMarkdown(), frontmatterToMarkdown(['yaml', 'toml']), gfmToMarkdown()] }

const bun = (globalThis as { Bun?: { version: string; revision: string } }).Bun
const runtime = bun ? `Bun ${bun.version}+${bun.revision.slice(0, 9)}` : `Node ${process.version}`
console.log(`${runtime}, ${process.arch}`)

table('Parse markdown + GFM', markdownDocs, [
  ['remark (remark-gfm, remark-frontmatter)', (d) => remarkMd.parse(d)],
  ['satteri 0.10.5 (Rust, napi)', (d) => markdownToMdast(d)],
  ['markdown-it 14 (tokens, not mdast)', (d) => markdownIt.parse(d, {})],
  ['**mdastic**', (d) => parse(d, { syntax: mdSyntax })],
  ['**mdastic** (positions: false)', (d) => parse(d, { syntax: mdSyntax, positions: false })],
])

table('Parse MDX (estree on)', mdxDocs, [
  ['remark (remark-mdx, gfm, frontmatter)', (d) => remarkMdxProcessor.parse(d)],
  ['satteri 0.10.5 (Rust, napi, no estree)', (d) => mdxToMdast(d)],
  ['**mdastic**', (d) => parse(d, { syntax: mdxSyntax })],
  ['**mdastic** (estree: false)', (d) => parse(d, { syntax: [mdx({ estree: false }), frontmatter(), gfm()] })],
])

const mdTrees = markdownDocs.map((d) => remarkMd.parse(d))
const mdxTrees = mdxDocs.map((d) => remarkMdxProcessor.parse(d))
let treeIndex = 0
table('Stringify markdown + GFM', markdownDocs, [
  ['remark (mdast-util-to-markdown)', () => toMarkdown(mdTrees[treeIndex++ % mdTrees.length]!, mdToMarkdownExt)],
  ['**mdastic**', () => stringify(mdTrees[treeIndex++ % mdTrees.length] as any, { syntax: mdSyntax })],
])
table('Stringify MDX', mdxDocs, [
  ['remark (mdast-util-to-markdown)', () => toMarkdown(mdxTrees[treeIndex++ % mdxTrees.length]!, mdxToMarkdownExt)],
  ['**mdastic**', () => stringify(mdxTrees[treeIndex++ % mdxTrees.length] as any, { syntax: mdxSyntax })],
])

table('Round trip MDX (parse + stringify, like holocron normalize)', mdxDocs, [
  ['remark', (d) => toMarkdown(remarkMdxProcessor.parse(d), mdxToMarkdownExt)],
  ['**mdastic**', (d) => {
    const tree = parse(d, { syntax: mdxSyntax })
    return tree instanceof Error ? tree : stringify(tree, { syntax: mdxSyntax })
  }],
])

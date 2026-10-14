import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { parse } from '../mdastic/src/index.ts'
import { mdx } from '../mdastic/src/mdx.ts'
import { frontmatter } from '../mdastic/src/frontmatter.ts'
import { gfm } from '../mdastic/src/gfm.ts'
import { fromMarkdown } from '../conformance/node_modules/mdast-util-from-markdown/index.js'
import { mdxjs } from '../conformance/node_modules/micromark-extension-mdxjs/index.js'
import { mdxFromMarkdown } from '../conformance/node_modules/mdast-util-mdx/index.js'
import { frontmatter as frontmatterExtension } from '../conformance/node_modules/micromark-extension-frontmatter/index.js'
import { frontmatterFromMarkdown } from '../conformance/node_modules/mdast-util-frontmatter/index.js'
import { gfm as gfmExtension } from '../conformance/node_modules/micromark-extension-gfm/index.js'
import { gfmFromMarkdown } from '../conformance/node_modules/mdast-util-gfm/index.js'
import { mdxToMdast } from '../conformance/node_modules/satteri/dist/index.js'

console.log('Read Holocron MDX corpus')
const fixtures: { input: string }[] = JSON.parse(fs.readFileSync(new URL('../conformance/fixtures/realworld-holocron.json', import.meta.url), 'utf8'))
const inputs = fixtures.map((f) => f.input)
const units = inputs.reduce((n, s) => n + s.length, 0)
const enabled = [mdx(), frontmatter(), gfm()]
const disabled = [mdx({ estree: false }), frontmatter(), gfm()]
const extensions = [mdxjs(), frontmatterExtension(['yaml', 'toml']), gfmExtension()]
const mdastExtensions = [mdxFromMarkdown(), frontmatterFromMarkdown(['yaml', 'toml']), gfmFromMarkdown()]
const warmups = 5
const runs = 25
console.log(`Corpus: ${inputs.length} documents, ${units} UTF-16 units, Node ${process.version}`)
console.log(`Each document parsed separately; ${warmups} warmups, ${runs} measured corpus passes`)

function bench(name: string, fn: (source: string) => ReturnType<typeof parse> | ReturnType<typeof fromMarkdown> | ReturnType<typeof mdxToMdast>): void {
  let errors = 0
  function run(): void {
    errors = 0
    for (const source of inputs) {
      try {
        const value = fn(source)
        if (value instanceof Error) errors++
      } catch { errors++ }
    }
  }
  console.log(`Warm up ${name}`)
  for (let i = 0; i < warmups; i++) run()
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  console.log(`${name}: ${samples[Math.floor(runs / 2)].toFixed(3)} ms median, ${errors} rejected documents`)
}

bench('mdastic, ESTree on', (source) => parse(source, { syntax: enabled }))
bench('mdastic, ESTree off', (source) => parse(source, { syntax: disabled }))
if (!process.argv.includes('--mdastic')) {
  bench('remark, ESTree on', (source) => fromMarkdown(source, { extensions, mdastExtensions }))
  bench('Sätteri 0.10.5 native', (source) => mdxToMdast(source))
}

import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { parse } from '../mdastic/src/index.ts'
import { gfm } from '../mdastic/src/gfm.ts'
import { fromMarkdown } from '../conformance/node_modules/mdast-util-from-markdown/index.js'
import { gfm as gfmExtension } from '../conformance/node_modules/micromark-extension-gfm/index.js'
import { gfmFromMarkdown } from '../conformance/node_modules/mdast-util-gfm/index.js'
import { markdownToMdast } from '../conformance/node_modules/satteri/dist/index.js'

console.log('Read README corpus')
const fixtures = JSON.parse(fs.readFileSync(new URL('../conformance/fixtures/realworld-readmes.json', import.meta.url), 'utf8'))
const inputs: string[] = []
let length = 0
for (const f of fixtures) {
  if (f.syntax.length || inputs.includes(f.input)) continue
  inputs.push(f.input)
  length += f.input.length
  if (length >= 167000) break
}
const source = inputs.join('\n\n').slice(0, 167000)
const syntax = [gfm()]
const extensions = [gfmExtension()]
const mdastExtensions = [gfmFromMarkdown()]
console.log(`Corpus: ${source.length} UTF-16 units, ${inputs.length} READMEs`)
function bench(name: string, fn: () => void): void {
  console.log(`Warm up ${name}`)
  for (let i = 0; i < 30; i++) fn()
  const samples: number[] = []
  for (let i = 0; i < 100; i++) { const start = performance.now(); fn(); samples.push(performance.now() - start) }
  samples.sort((a, b) => a - b)
  console.log(`${name}: ${samples[50].toFixed(3)} ms median, ${samples[10].toFixed(3)} ms p10`)
}
bench('mdastic', () => parse(source, { syntax }))
if (!process.argv.includes('--mdastic')) {
  bench('remark', () => fromMarkdown(source, { extensions, mdastExtensions }))
  bench('satteri', () => markdownToMdast(source))
}

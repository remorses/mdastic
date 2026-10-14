import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { stringify } from '../mdastic/src/index.ts'
import { gfm } from '../mdastic/src/gfm.ts'
import { mdx } from '../mdastic/src/mdx.ts'
import { frontmatter } from '../mdastic/src/frontmatter.ts'
import { oracleParse, oracleStringify } from '../conformance/src/oracle.ts'

console.log('Load a 180 KB corpus from installed package READMEs')
let corpus = ''
const store = path.resolve(import.meta.dirname, '../node_modules/.pnpm')
for (const folder of fs.readdirSync(store)) {
  const modules = path.join(store, folder, 'node_modules')
  if (!fs.existsSync(modules)) continue
  for (const name of fs.readdirSync(modules)) {
    const packagePath = path.join(modules, name)
    if (fs.lstatSync(packagePath).isSymbolicLink()) continue
    const file = ['readme.md', 'README.md']
      .map((name) => path.join(packagePath, name))
      .find((file) => fs.existsSync(file))
    if (file) corpus += fs.readFileSync(file, 'utf8') + '\n\n'
    if (corpus.length >= 180_000) break
  }
  if (corpus.length >= 180_000) break
}
corpus = corpus.slice(0, 180_000)
console.log(`Parse once with the oracle (${Buffer.byteLength(corpus)} bytes)`)
const tree = oracleParse(corpus, ['gfm'])
if (!('type' in tree)) throw new Error(tree.message)
const syntax = [gfm()]
if (process.env.STRESS_STRINGIFY) {
  const directory = path.resolve(import.meta.dirname, '../conformance/fixtures')
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.json')) continue
    const fixtures = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
    for (const fixture of fixtures) {
      if (fixture.input.length < 100_000) continue
      console.log(`Stress ${file}: ${fixture.name} (${fixture.input.length} chars)`)
      let start = performance.now()
      const tree = oracleParse(fixture.input, fixture.syntax)
      console.log(`Oracle parse ${(performance.now() - start).toFixed(1)} ms`)
      if (!('type' in tree)) continue
      start = performance.now()
      const syntax = fixture.syntax.map((name: string) => {
        if (name === 'gfm') return gfm()
        if (name === 'mdx') return mdx()
        if (name === 'frontmatter') return frontmatter(['yaml', 'toml'])
        throw new Error(`Unknown syntax: ${name}`)
      })
      const actual = stringify(tree as any, { syntax })
      console.log(`mdastic stringify ${(performance.now() - start).toFixed(1)} ms`)
      start = performance.now()
      const expected = oracleStringify(tree, fixture.syntax)
      console.log(`Oracle stringify ${(performance.now() - start).toFixed(1)} ms`)
      if (actual !== expected) throw new Error('Stress serializer output mismatch')
    }
  }
  process.exit(0)
}
const actual = stringify(tree as any, { syntax })
const expected = oracleStringify(tree, ['gfm'])
if (actual !== expected) throw new Error('Serializer output mismatch')
function median(run: () => string): number {
  for (let index = 0; index < 20; index++) run()
  const samples: number[] = []
  for (let index = 0; index < 51; index++) {
    const start = performance.now()
    run()
    samples.push(performance.now() - start)
  }
  return samples.sort((left, right) => left - right)[
    Math.floor(samples.length / 2)
  ]
}
console.log('Measure median after 20 warmups (51 samples)')
if (process.env.PROFILE_STRINGIFY) {
  console.log('Profile mdastic only (1000 iterations)')
  for (let index = 0; index < 1000; index++) stringify(tree as any, { syntax })
  process.exit(0)
}
const ours = median(() => stringify(tree as any, { syntax }))
const oracle = median(() => oracleStringify(tree, ['gfm']))
console.log(
  `mdastic ${ours.toFixed(3)} ms; oracle ${oracle.toFixed(3)} ms; speedup ${(oracle / ours).toFixed(2)}x`,
)

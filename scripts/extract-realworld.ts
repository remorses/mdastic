// Real documents, one fixture per file: holocron MDX docs, mdx-js docs, npm READMEs, satteri bench
// fixtures, and Mintlify's llms-full.txt split into pages.
// Usage: pnpm exec tsx ../scripts/extract-realworld.ts
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { opensrc, walk, writeFixtures } from './fixtures-lib.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const holocron = path.resolve(root, '../holocron')
const all: SyntaxName[] = ['mdx', 'frontmatter', 'gfm']
const md: SyntaxName[] = ['frontmatter', 'gfm']

function files(base: string, dirs: string[], ext: RegExp) {
  return dirs.flatMap((d) => walk(path.join(base, d), (p) => ext.test(p))).map((p) => ({ name: path.relative(base, p), input: fs.readFileSync(p, 'utf8') }))
}

console.log('holocron mdx docs')
writeFixtures(
  'realworld-holocron.json',
  files(holocron, ['website/src/pages', 'example', 'integration-tests/fixtures', 'template'], /\.mdx$/).map((f) => ({ ...f, syntax: all })),
)

console.log('mdx-js docs')
writeFixtures(
  'realworld-mdx-js-docs.json',
  files(path.join(opensrc, 'mdx-js/mdx/main'), ['docs'], /\.mdx$/).map((f) => ({ ...f, syntax: all })),
)

console.log('npm readmes')
const store = path.join(root, 'node_modules/.pnpm')
const readmes: Fixture[] = []
for (const entry of fs.readdirSync(store).sort()) {
  const modules = path.join(store, entry, 'node_modules')
  if (!fs.existsSync(modules)) continue
  for (const pkg of fs.readdirSync(modules)) {
    const dirs = pkg.startsWith('@') ? fs.readdirSync(path.join(modules, pkg)).map((p) => path.join(pkg, p)) : [pkg]
    for (const dir of dirs) {
      const full = path.join(modules, dir)
      if (fs.lstatSync(full).isSymbolicLink()) continue
      const readme = fs.readdirSync(full).find((f) => /^readme\.md$/i.test(f))
      if (!readme) continue
      const input = fs.readFileSync(path.join(full, readme), 'utf8')
      if (input.length < 500) continue
      readmes.push({ name: `${dir}/${readme}`, input, syntax: md }, { name: `${dir}/${readme}`, input, syntax: [] })
    }
  }
}
// Largest first: long READMEs exercise more constructs. Keep 80 documents.
const unique = [...new Map(readmes.map((r) => [r.name, r])).keys()]
const keep = new Set(unique.sort((a, b) => readmes.find((r) => r.name === b)!.input.length - readmes.find((r) => r.name === a)!.input.length).slice(0, 80))
writeFixtures('realworld-readmes.json', readmes.filter((r) => keep.has(r.name)))

console.log('satteri bench fixtures')
const bench = path.join(opensrc, 'bruits/satteri/main/packages/satteri/bench/fixtures')
writeFixtures(
  'realworld-satteri-bench.json',
  files(bench, ['.'], /\.mdx?$/).flatMap((f): Fixture[] =>
    f.name.endsWith('.mdx') ? [{ ...f, syntax: all }] : [{ ...f, syntax: md }, { ...f, syntax: [] }],
  ),
)

console.log('mintlify llms-full.txt')
const text = await (await fetch('https://www.mintlify.com/docs/llms-full.txt')).text()
const lines = text.split('\n')
const starts: number[] = []
for (let i = 0; i < lines.length - 1; i++) {
  if (lines[i].startsWith('# ') && lines[i + 1].startsWith('Source: ')) starts.push(i)
}
const pages: Fixture[] = starts.map((start, k) => {
  const page = lines.slice(start, starts[k + 1] ?? lines.length).join('\n')
  const source = lines[start + 1].slice('Source: '.length).replace('https://www.mintlify.com', '')
  return { name: source, input: page, syntax: ['gfm'] }
})
console.log(`  ${pages.length} pages`)
writeFixtures('realworld-mintlify.json', pages)

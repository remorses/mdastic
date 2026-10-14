// CommonMark 0.31.2 spec.json and cmark-gfm test/spec.txt examples.
import { writeFixtures } from './fixtures-lib.ts'
import type { Fixture } from '../conformance/src/oracle.ts'

console.log('fetching commonmark spec.json')
const cm = (await (await fetch('https://spec.commonmark.org/0.31.2/spec.json')).json()) as {
  markdown: string
  example: number
  section: string
}[]
console.log(`  ${cm.length} examples`)
writeFixtures(
  'commonmark.json',
  cm.map((e) => ({ name: `${e.section} ${e.example}`, input: e.markdown, syntax: [] })),
)

console.log('fetching cmark-gfm spec.txt')
const spec = await (await fetch('https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt')).text()
const fence = '`'.repeat(32)
const lines = spec.split('\n')
const gfm: Fixture[] = []
let section = ''
let example = 0
for (let i = 0; i < lines.length; i++) {
  const line = lines[i]
  const heading = /^#{1,6} (.*)$/.exec(line)
  if (heading) section = heading[1].trim()
  if (!line.startsWith(fence + ' example')) continue
  example++
  const ext = line.slice(fence.length + ' example'.length).trim()
  const md: string[] = []
  i++
  while (lines[i] !== '.') md.push(lines[i++])
  while (lines[i] !== fence) i++
  const input = md.map((l) => l + '\n').join('').replaceAll('→', '\t')
  gfm.push({ name: `${section} ${example}${ext ? ` (${ext})` : ''}`, input, syntax: ['gfm'] })
}
console.log(`  ${gfm.length} examples`)
writeFixtures('gfm-spec.json', gfm)

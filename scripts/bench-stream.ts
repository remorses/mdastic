// Streaming benchmark: each document arrives in small chunks, like an LLM response, and the
// whole text so far is parsed after every chunk. Compares full `parse` with `createStreamParser`.
// Usage: NODE_ENV=production pnpm exec tsx scripts/bench-stream.ts
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'
import { EXIT, createStreamParser, parse, visit, type Syntax } from '../mdastic/src/index.ts'
import { mdx } from '../mdastic/src/mdx.ts'
import { frontmatter } from '../mdastic/src/frontmatter.ts'
import { gfm } from '../mdastic/src/gfm.ts'

// About one LLM token batch per chunk.
const CHUNK_LENGTH = 32
const WARMUPS = 2
const RUNS = 7

function corpus(file: string): string[] {
  const fixtures: { input: string }[] = JSON.parse(fs.readFileSync(new URL(`../conformance/fixtures/${file}`, import.meta.url), 'utf8'))
  return fixtures.map((f) => f.input)
}

function bench({ name, docs, syntax }: { name: string; docs: string[]; syntax: Syntax[] }): void {
  const chars = docs.reduce((n, d) => n + d.length, 0)
  const chunks = docs.reduce((n, d) => n + Math.ceil(d.length / CHUNK_LENGTH), 0)
  console.log(`\n## ${name}: ${docs.length} docs, ${(chars / 1024).toFixed(0)} KB, ${chunks} chunks of ${CHUNK_LENGTH} chars`)
  const run = (stream: boolean) => {
    let errors = 0
    for (const doc of docs) {
      const parser = stream ? createStreamParser({ syntax }) : undefined
      for (let end = CHUNK_LENGTH; end < doc.length + CHUNK_LENGTH; end += CHUNK_LENGTH) {
        const text = doc.slice(0, end)
        const tree = parser ? parser.parse(text) : parse(text, { syntax })
        if (tree instanceof Error) errors++
      }
    }
    return errors
  }
  for (const [label, stream] of [['parse every chunk', false], ['createStreamParser', true]] as const) {
    for (let i = 0; i < WARMUPS; i++) run(stream)
    const samples: number[] = []
    let errors = 0
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now()
      errors = run(stream)
      samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(RUNS / 2)]
    console.log(`${label}: ${median.toFixed(0)} ms median (range ${samples[0].toFixed(0)} to ${samples.at(-1)!.toFixed(0)}), ${(median * 1000 / chunks).toFixed(1)} µs per chunk, ${errors} error results`)
  }
}

// Link definitions resolve across blocks, so documents with them are always parsed in full.
function hasDefinitions(doc: string, syntax: Syntax[]): boolean {
  const tree = parse(doc, { syntax })
  if (tree instanceof Error) return false
  let found = false
  visit(tree, ['definition', 'footnoteDefinition'], () => {
    found = true
    return EXIT
  })
  return found
}

const LONG_DOC_LENGTH = 16_000
const markdown = [frontmatter(), gfm()]
const readmes = corpus('realworld-readmes.json')
const longDocs = [...readmes, ...corpus('realworld-mintlify.json')].filter(
  (doc) => doc.length > LONG_DOC_LENGTH && !hasDefinitions(doc, markdown),
)

console.log(`Node ${process.version}, ${process.arch}`)
bench({ name: 'Markdown + GFM (READMEs)', docs: readmes, syntax: markdown })
bench({ name: 'MDX (Holocron docs)', docs: corpus('realworld-holocron.json'), syntax: [mdx(), frontmatter(), gfm()] })
bench({ name: `Markdown over ${LONG_DOC_LENGTH} chars, no link definitions`, docs: longDocs, syntax: markdown })

// Shared helpers for fixture extraction scripts: dedupe, oracle sanity check, size-checked write.
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { oracleParse, type Fixture, type SyntaxName } from '../conformance/src/oracle.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
export const fixturesDir = path.resolve(__dirname, '../conformance/fixtures')
export const stringifyFixturesDir = path.resolve(__dirname, '../conformance/stringify-fixtures')
export const opensrc = path.join(process.env.HOME!, '.opensrc/repos/github.com')

const MAX_BYTES = 5 * 1024 * 1024

export function syntaxKey(syntax: SyntaxName[]) {
  return [...syntax].sort().join(',')
}

/** Canonical syntax order (mdx, frontmatter, gfm) so files diff nicely. */
export function sortSyntax(syntax: SyntaxName[]): SyntaxName[] {
  const order: SyntaxName[] = ['mdx', 'frontmatter', 'gfm']
  return order.filter((s) => syntax.includes(s))
}

/** True when the oracle crashes with a non-MDX error (no vfile message source). Such fixtures are dropped. */
export function oracleCrashes(input: string, syntax: SyntaxName[]): string | undefined {
  const result = oracleParse(input, syntax)
  if ('type' in result) return undefined
  if (result.source || result.ruleId) return undefined
  return result.message
}

function serialize(entries: unknown[]) {
  return '[\n' + entries.map((e) => JSON.stringify(e)).join(',\n') + '\n]\n'
}

/** Dedupes by (input, syntax), drops oracle crashes, splits into numbered parts if > 5 MB. */
export function writeFixtures(file: string, fixtures: Fixture[]) {
  const seen = new Set<string>()
  const out: Fixture[] = []
  let dupes = 0
  let crashes = 0
  for (const f of fixtures) {
    if (typeof f.input !== 'string') continue
    const syntax = sortSyntax(f.syntax)
    const key = syntaxKey(syntax) + '\0' + f.input
    if (seen.has(key)) {
      dupes++
      continue
    }
    seen.add(key)
    const crash = oracleCrashes(f.input, syntax)
    if (crash) {
      crashes++
      console.log(`  drop (oracle crash) ${f.name}: ${crash.slice(0, 100)}`)
      continue
    }
    out.push({ name: f.name, input: f.input, syntax })
  }
  writeChunked(fixturesDir, file, out)
  console.log(`wrote ${file}: ${out.length} fixtures (${dupes} dupes, ${crashes} oracle crashes dropped)`)
  return out
}

export function writeChunked(dir: string, file: string, entries: unknown[]) {
  fs.mkdirSync(dir, { recursive: true })
  const text = serialize(entries)
  if (Buffer.byteLength(text) <= MAX_BYTES) {
    fs.writeFileSync(path.join(dir, file), text)
    return
  }
  const parts: unknown[][] = [[]]
  let size = 0
  for (const e of entries) {
    const len = Buffer.byteLength(JSON.stringify(e)) + 2
    if (size + len > MAX_BYTES * 0.95 && parts.at(-1)!.length) {
      parts.push([])
      size = 0
    }
    parts.at(-1)!.push(e)
    size += len
  }
  const base = file.replace(/\.json$/, '')
  parts.forEach((p, i) => fs.writeFileSync(path.join(dir, `${base}-${i + 1}.json`), serialize(p)))
  console.log(`  split ${file} into ${parts.length} parts`)
}

export function walk(dir: string, filter: (p: string) => boolean, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, acc)
    else if (filter(p)) acc.push(p)
  }
  return acc.sort()
}

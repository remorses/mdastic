// Shared differential harness: load fixtures, run mdastic and the oracle, diff the results.
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { parse, stringify, type Syntax } from 'mdastic/src'
import { gfm } from 'mdastic/src/gfm'
import { mdx } from 'mdastic/src/mdx'
import { frontmatter } from 'mdastic/src/frontmatter'
import { normalize, oracleParse, oracleStringify, toOracleError, type Fixture, type SyntaxName } from './oracle.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
export const fixturesDir = path.resolve(__dirname, '../fixtures')

export function loadFixtureFiles(): { file: string; fixtures: Fixture[] }[] {
  if (!fs.existsSync(fixturesDir)) return []
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, fixtures: JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as Fixture[] }))
}

const syntaxCache = new Map<string, Syntax[]>()
export function toSyntax(names: SyntaxName[]): Syntax[] {
  const key = names.join(',')
  let syntax = syntaxCache.get(key)
  if (!syntax) {
    // Same order as the oracle: mdx, frontmatter, gfm.
    syntax = []
    if (names.includes('mdx')) syntax.push(mdx())
    if (names.includes('frontmatter')) syntax.push(frontmatter())
    if (names.includes('gfm')) syntax.push(gfm())
    syntaxCache.set(key, syntax)
  }
  return syntax
}

export function mdasticParse(input: string, names: SyntaxName[]) {
  try {
    const tree = parse(input, { syntax: toSyntax(names) })
    return tree instanceof Error ? toOracleError(tree) : normalize(tree)
  } catch (error) {
    // A thrown error is always a bug: mdastic returns parse errors as values.
    return { crash: String((error as Error)?.stack ?? error) }
  }
}

export function expectedParse(input: string, names: SyntaxName[]) {
  return normalize(oracleParse(input, names))
}

/** Round trip: oracle tree → mdastic stringify vs oracle stringify. Null when the oracle cannot parse. */
export function stringifyPair(input: string, names: SyntaxName[]) {
  const tree = oracleParse(input, names)
  if (!('type' in tree)) return null
  let expected: string
  try {
    expected = oracleStringify(structuredClone(tree), names)
  } catch {
    return null
  }
  let actual: string
  try {
    actual = stringify(structuredClone(tree) as any, { syntax: toSyntax(names) })
  } catch (error) {
    actual = 'CRASH: ' + String((error as Error)?.stack ?? error)
  }
  return { expected, actual }
}

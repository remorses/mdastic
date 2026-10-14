// Shared differential harness: load fixtures, run mdastic and the oracle, diff the results.
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { parse, stringify, type Syntax } from 'mdastic/src'
import { gfm } from 'mdastic/src/gfm'
import { mdx } from 'mdastic/src/mdx'
import { frontmatter } from 'mdastic/src/frontmatter'
import { headingId } from 'mdastic/src/heading-id'
import {
  normalize,
  oracleParse,
  oracleStringify,
  oracleStringifyWith,
  toOracleError,
  type Fixture,
  type StringifyTreeFixture,
  type SyntaxName,
} from './oracle.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
export const fixturesDir = path.resolve(__dirname, '../fixtures')
export const stringifyFixturesDir = path.resolve(__dirname, '../stringify-fixtures')

function loadJsonDir<T>(dir: string): { file: string; fixtures: T[] }[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({ file, fixtures: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as T[] }))
}

export function loadFixtureFiles(): { file: string; fixtures: Fixture[] }[] {
  return loadJsonDir<Fixture>(fixturesDir)
}

/** Hand-built mdast trees captured from the upstream toMarkdown test suites. */
export function loadStringifyTreeFiles(): { file: string; fixtures: StringifyTreeFixture[] }[] {
  return loadJsonDir<StringifyTreeFixture>(stringifyFixturesDir)
}

/** Same tree + options through mdastic and the oracle. A thrown error becomes `THROWS: <message>` on both sides. */
export function stringifyTreePair(fixture: StringifyTreeFixture) {
  let expected: string
  try {
    expected = oracleStringifyWith(structuredClone(fixture.tree) as any, fixture.syntax, structuredClone(fixture.options))
  } catch (error) {
    expected = 'THROWS: ' + String((error as Error)?.message ?? error)
  }
  let actual: string
  try {
    actual = stringify(structuredClone(fixture.tree) as any, { ...structuredClone(fixture.options), syntax: toSyntax(fixture.syntax) } as any)
  } catch (error) {
    actual = 'THROWS: ' + String((error as Error)?.message ?? error)
  }
  return { expected, actual }
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
    if (names.includes('headingId')) syntax.push(headingId())
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

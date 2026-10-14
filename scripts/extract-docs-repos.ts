// Source MDX of documentation sites, one fixture per file. Unlike realworld-mintlify.json (built from
// the rendered llms-full.txt), these keep the original JSX, ESM and expressions.
// Usage (from conformance/): pnpm exec tsx ../scripts/extract-docs-repos.ts
// Fetch first: opensrc path mintlify/docs
import fs from 'node:fs'
import path from 'node:path'
import type { Fixture, SyntaxName } from '../conformance/src/oracle.ts'
import { opensrc, walk, writeFixtures } from './fixtures-lib.ts'

const all: SyntaxName[] = ['mdx', 'frontmatter', 'gfm']

console.log('mintlify/docs (English pages)')
const mintlify = path.join(opensrc, 'mintlify/docs/main')
const translations = /^(es|fr|zh)\//
const fixtures: Fixture[] = walk(mintlify, (p) => p.endsWith('.mdx'))
  .map((p) => path.relative(mintlify, p))
  .filter((p) => !translations.test(p))
  .map((p) => ({ name: `mintlify/docs ${p}`, input: fs.readFileSync(path.join(mintlify, p), 'utf8'), syntax: all }))
writeFixtures('realworld-mintlify-docs.json', fixtures)

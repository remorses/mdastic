// Pass-rate report per fixture file. Usage: tsx src/report.ts [parse|stringify|stringify-trees] [file-filter] [--fail N]
// Prints counts per file, then the first N failing fixtures (input + first diff path) for debugging.
import util from 'node:util'
import { expectedParse, loadFixtureFiles, loadStringifyTreeFiles, mdasticParse, stringifyPair, stringifyTreePair } from './harness.ts'

const modes = ['parse', 'stringify', 'stringify-trees'] as const
const mode = modes.find((m) => m === process.argv[2]) ?? 'parse'
const filter = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : ''
const failIdx = process.argv.indexOf('--fail')
const showFails = failIdx > 0 ? Number(process.argv[failIdx + 1]) : 5

function firstDiff(a: any, b: any, path = ''): string | undefined {
  if (Object.is(a, b)) return undefined
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) {
    return `${path || '<root>'}: got ${util.inspect(a, { depth: 1 })} expected ${util.inspect(b, { depth: 1 })}`
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${path}.${k}`)
    if (d) return d
  }
  return undefined
}

let total = 0
let passed = 0
const failures: string[] = []
const files: { file: string; fixtures: any[] }[] = mode === 'stringify-trees' ? loadStringifyTreeFiles() : loadFixtureFiles()
for (const { file, fixtures } of files) {
  if (filter && !file.includes(filter)) continue
  let ok = 0
  for (const [i, f] of fixtures.entries()) {
    let diff: string | undefined
    if (mode === 'parse') {
      diff = firstDiff(mdasticParse(f.input, f.syntax), expectedParse(f.input, f.syntax))
    } else if (mode === 'stringify-trees') {
      const pair = stringifyTreePair(f)
      diff = pair.actual !== pair.expected ? `got ${JSON.stringify(pair.actual)}\n  expected ${JSON.stringify(pair.expected)}` : undefined
    } else {
      const pair = stringifyPair(f.input, f.syntax)
      diff = pair && pair.actual !== pair.expected ? `got ${JSON.stringify(pair.actual)}\n  expected ${JSON.stringify(pair.expected)}` : undefined
    }
    const input = mode === 'stringify-trees' ? `tree: ${JSON.stringify(f.tree)}\n  options: ${JSON.stringify(f.options)}` : `input: ${JSON.stringify(f.input)}`
    if (diff) failures.push(`${file}#${i} ${f.name} [${f.syntax.join(',')}]\n  ${input}\n  ${diff}`)
    else ok++
  }
  total += fixtures.length
  passed += ok
  console.log(`${ok === fixtures.length ? 'ok  ' : 'FAIL'} ${file}: ${ok}/${fixtures.length}`)
}
console.log(`\n${mode}: ${passed}/${total} passed (${total ? ((passed / total) * 100).toFixed(1) : 0}%)`)
for (const f of failures.slice(0, showFails)) console.log('\n' + f)

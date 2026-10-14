import util from 'node:util'
import { expectedParse, loadFixtureFiles, mdasticParse } from '../conformance/src/harness.ts'

function firstDiff(a: any, b: any, path = ''): { path: string; actual: any; expected: any } | undefined {
  if (Object.is(a, b)) return
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return { path, actual: a, expected: b }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const diff = firstDiff(a[k], b[k], `${path}.${k}`)
    if (diff) return diff
  }
}

const failures: any[] = []
let all = 0
let pass = 0
for (const { file, fixtures } of loadFixtureFiles()) {
  if (process.argv[2] && !file.includes(process.argv[2])) continue
  const selected = fixtures.filter(f => !f.syntax.includes('mdx'))
  let passed = 0
  for (const f of selected) {
    const actual = mdasticParse(f.input, f.syntax)
    const expected = expectedParse(f.input, f.syntax)
    const diff = firstDiff(actual, expected)
    if (diff) failures.push({ file, name: f.name, input: f.input, syntax: f.syntax, ...diff })
    else passed++
  }
  if (selected.length) console.log(`${file}: ${passed}/${selected.length}`)
  all += selected.length
  pass += passed
}
console.log(`CORE: ${pass}/${all}`)
console.log(`FAILURES: ${failures.length}`)
for (const f of failures.slice(0, Number(process.argv[3] ?? 30))) console.log(f.file, f.name, JSON.stringify(f.input.length < 500 ? f.input : f.input.slice(0, 100) + '…'), f.path, 'got', util.inspect(f.actual, { depth: 1 }), 'want', util.inspect(f.expected, { depth: 1 }))

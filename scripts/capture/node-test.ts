// Stub of node:test (and vitest's test/describe) that runs every test body serially and tracks the
// test name for captured inputs. `t.test()` runs immediately (callers await it); a global `test()`
// or `describe()` inside a running body (vitest nesting) is queued and runs after that body.
import { nameStack, universal } from './runtime.ts'

let chain: Promise<void> = Promise.resolve()
const frames: { children: [string, any][] }[] = []

async function run(name: string, fn: any) {
  if (typeof fn !== 'function') return
  nameStack.push(String(name))
  const frame = { children: [] as [string, any][] }
  frames.push(frame)
  const context: any = new Proxy(
    { test: contextTest, it: contextTest, describe: contextTest, name, signal: new AbortController().signal },
    { get: (t: any, k) => (k in t ? t[k] : universal) },
  )
  try {
    await Promise.race([
      Promise.resolve().then(() => fn(context, () => {})),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ])
  } catch {}
  frames.pop()
  for (const [childName, childFn] of frame.children) await run(childName, childFn)
  nameStack.pop()
}

function args(a: any, b: any, c: any): [string, any] {
  if (typeof a === 'function') return [a.name || 'anonymous', a]
  if (typeof b === 'function') return [a, b]
  return [a, c]
}

function contextTest(a: any, b?: any, c?: any) {
  const [name, fn] = args(a, b, c)
  return run(name, fn)
}

function globalTest(a: any, b?: any, c?: any) {
  const [name, fn] = args(a, b, c)
  const frame = frames.at(-1)
  if (frame) {
    frame.children.push([name, fn])
    return Promise.resolve()
  }
  chain = chain.then(() => run(name, fn))
  return chain
}

export const test: any = globalTest
test.skip = () => Promise.resolve()
test.todo = () => Promise.resolve()
test.only = globalTest
test.test = globalTest
test.concurrent = globalTest
test.each = (cases: any[]) => (name: string, fn: any) => {
  for (const [i, c] of cases.entries()) void globalTest(`${name} ${i}`, () => fn(...(Array.isArray(c) ? c : [c])))
}
test.for = (cases: any[]) => (name: string, fn: any) => {
  for (const [i, c] of cases.entries()) void globalTest(`${name} ${i}`, () => fn(c, universal))
}
test.skipIf = () => () => Promise.resolve()
test.runIf = (cond: any) => (cond ? globalTest : () => Promise.resolve())
export const it = test
export const describe = test
export const suite = test
export const before = () => {}
export const after = () => {}
export const beforeEach = () => {}
export const afterEach = () => {}
export const mock = universal
export default test

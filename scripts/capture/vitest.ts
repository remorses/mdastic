// vitest stub for running satteri's conformance tests under the capture hooks.
import { test } from './node-test.ts'
import { universal } from './runtime.ts'

export { test }
export const it = test
export const describe = test
export const expect = universal
export const vi = universal
export const beforeAll = () => {}
export const afterAll = () => {}
export const beforeEach = () => {}
export const afterEach = () => {}

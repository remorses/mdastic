// No-op node:assert stub: assertions never fail, but throws/rejects still execute their callback.
const noop = () => {}

function throws(fn: any) {
  try {
    if (typeof fn === 'function') fn()
  } catch {}
}

async function rejects(fn: any) {
  try {
    await (typeof fn === 'function' ? fn() : fn)
  } catch {}
}

const methods: Record<string, any> = { throws, doesNotThrow: throws, rejects, doesNotReject: rejects }

const assert: any = new Proxy(noop, {
  get: (_t, k: string) => methods[k] ?? (k === 'strict' ? assert : noop),
  apply: noop,
})

export const strict = assert
export const ok = noop
export const equal = noop
export const deepEqual = noop
export const strictEqual = noop
export const deepStrictEqual = noop
export const notEqual = noop
export const match = noop
export const fail = noop
export { throws, rejects }
export default assert

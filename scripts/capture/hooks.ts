// Node module hooks used to run upstream test files and capture the inputs they pass to the parser.
// - node:test / node:assert become no-op stubs (every test body runs, assertions never stop it).
// - micromark, fromMarkdown, toMarkdown, @mdx-js/mdx, unified, remark are wrapped to record calls.
// - Bare imports the opensrc clones cannot resolve fall back to the pnpm hoisted store, then to a stub.
import fs from 'node:fs'
import url from 'node:url'

const captureDir = new URL('./', import.meta.url)
const runtimeUrl = new URL('runtime.ts', captureDir).href
const fallbackParent = new URL('../../node_modules/.pnpm/_.js', captureDir).href

const wrapped: Record<string, string> = {
  micromark: `
    import {micromark as real} from 'micromark'
    import {record} from '${runtimeUrl}'
    export * from 'micromark'
    export function micromark(value, encoding, options) {
      record('parse', value, typeof encoding === 'object' && encoding ? encoding : options)
      return real(value, encoding, options)
    }
  `,
  'mdast-util-from-markdown': `
    import {fromMarkdown as real} from 'mdast-util-from-markdown'
    import {record} from '${runtimeUrl}'
    export * from 'mdast-util-from-markdown'
    export function fromMarkdown(value, encoding, options) {
      record('parse', value, typeof encoding === 'object' && encoding ? encoding : options)
      return real(value, encoding, options)
    }
  `,
  'mdast-util-to-markdown': `
    import {toMarkdown as real} from 'mdast-util-to-markdown'
    import {recordTree} from '${runtimeUrl}'
    export * from 'mdast-util-to-markdown'
    export function toMarkdown(tree, options) {
      recordTree(tree, options)
      return real(tree, options)
    }
  `,
  '@mdx-js/mdx': `
    import {record, universal} from '${runtimeUrl}'
    function rec(file) { record('parse', typeof file === 'string' ? file : file && file.value, undefined); return universal }
    export const compile = async (f) => rec(f)
    export const compileSync = rec
    export const evaluate = async (f) => rec(f)
    export const evaluateSync = rec
    export const run = async () => universal
    export const runSync = () => universal
    export const nodeTypes = []
    export function createProcessor() { return processor() }
    function processor() {
      const p = {use: () => p, data: () => p, freeze: () => p, parse: rec, process: async (f) => rec(f), processSync: rec, run: async () => universal, runSync: () => universal, stringify: () => ''}
      return p
    }
  `,
  unified: `
    import {fakeProcessor} from '${runtimeUrl}'
    export const unified = fakeProcessor
  `,
  remark: `
    import {fakeProcessor} from '${runtimeUrl}'
    export const remark = fakeProcessor
  `,
}

export async function resolve(specifier: string, context: any, nextResolve: any) {
  const parent: string | undefined = context.parentURL
  const fromWrapper = parent?.startsWith('capture-wrap:')
  if (specifier === 'node:test' || specifier === 'node:assert' || specifier === 'node:assert/strict') {
    return { url: new URL(specifier === 'node:test' ? 'node-test.ts' : 'assert.ts', captureDir).href, shortCircuit: true }
  }
  if (!fromWrapper && specifier in wrapped) return { url: 'capture-wrap:' + specifier, shortCircuit: true }
  if (parent?.includes('/bruits/satteri/')) {
    if (specifier === 'vitest') return { url: new URL('vitest.ts', captureDir).href, shortCircuit: true }
    if (/^\.\.?\/(\.\.\/)*helpers(\.js|\.ts)?$/.test(specifier)) {
      return { url: new URL('satteri-helpers.ts', captureDir).href, shortCircuit: true }
    }
    if (/^(\.\.\/)+src\//.test(specifier)) {
      return { url: 'capture-satteri-src:' + specifier + '?parent=' + encodeURIComponent(parent), shortCircuit: true }
    }
  }
  if (/^\.\.?\//.test(specifier) && specifier.endsWith('.js')) {
    try {
      return await nextResolve(specifier, context)
    } catch {
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context)
    }
  }
  if (specifier.startsWith('file:')) {
    try {
      return await nextResolve(specifier, context)
    } catch {
      return { url: 'capture-stub:' + specifier + '?parent=' + encodeURIComponent(parent ?? ''), shortCircuit: true }
    }
  }
  if (/^[./]|^node:/.test(specifier) || !parent) return nextResolve(specifier, context)
  try {
    if (fromWrapper) throw new Error('wrapper')
    return await nextResolve(specifier, context)
  } catch {
    try {
      return await nextResolve(specifier, { ...context, parentURL: fallbackParent })
    } catch {
      return { url: 'capture-stub:' + specifier + '?parent=' + encodeURIComponent(parent), shortCircuit: true }
    }
  }
}

export async function load(u: string, context: any, nextLoad: any) {
  if (u.startsWith('capture-wrap:')) {
    return { format: 'module', source: wrapped[u.slice('capture-wrap:'.length)], shortCircuit: true }
  }
  if (u.startsWith('capture-stub:')) {
    const [spec, query] = u.slice('capture-stub:'.length).split('?parent=')
    return { format: 'module', source: stubSource(spec, decodeURIComponent(query)), shortCircuit: true }
  }
  if (u.startsWith('capture-satteri-src:')) {
    const [spec, query] = u.slice('capture-satteri-src:'.length).split('?parent=')
    const names = importedNames(spec, decodeURIComponent(query))
    const source = [
      `import {universal, satteriSrcExport} from '${runtimeUrl}'`,
      'export default universal',
      ...[...names].map((n) => `export const ${n} = satteriSrcExport(${JSON.stringify(n)})`),
    ].join('\n')
    return { format: 'module', source, shortCircuit: true }
  }
  if (u.endsWith('.json') && context.importAttributes?.type !== 'json') {
    return { format: 'json', source: fs.readFileSync(url.fileURLToPath(u), 'utf8'), shortCircuit: true }
  }
  return nextLoad(u, context)
}

/** Module exporting every name the parent imports from `spec`, each bound to a universal no-op proxy. */
function importedNames(spec: string, parent: string) {
  let code = ''
  try {
    code = fs.readFileSync(url.fileURLToPath(parent), 'utf8')
  } catch {}
  const names = new Set<string>()
  const escaped = spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const re = new RegExp(`(?:import|export)\\s+(?!type\\b)([^;'"]*?)\\s+from\\s+['"]${escaped}['"]`, 'g')
  for (const m of code.matchAll(re)) {
    const braces = /\{([^}]*)\}/.exec(m[1])
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (name && name !== 'default' && !part.trim().startsWith('type ')) names.add(name)
      }
    }
  }
  return names
}

function stubSource(spec: string, parent: string) {
  const names = importedNames(spec, parent)
  return [
    `import {universal} from '${runtimeUrl}'`,
    'export default universal',
    ...[...names].map((n) => `export const ${n} = universal`),
  ].join('\n')
}

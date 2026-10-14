// Capture runtime shared by the hook-generated wrappers and stubs. Writes records to $CAPTURE_OUT on exit.
import fs from 'node:fs'

export type CaptureRecord =
  /** `syntax` overrides the source's default syntax; 'skip' marks unsupported constructs (math, directives…). */
  | { kind: 'parse'; name: string; value: string; syntax?: string[] | 'skip' }
  | { kind: 'tree'; name: string; tree: unknown; options: Record<string, unknown>; handlers: string[]; hasExtensions: boolean; dropped: string[] }

const records: CaptureRecord[] = []
export const nameStack: string[] = []
let counter = 0

export function currentName() {
  return nameStack.join(' > ') || `top-level ${++counter}`
}

export function record(_kind: 'parse', value: unknown, _options: unknown, syntax?: string[] | 'skip') {
  let text: string | undefined
  if (typeof value === 'string') text = value
  else if (value instanceof Uint8Array) text = new TextDecoder().decode(value)
  if (text !== undefined) records.push({ kind: 'parse', name: currentName(), value: text, ...(syntax && { syntax }) })
}

const unsupportedFeatures = ['math', 'directive', 'headingAttributes', 'superscript', 'subscript', 'wikilinks', 'definitionList', 'smartPunctuation', 'smartypants']

/** Syntax for a satteri `features` object (gfm and frontmatter default to on). */
export function satteriFeatures(features: any, mdx: boolean): string[] | 'skip' {
  const f = features && typeof features === 'object' ? features : {}
  if (unsupportedFeatures.some((k) => f[k])) return 'skip'
  const out: string[] = []
  if (mdx) out.push('mdx')
  if (f.frontmatter !== false) out.push('frontmatter')
  if (f.gfm !== false) out.push('gfm')
  return out
}

// Recording stub for satteri's src exports: markdownTo*, mdxTo*, evaluate, compile, create*Handle record their input.
export function satteriSrcExport(name: string) {
  return (...args: any[]) => {
    const [input, second] = args
    if (typeof input === 'string' && /^(markdown|mdx|evaluate|compile|create)/.test(name)) {
      const mdx = /^(mdx|evaluate|compile|createMdx)/.test(name)
      const features = name.startsWith('create') ? second : second?.features
      record('parse', input, undefined, satteriFeatures(features, mdx))
    }
    return universal
  }
}

/** Collects handler names of all (nested) to-markdown extensions, used to infer the syntax. */
function handlerNames(extensions: any[] | undefined, acc: string[] = []) {
  for (const ext of extensions ?? []) {
    if (!ext || typeof ext !== 'object') continue
    acc.push(...Object.keys(ext.handlers ?? {}))
    handlerNames(ext.extensions, acc)
  }
  return acc
}

export function recordTree(tree: unknown, options: any) {
  const { extensions, ...rest } = options ?? {}
  const json: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === 'function' || k === 'handlers' || k === 'join') dropped.push(k)
    else json[k] = v
  }
  try {
    records.push({
      kind: 'tree',
      name: currentName(),
      tree: JSON.parse(JSON.stringify(tree)),
      // `_compiled` is a RegExp cache toMarkdown writes onto reused `unsafe` patterns.
      options: JSON.parse(JSON.stringify(json, (k, v) => (k === '_compiled' ? undefined : v))),
      handlers: handlerNames(extensions),
      hasExtensions: (extensions?.length ?? 0) > 0,
      dropped,
    })
  } catch {}
}

export const universal: any = new Proxy(function () {}, {
  get(_t, key) {
    if (key === 'then') return undefined
    if (key === Symbol.toPrimitive) return () => ''
    if (key === Symbol.iterator) return function* () {}
    if (key === Symbol.asyncIterator) return async function* () {}
    if (key === 'length') return 0
    return universal
  },
  apply: () => universal,
  construct: () => universal,
})

export function fakeProcessor() {
  const rec = (file: any) => {
    record('parse', typeof file === 'string' ? file : file?.value, undefined)
    return universal
  }
  const p: any = {
    use: () => p,
    data: () => p,
    freeze: () => p,
    parse: rec,
    process: async (f: any) => rec(f),
    processSync: rec,
    run: async () => universal,
    runSync: () => universal,
    // remark-stringify calls toMarkdown with the processor's extensions: the file syntax applies.
    stringify: (tree: unknown) => {
      recordTree(tree, { extensions: [{}] })
      return ''
    },
  }
  return p
}

process.on('exit', () => {
  if (process.env.CAPTURE_OUT) fs.writeFileSync(process.env.CAPTURE_OUT, JSON.stringify(records))
})

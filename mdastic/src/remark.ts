// Run tree-only remark transformers with a small processor/file adapter.
// This is not a unified pipeline and does not support parser extensions.
import type { Root } from './types.ts'

export interface RemarkFile {
  data: Record<string, unknown>
  path?: string
  value?: string | Uint8Array
  messages: Error[]
  message(reason: string | Error, ...options: any[]): Error
}

export interface RemarkProcessor {
  data(): Record<string, unknown>
  data(key: string): unknown
  data(key: string, value: unknown): RemarkProcessor
  data(value: Record<string, unknown>): RemarkProcessor
}

export type RemarkTransform = (tree: Root, file?: RemarkFile) => void | Promise<void>

/** Attach one tree-only remark plugin, without unified or parser extensions. */
export function remarkTransform<Plugin extends (...options: any[]) => any>(
  plugin: Plugin,
  ...options: Parameters<Plugin>
): RemarkTransform {
  let record: Record<string, unknown> = {}
  const processor: RemarkProcessor = {
    data(key?: string | Record<string, unknown>, value?: unknown): any {
      if (key === undefined) return record
      if (typeof key === 'object') {
        record = key
        return processor
      }
      if (arguments.length === 1) return record[key]
      record[key] = value
      return processor
    },
  }
  const transformer = plugin.call(processor, ...options)
  for (const key of ['micromarkExtensions', 'fromMarkdownExtensions', 'toMarkdownExtensions']) {
    if (key in record) {
      throw new Error(
        'The remark plugin adds syntax (' + key + '), which mdastic does not support through plugins. ' +
        'Use the built-in gfm(), mdx(), frontmatter() or headingId() instead.',
      )
    }
  }
  if (typeof transformer !== 'function') return () => {}
  return (tree, file = createFile()) => {
    if (transformer.length >= 3) {
      return new Promise<void>((resolve, reject) => {
        transformer(tree, file, (error?: Error | null) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
    const result = transformer(tree, file)
    if (result && typeof result.then === 'function') return Promise.resolve(result).then(() => {})
  }
}

function createFile(): RemarkFile {
  const messages: Error[] = []
  return {
    data: {},
    messages,
    message(reason) {
      const message = reason instanceof Error ? reason : new Error(reason)
      messages.push(message)
      return message
    },
  }
}

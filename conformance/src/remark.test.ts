import { expect, test } from 'vitest'
import { remark } from 'remark'
import remarkSqueezeParagraphs from 'remark-squeeze-paragraphs'
import remarkGfm from 'remark-gfm'
import { parse, type Root } from 'mdastic'
import { remarkTransform, type RemarkProcessor } from 'mdastic/remark'

test('real tree-only plugins produce the same tree as remark', async () => {
  const tree = parse('# Title\n\ntext') as Root
  tree.children.push({ type: 'paragraph', children: [{ type: 'text', value: '  ' }] })
  const expected = await remark().use(remarkSqueezeParagraphs).run(structuredClone(tree) as any)
  await remarkTransform(remarkSqueezeParagraphs)(tree)
  expect(tree).toEqual(expected)
  expect(() => remarkTransform(remarkGfm)).toThrow('adds syntax')
})

test('attachment options, async and callback transforms share processor data and file messages', async () => {
  const tree = parse('text') as Root
  const transform = remarkTransform(function (this: RemarkProcessor, label: string) {
    this.data('label', label)
    const data = this.data()
    return async (_tree, file) => {
      file.data.label = data.label
      file.message(label)
      await Promise.resolve()
    }
  }, 'notice')
  await transform(tree)
  let fileSeen: any
  await remarkTransform(() => (_tree, file, next) => {
    fileSeen = file
    file.message('callback notice')
    queueMicrotask(() => next())
  })(tree)
  expect(fileSeen.messages.map((message: Error) => message.message)).toEqual(['callback notice'])
  await expect(remarkTransform(() => (_tree, _file, next) => next(new Error('failed')))(tree)).rejects.toThrow('failed')
  expect(remarkTransform(() => undefined)(tree)).toBeUndefined()
  for (const key of ['fromMarkdownExtensions', 'toMarkdownExtensions']) {
    expect(() => remarkTransform(function (this: RemarkProcessor) {
      this.data()[key] = []
    })).toThrow(key)
  }
})

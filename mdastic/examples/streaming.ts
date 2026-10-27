// Parse an LLM answer while it streams in, reusing finished blocks.
// Run: pnpm --dir mdastic build && pnpm --dir mdastic exec tsx examples/streaming.ts
import { createStreamParser, type Root } from 'mdastic'
import { mdx } from 'mdastic/mdx'
import { gfm } from 'mdastic/gfm'

const ANSWER = `# Caching

Closed blocks are parsed **once**.

<Callout type="info">
  The live block is parsed again on every chunk.
</Callout>

| chunk | parsed |
| ----- | ------ |
| 1     | tail   |

\`\`\`ts
const tree = parser.parse(text)
\`\`\`
`
const CHUNK_LENGTH = 12

/** Stand-in for a model response: yields the answer in small pieces. */
function* modelStream(): Generator<string> {
  for (let i = 0; i < ANSWER.length; i += CHUNK_LENGTH) yield ANSWER.slice(i, i + CHUNK_LENGTH)
}

const parser = createStreamParser({ syntax: [mdx(), gfm()] })
let text = ''
let tree: Root | undefined
for (const chunk of modelStream()) {
  text += chunk
  const result = parser.parse(text)
  // Mid-stream MDX is often incomplete (`<Callout type=`). Keep showing the last good tree.
  if (result instanceof Error) {
    console.log(`waiting: ${result.reason}`)
    continue
  }
  const previous = tree?.children ?? []
  const reused = result.children.filter((node, i) => node === previous[i]).length
  console.log(`${result.children.length} blocks, ${reused} reused: ${result.children.map((node) => node.type).join(', ')}`)
  tree = result
}

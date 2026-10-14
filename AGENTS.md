# mdastic

Exact remark-compatible mdast parsing and serialization, without runtime parser dependencies.

## Parser architecture

```text
source ──► block.ts ──► deferred inline.ts ──► autolink.ts ──► tree.ts ──► mdast
               │                │                                ▲
               └──── definitions/footnotes ────────────────────────┘
scan.ts ──► ASCII/Unicode classification, entities, UTF-16 line positions
```

- `parser.ts` resets reusable module-level arenas and runs the phases synchronously.
- `tree.ts` stores node kinds, offsets, links and integer payloads in growable typed arrays.
- `inline.ts` uses reusable typed delimiter arrays. Nested spans resolve GFM and attention in remark's order.
- `block.ts` uses source line views and a reusable deferred-task arena (typed parents/start offsets,
  separate views), so references can precede definitions. Consumed views are released immediately.
- `scan.ts` finds CR/LF with native string searches once. Block lines and positions share the typed
  line-start index. Position lookups use a nearby cursor and binary-search fallback.
- `inline.ts` jumps between native-regex syntax candidates. Email-bearing views use an ASCII table;
  custom inline hooks keep character-by-character dispatch. Regex cursors reset before every search.
- `autolink.ts` searches URL prefixes and `@` candidates instead of retrying at every text character.
- GFM has two autolink passes: tokenizer links keep positions; fallback transform nodes have no positions.

## Extension boundary

`parseDocument(source, config, hooks?)` accepts flow and inline hooks for additional syntax.
Flow hooks append arena nodes and return consumed line count. Inline hooks return an unattached
arena node and the next virtual offset. Map virtual offsets through `offset(view, index)`.
MDX mode already disables HTML flow/text, indented code and standard angle-bracket autolinks.
Do not recursively call `parseDocument` from a hook: the arena is reused. Use the current context.

- `mdx-parser.ts` owns JSX tags/attributes, ESM, cached container views and deferred JSX nesting.
- `mdx-scan.ts` uses the injected Acorn tokenizer to find expression boundaries, then validates
  once and remaps ESTree positions. Failed predictions retain micromark's brace-by-brace fallback.
- Inline JSX tags nest after markdown attention/link resolution, so crossing tags produce the
  same errors as remark. Flow JSX parents redirect block nodes through `flowParent`.
- `positions: false` only removes mdast positions. MDX still indexes lines for ESTree and errors.

## Verification

```text
pnpm --dir mdastic build
pnpm exec tsx scripts/check-core.ts
pnpm exec tsx scripts/bench-parse.ts
pnpm --dir conformance exec tsx src/report.ts parse
pnpm exec tsx scripts/bench-mdx.ts
```

The conformance directory contains the pinned remark oracle. Parser details and measured results
are in `docs/parser-conformance.md`. Generated entity and punctuation tables retain upstream licenses.

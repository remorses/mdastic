---
title: mdastic plan
description: Plan for mdastic, a fast centralized markdown + MDX parser and serializer that outputs the exact same mdast as remark, to replace remark in holocron, safe-mdx and remote-bundler.
---

# mdastic plan

One package. One `parse`, one `stringify`, one `visit`. Same mdast as remark (positions and
`data.estree` included). MDX, GFM, frontmatter and heading ids built in as subpath exports.
Target: **10x+ faster parse**, **5x+ faster stringify**, much smaller client bundle.

```ts
import { createMarkdown, visit } from 'mdastic'
import { mdx } from 'mdastic/mdx'
import { gfm } from 'mdastic/gfm'
import { frontmatter } from 'mdastic/frontmatter'

const md = createMarkdown({ syntax: [mdx(), gfm(), frontmatter(['yaml'])] })

const tree = md.parse(source)          // Root | MdxParseError (errore style)
if (tree instanceof Error) return tree
visit(tree, 'heading', (node) => {})   // node: Heading, fully typed
const out = md.stringify(tree)         // same string as remark-stringify + same extensions
```

## 1. What we use today

Inventory from `rg` over the 3 repos (imports, not counting tests).

| Repo | Parse | Serialize | Utils / types |
| --- | --- | --- | --- |
| holocron `vite/` | `remark` + `remark-mdx` + `remark-gfm` + `remark-frontmatter` (6 copies of the same processor), `micromark-heading-id` + `mdast-heading-id`, `safe-mdx/parse` `mdxParse` | `mdast-util-to-markdown` + `gfmToMarkdown` + `mdxToMarkdown` + `frontmatterToMarkdown` (5 places) | `unist-util-visit`, `github-slugger`, `@types/mdast`, hand-written estree builders in `jsx-utils.ts` |
| holocron `cli/` | same stack in `diagram-fix.ts`, `maintain.ts` (validation only) | `toMarkdown` for tables | |
| safe-mdx | `parse.ts`: `remark().use(remarkMdx).use(remarkFrontmatter,['yaml','toml']).use(remarkGfm)` + `remarkMarkAndUnravel`; `incremental-parse.ts` slices top level | `remark-stringify` in tests | `unified` (Plugin type), `unist-util-visit(-parents)`, `mdast-util-mdx-jsx` types, `estree-jsx`, `eval-estree-expression` |
| remote-bundler | `remark().use(remarkGfm).parse(text)` in a **client** chat component | | |

Where each holocron file uses it:

```
normalize-mdx.ts        parse+run 8 transforms, toMarkdown, then remarkMarkAndUnravel
mdx-processor.ts        reuses normalized mdast, toMarkdown again after image rewrite
remark-headings.ts      ONLY syntax plugin: pushes micromark/fromMarkdown ext via this.data()
remark-details-toggle   re-parses a tiny MDX string to build an estree attribute
remark-inline-imports   parses imported .md files (fallback path)
sync.ts                 quickMdxParser() for inline imports
raw-markdown.ts         parse + visit + toMarkdown (agent markdown)
app-factory.tsx         mdxParse per request (memoized), banner mdxParse
chat-restore / chat-render / mdx-components-map   mdxParse at render time
cli/diagram-fix.ts      parse (mdx, fallback md), toMarkdown tables
cli/maintain.ts         parse only to validate MDX
```

Facts that shape the design:

- **All our remark plugins are tree transformers** except `remark-headings` (`{#id}` syntax).
- **safe-mdx needs `data.estree`** on `mdxjsEsm`, expressions and attribute expressions.
  `eval-estree-expression` evaluates it. holocron also builds estree by hand.
- `hast-util-to-html` is only used for refractor output. Out of scope.
- holocron serializes, then safe-mdx re-parses the string. **Stringify must be exact.**

## 2. Why the current stack is slow

Measured on a 167 KB README corpus (Node 24, Apple Silicon):

| Parser | Output | ms |
| --- | --- | --- |
| remark-parse + gfm (micromark) | mdast | **51** |
| remark + mdx (estree on) | mdast | **55** |
| markdown-it `parse` | tokens | 3.7 |
| commonmark.js | AST | 1.4 |
| Sätteri (Rust napi) | mdast, deep equal to remark+gfm incl. positions | 1.1 |

Root causes in micromark (read in `micromark/packages/micromark/dev/lib/create-tokenizer.js`):

1. Every char goes through `effects.consume` into a **different state closure**. The
   `go(code)` call site is megamorphic, V8 cannot inline.
2. Every token allocates an event pair + 2 point objects with `_index`/`_bufferIndex`.
3. `attempt()` backtracks by saving and restoring chunks and events.
4. `subtokenize` re-tokenizes nested content in repeated passes until stable.
5. `mdast-util-from-markdown` walks the whole event array again to build the tree.
6. **MDX expressions are O(k) acorn parses.** `micromark-factory-mdx-expression` calls
   acorn at **every** `}` until one parses (`{` is not counted in "gnostic" mode). An
   attribute like `{{a: {b: 1}}}` costs 3 full acorn parses plus a position-fixing walk.
7. `mdast-util-to-markdown` `safe()` compiles `unsafe` patterns into regexes and runs them
   over every text value. `mdast-util-gfm-autolink-literal` runs regex `findAndReplace`
   over every text node after parsing.

**No pure-TS fast mdast parser exists.** Sätteri is native only (napi/WASI) and its MDX has
no estree. That is the gap mdastic fills: pure TS, runs in Workers and browsers.

## 3. Repos to read and incorporate

Behavior source of truth (we port semantics from these, not code shape):

| Repo | What we take |
| --- | --- |
| [micromark/micromark](https://github.com/micromark/micromark) | CommonMark constructs, `test/io/**` (37 files), `test/commonmark.js` |
| [syntax-tree/mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown) | exact tree rules: list `spread`, positions, text merging, `prepareList`; 27 md/json fixtures |
| [syntax-tree/mdast-util-to-markdown](https://github.com/syntax-tree/mdast-util-to-markdown) | handlers, `join`, `unsafe`, `safe()`; ~466 tests |
| [micromark-extension-gfm](https://github.com/micromark/micromark-extension-gfm) + 5 sub extensions | table, strikethrough, footnote, task list, autolink literal |
| [syntax-tree/mdast-util-gfm](https://github.com/syntax-tree/mdast-util-gfm) + sub utils | gfm tree + serializer, autolink regex transform quirks |
| [micromark-extension-mdxjs](https://github.com/micromark/micromark-extension-mdxjs), mdx-jsx, [mdx-expression](https://github.com/micromark/micromark-extension-mdx-expression) (incl. `micromark-util-events-to-acorn`), mdxjs-esm, mdx-md | MDX grammar, acorn options, error messages, `ruleId`, `source`, `url`, `place` |
| [syntax-tree/mdast-util-mdx-jsx](https://github.com/syntax-tree/mdast-util-mdx-jsx), mdx-expression, mdxjs-esm | how tag events nest into elements, serializer |
| [micromark-extension-frontmatter](https://github.com/micromark/micromark-extension-frontmatter), mdast-util-frontmatter | frontmatter |
| [mdx-js/mdx](https://github.com/mdx-js/mdx) `remark-mdx`, `remark-mark-and-unravel.js` | unravel transform |
| [remarkjs/remark](https://github.com/remarkjs/remark) remark-parse / remark-stringify | default options |
| [unifiedjs/unified](https://github.com/unifiedjs/unified), vfile, vfile-message | compat shim, error shape |
| [syntax-tree/unist-util-visit](https://github.com/syntax-tree/unist-util-visit) | `SKIP`/`EXIT`/index semantics |
| [Eyas/md-heading-id](https://github.com/Eyas/md-heading-id) | `{#id}` syntax, `idString` node |
| [Flet/github-slugger](https://github.com/Flet/github-slugger) | slugs |
| DefinitelyTyped `@types/mdast`, `@types/unist`, `@types/estree-jsx` | node types to centralize |

Speed and test sources:

| Repo | What we take |
| --- | --- |
| [wooorm/markdown-rs](https://github.com/wooorm/markdown-rs) | ~2000 test inputs in `tests/*.rs` (652 CommonMark, gfm_*, mdx_*), fuzz targets. Positions are UTF-8 bytes, so use as **inputs only** |
| [wooorm/mdxjs-rs](https://github.com/wooorm/mdxjs-rs) | MDX error tests |
| [bruits/satteri](https://github.com/bruits/satteri) | proof that a 2-phase parser can be deep-equal to remark; its [divergence list](https://satteri.bruits.org/docs/divergences/) is our list of remark quirks we must **keep** |
| [commonmark/cmark](https://github.com/commonmark/cmark), [commonmark.js](https://github.com/commonmark/commonmark.js) | block algorithm, `process_emphasis`, `SPECIAL_CHARS` table |
| [pulldown-cmark](https://github.com/pulldown-cmark/pulldown-cmark), [md4c](https://github.com/mity/md4c) | first pass design, mark collection, special byte LUT |
| [markdown-it](https://github.com/markdown-it/markdown-it) | line tables (`bMarks`/`eMarks`/`tShift`), `balance_pairs` |
| [acornjs/acorn](https://github.com/acornjs/acorn), [meriyah](https://github.com/meriyah/meriyah) | estree; acorn stays default for exact shape |

## 4. Parser architecture

Two phases like cmark, but the output rules are mdast-util-from-markdown's.

```
source string (never copied, read with charCodeAt)
   │
   ▼
lineStarts: Int32Array  ◄── one indexOf('\n') loop; offsets → line/column by cursor
   │
   ▼
BLOCK PHASE  line by line, open container stack
   │   containers: blockquote, listItem, footnoteDefinition
   │   leaves: paragraph, heading (atx/setext), code (fenced/indented), thematicBreak,
   │           html, table, yaml/toml, mdxjsEsm, mdxFlowExpression, mdx flow JSX tag
   │   each leaf keeps [start,end) ranges of its inline content, no strings yet
   │
   ▼
INLINE PHASE  per leaf, scan with Uint8Array(128) SPECIAL table, jump over plain text
   │   code spans, escapes, char refs, autolinks, html, links/images (bracket stack),
   │   emphasis/strong/delete (delimiter stack, openers_bottom by char,len%3,canOpen)
   │   mdx text JSX tags, mdx text expressions, gfm autolink literal, footnote refs
   │
   ▼
TREE  nodes created once by monomorphic factories in nodes.ts
      JSX open/close tags nest with a tag stack, same errors as mdast-util-mdx-jsx
      positions: { start, end } from offsets via lineStarts (column = UTF-16 units)
```

Rules:

- **No regex in hot paths.** Char-code switches and typed-array tables. Regex only where
  the reference uses one and the quirk must match (gfm autolink literal transform), and
  then a sticky `y` regex at an index, never on slices.
- **Integer state, direct calls.** No closure per state. Hot functions take
  `(src, pos, end)` and return the new pos or `-1`.
- **No event array.** Nodes are built directly. Backtracking is just resetting `pos`.
- **Strings only at node creation**: one `slice` per text node; build strings only for
  escapes, entities, and container-stripped content.
- **Line endings / tabs / NUL** handled during scanning (micromark `preprocess` semantics:
  CR, LF, CRLF; tab stops; NUL to U+FFFD) without a preprocessed copy.
- **Entities**: compact named-reference table shipped in core (same set as
  `character-entities`).
- **Definitions resolved after block phase** (needed before inline phase), with
  `normalizeIdentifier` semantics.

### MDX specifics

- MDX mode disables what remark-mdx disables: html flow/text, indented code, autolinks.
- **ESM**: column 1 `import`/`export` at document level, until blank line, same retry
  ("swallow") rule as `micromark-extension-mdxjs-esm`.
- **Expressions, fast path**: a JS-aware brace scanner (strings, template `${}`, comments,
  regex vs divide by previous token like acorn's `exprAllowed`) finds the closing `}`,
  then **one** acorn parse. If acorn fails there, fall back to the exact micromark loop
  (try every `}`) so errors and boundaries stay identical. Differential tests check both.
- **estree positions**: parse the joined expression source once, then one walk that maps
  offsets back through container "stops" (like `micromark-util-events-to-acorn`), sets
  `start`, `end`, `loc`, `range`, comments.
- `mdx({ estree: true | 'lazy' | false })`. `'lazy'` defines `data.estree` as a getter
  that parses on first access (safe-mdx render path reads only some). Default `true`.
- `mdx({ unravel: true })` runs mark-and-unravel inside the tree builder (no extra walk).
  Off by default to keep remark-mdx shape; safe-mdx turns it on.
- Errors: `MdxParseError` (errore tagged) with `reason`, `place {line,column,offset}`,
  `ruleId`, `source`, `url`. Same values as `VFileMessage` from micromark.

### Known quirks we must reproduce (from Sätteri's divergence list + from-markdown)

- ordered list not starting at 1 after indented code is a paragraph
- unclosed frontmatter suppresses lists/blockquotes after it
- gfm autolink literal: UTF-16 previous-char check, missing `position` after `[`
- task list item: paragraph start pulled back over `[ ]` only if first child is text
- list/listItem `spread` from `prepareList`, list item end excludes trailing blank lines
- adjacent text merging rules in `onexitdata`
- MDX: lazy lines are errors in flow JSX/expressions, 2-space indent stripping

## 5. Serializer architecture

Port `mdast-util-to-markdown` handlers 1:1 (behavior), with two changes:

1. **`unsafe` compiled once per `createMarkdown`** into per-character tables:
   `{ char → [{ atBreak, before: CharClass, after: CharClass, inConstruct mask }] }`.
   `safe()` scans the value once with charCodeAt and checks only chars that have rules.
   No regex compile, no per-pattern pass.
2. Construct stack as an integer bitmask instead of string array `includes`.

Same defaults as remark-stringify (`bullet '*'`, `emphasis '*'`, `listItemIndent 'one'`,
`fence '\`'`, `rule '*'`, ...). Same extensions folded in by `syntax` list.

## 6. Public API

```ts
// mdastic
export function createMarkdown<const S extends Syntax[]>(o?: { syntax?: S }): Markdown<S>
export interface Markdown<S> {
  parse(source: string, o?: { positions?: boolean }): Root | ErrorsOf<S>  // Root only if no mdx
  stringify(tree: Nodes, o?: StringifyOptions): string
  transform(tree: Root, transforms: Transform[]): Root                    // sync, in order
}
export type Transform = (tree: Root, ctx: { source?: string }) => void | Root
export function visit(tree, type | type[] | test, visitor, reverse?): void  // SKIP, EXIT, index
export function toString(node): string                // mdast-util-to-string
export * from './types.ts'                             // ALL node types, one place

// mdastic/mdx          mdx({ estree, unravel, acorn }), extractImports(tree), unravel(tree)
// mdastic/gfm          gfm({ singleTilde, tables, footnotes, taskList, autolinkLiteral })
// mdastic/frontmatter  frontmatter(['yaml', 'toml'])
// mdastic/heading-id   headingId()  ({#id} → idString node, replaces micromark-heading-id)
// mdastic/slug         createSlugger()  (github-slugger compatible)
// mdastic/unified      remarkMdastic(), fromRemarkPlugin(plugin, options)
```

Design choices:

- **One `syntax` list drives both parse and stringify.** No separate
  `micromarkExtensions` / `fromMarkdownExtensions` / `toMarkdownExtensions`.
- **`createMarkdown` precomputes** char dispatch tables and unsafe tables once. Module-level
  `parse(src, { syntax })` exists for one-off use.
- **Syntax is not a pluggable tokenizer API.** Built-in syntaxes are internal modules with
  a coarse hook interface (block start by char, inline trigger by char, node handlers).
  Subpath exports keep acorn and mdx code out of bundles that don't import `mdastic/mdx`.
- **Types are central and closed.** `mdastic` exports every node type (`MdxJsxFlowElement`,
  `MdxjsEsm`, `FootnoteDefinition`, `Yaml`, ...). `NodeOf<'heading'>` replaces
  `Extract<RootContent, {type: ...}>`. Shapes are structurally identical to `@types/mdast`
  so values pass to existing plugins. JSX helpers (`jsx.element`, `jsx.attr`,
  `jsx.expressionAttr`) replace holocron's hand-built estree in `jsx-utils.ts`.
- **Errors as values** (errore). Only MDX can fail; non-MDX `parse` returns `Root`.
- **Remark compat**: `fromRemarkPlugin(remarkSomething, opts)` turns any tree-transformer
  remark plugin into a `Transform` (fake `this.data()`, fake vfile). Syntax plugins
  (`remark-gfm`, `remark-mdx`, `remark-frontmatter`, heading id) map to built-ins; any other
  plugin that pushes `micromarkExtensions` gets a clear error. `remarkMdastic()` swaps
  parser + compiler inside an existing `unified()` chain.

## 7. Tests

**The oracle is the real remark stack**, pinned as devDependencies in a private
`reference/` workspace package. Every test compares full JSON (positions, `data.estree`,
key order ignored) or exact strings.

| Suite | Source | Asserts |
| --- | --- | --- |
| from-markdown fixtures | 27 md/json pairs, copied | exact mdast |
| to-markdown tests | ~466 cases, ported to vitest | exact markdown |
| mdast-util-gfm / mdx-jsx / mdx-expression / mdxjs-esm / frontmatter tests | copied | mdast + markdown |
| differential corpus | CommonMark 0.31.2 (652), GFM spec, micromark `test/io` inputs, every micromark extension test input (mdx-jsx 146, esm 34, ...), markdown-rs `tests/*.rs` raw-string inputs (`r###"..."###`, extracted by a script), mdxjs-rs tests | ours == oracle `fromMarkdown` (and same thrown error fields) |
| real-world corpus | holocron docs/fixtures/example, Mintlify `llms-full.txt`, 60 READMEs, safe-mdx fixtures | parse == oracle, `stringify(parse(x))` == oracle round trip |
| fuzz | seeded mutation of the corpus (insert/delete/duplicate special chars) | ours == oracle, fixed seed + budget in CI, long run via script |
| regression | every divergence found becomes an inline-snapshot test | |

Extraction scripts live in `scripts/` (TypeScript): `extract-markdown-rs-inputs.ts`,
`extract-commonmark-spec.ts`, `build-corpus.ts`. Fixtures are JSON, checked in.

**Benchmarks** (`scripts/bench.ts`, same corpus as above): parse md+gfm, parse mdx with
estree, stringify, vs remark. Gates: parse **≤ 5 ms** (10x), mdx **≤ 8 ms**, stringify 5x.

## 8. Repo layout

New repo `remorses/mdastic` (npm name already reserved), pnpm workspace, npm-package skill.

```
mdastic/
├── mdastic/                 published package (tsc, ESM, src + dist)
│   └── src/
│       ├── index.ts         createMarkdown, parse, stringify, visit, toString
│       ├── types.ts         every node type, NodeOf, content maps
│       ├── nodes.ts         monomorphic node factories
│       ├── scan.ts          char tables, lineStarts, entities
│       ├── block.ts         block phase (containers + leaves)
│       ├── inline.ts        inline phase (delimiters, links, code, escapes)
│       ├── stringify.ts     to-markdown port, compiled unsafe tables
│       ├── mdx.ts           JSX, expressions, ESM, brace scanner, acorn bridge, unravel
│       ├── gfm.ts           tables, strike, footnotes, tasks, autolink literal
│       ├── frontmatter.ts, heading-id.ts, slug.ts, unified.ts
│       └── *.test.ts        next to sources
├── reference/               private: pinned remark stack = oracle
├── fixtures/                extracted JSON corpora
└── scripts/                 extraction, corpus build, bench, fuzz
```

## 9. Milestones

1. **Harness first**: `reference/`, extraction scripts, corpus JSON, differential runner,
   bench script. Tests fail (no parser yet).
2. **CommonMark** blocks + inlines + tree. Pass from-markdown fixtures + CommonMark
   differential + micromark `test/io`.
3. **GFM**. Pass gfm suites + markdown-rs gfm inputs.
4. **Frontmatter + heading-id**.
5. **MDX** (JSX, expressions, ESM, estree, errors). Pass mdx suites + mdx error parity.
6. **Stringify** port + compiled unsafe. Pass to-markdown suite + round-trip corpus.
7. **Perf pass** with `profano` on the bench; hit gates.
8. **Migrate safe-mdx**: `parse.ts`, `incremental-parse.ts` (`processor` option becomes
   `markdown: Markdown`), `remark-mdx-jsx-normalize.ts`, `html-to-mdx-ast.ts` types. Drop
   remark, unified, unist-util-visit*, mdast-util-mdx-jsx.
9. **Migrate holocron**: one shared `createMarkdown` in `vite/src/lib/markdown.ts` replacing
   6 processor copies; plugins become `Transform`s; `remark-headings` uses `headingId()`;
   `remark-details-toggle` uses `jsx` helpers instead of re-parsing; cli too.
   `pnpm test` + integration fixtures must stay green.
10. **Migrate remote-bundler** `chat-markdown.tsx` to `mdastic` + `mdastic/gfm` (client
    bundle drops micromark).

## 10. Risks

- **Exact parity is the whole job.** micromark has quirks (section 4). The oracle +
  fuzzer is what makes it safe; without them we would ship a "close enough" parser.
- **Brace scanner vs acorn** on regex-vs-divide edge cases. The fallback loop keeps
  correctness; worst case is speed, never output.
- **estree cost**: acorn with `locations` dominates MDX parse. `'lazy'` helps render
  paths. meriyah or oxc only behind an option, after shape tests.
- **Stringify** has many interacting rules (`join`, `unsafe`, association). Port the test
  suite before optimizing.
- **Version pinning**: parity is against pinned remark versions. Upgrades of the oracle
  need a re-run and possibly code changes.

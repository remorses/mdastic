# mdastic

Exact remark-compatible mdast parsing and serialization, in plain TypeScript, much faster.

```ts
const syntax = [mdx(), frontmatter(), gfm()]
const tree = parse(source, { syntax })        // Root | MdxParseError, never throws
const markdown = stringify(tree, { syntax })  // same string as remark
```

**remark output is the spec.** Every tree (positions, `data.estree`, MDX errors) and every
serialized string must equal what the pinned remark stack produces. Speed comes second, and
only after parity. Read this file top to bottom before changing `mdastic/src/`.

## Goal

- **Exact parity** with `mdast-util-from-markdown` + `micromark-extension-{gfm,mdxjs,frontmatter}`
  for parsing, and with `mdast-util-to-markdown` + `{gfm,mdx,frontmatter}ToMarkdown` for stringify.
  Not "close enough": deep equal JSON, including every `position` and acorn `data.estree`.
- **Speed.** Real-document benchmark: 28x faster than remark on markdown, 17x on MDX, 6x on
  stringify. Faster than markdown-it (which builds no tree), about 1.2x behind native Sätteri.
- **Replace remark** in three of Tommy's projects:

```text
holocron (vite/, cli/)   6 copies of remark().use(mdx,gfm,frontmatter) + 5 toMarkdown calls
     │                   ──► one shared mdastic config, plugins become plain tree transforms
     ▼
safe-mdx                 already migrated on branch `mdastic` (createMdxProcessor({ syntax,
     │                   transforms }), markAndUnravel(tree)); waits for an mdastic release
     ▼
remote-bundler           remark + remark-gfm in a client chat component; drops micromark from
                         the browser bundle
```

holocron serializes MDX and safe-mdx parses the string again, so **stringify must be exact too**.
safe-mdx evaluates `data.estree`, so estree must have acorn's exact shape.
The original plan is `docs/mdastic-plan.md`.

## Scope and non-goals

| In scope | Not in scope |
| --- | --- |
| CommonMark, GFM, MDX (JSX, ESM, expressions), frontmatter (yaml, toml), `{#id}` heading IDs, opt-in math | HTML output (use `mdast-util-to-hast`) |
| mdast with positions (UTF-16 offsets) and `data.estree` | directives, wikilinks, definition lists, smart punctuation |
| `stringify` with every `mdast-util-to-markdown` option | a micromark-style syntax plugin API |
| `visit`, `toString`, central node types (`NodeOf<'heading'>`) | full `unified` / `vfile` implementation |
| `remarkTransform()` for tree-only remark plugins | remark plugins that add syntax (they throw a clear error) |

Inputs with unsupported syntax (`==mark==`, `[[wiki]]`, and `$` without `math()`) are still tested:
remark parses them as plain text, and mdastic must too. Math changes nothing unless enabled.

## Repository layout

| Folder | What |
| --- | --- |
| `mdastic/` | The npm package. `src/` builds to `dist/` with `tsc`. Subpaths: `mdx`, `gfm`, `frontmatter`, `heading-id`, `math`, `remark` |
| `conformance/` | Pinned remark oracle, fixtures, differential tests (vitest), realistic benchmark |
| `scripts/` | Fixture extraction from upstream suites, table generators, micro-benchmarks |
| `docs/` | `parser-conformance.md` (per-file results, measurements), `test-suites.md` (corpus sources), README figures |

## Design rules

1. **The oracle decides.** When unsure how remark behaves, run the oracle on a probe input or
   read the micromark / mdast-util source. Never guess, never "fix" remark.
2. **Copy remark quirks on purpose**, and comment them as quirks. Examples already reproduced:
   - flanking classifies UTF-16 units, not code points (`a*😀*b`)
   - BOM stripped, NUL becomes U+FFFD, tabs become virtual spaces
   - footnote labels split on markdown whitespace only, not `\u00a0` or `\v`
   - unknown entities must not read `Object.prototype` (`&constructor;`)
   - list `spread` and item ends follow `prepareList`, table trailing `|` needs even backslashes
   - GFM fallback autolink transform nodes have no `position`, tokenizer autolinks do
   - Sätteri's divergence list (https://satteri.bruits.org/docs/divergences/) are quirks to KEEP
   - when Sätteri (the port's starting point) and remark differ, match remark
3. **Positions are UTF-16 code units.** markdown-rs and Sätteri report UTF-8 byte offsets, so
   their expected trees are never used, only their inputs.
4. **Data-oriented parser.** Nodes live in a typed-array arena (`tree.ts`), reused across parses.
   mdast objects are built once, in one materialization pass, with monomorphic factories: same
   keys in the same order as remark (`title: null`, never add keys later, never `delete`).
5. **Non-reentrant.** Module-level arenas reset on every `parseDocument`. A hook must never call
   `parse` recursively. Reset buffers even when a parse fails. Hooks are internal; user code
   (transforms, `remarkTransform` plugins) runs after `parse` returns, so it may call `parse`.
6. **No perf regressions.** Run the benchmark before and after any parser or serializer change.
   Results must stay within noise. Hot loops use `charCodeAt`, typed tables, native `indexOf` /
   global-regex `lastIndex` jumps. No closures per character, no per-line string copies.
7. **Errors are returned, not thrown.** `parse` returns `MdxParseError`. Its `name`, `message`,
   `reason`, `place`, `line`, `column`, `ruleId`, `source` and `String(error)` match micromark's
   `VFileMessage`. A thrown error from `parse` is always a bug; the harness reports it as a crash.
8. **No runtime dependencies** except `acorn` and `acorn-jsx`, injected by `mdastic/mdx` through
   `config.mdx.acorn`. Core files never import acorn, so markdown-only bundles stay small.
9. **One `syntax` list** drives both `parse` and `stringify`. Built-in syntaxes are internal
   modules with coarse hooks, not a public tokenizer API.

## Parser architecture

```text
source ──► block.ts ──► deferred inline.ts ──► autolink.ts ──► tree.ts ──► mdast
               │                │                                ▲
               └──── definitions/footnotes ────────────────────────┘
scan.ts ──► ASCII/Unicode classification, entities, UTF-16 line positions
```

- `parser.ts` resets reusable module-level arenas and runs the phases synchronously.
  Delimiter storage resets at document entry too, including after a failed MDX parse.
- `tree.ts` stores node kinds, offsets, links and integer payloads in growable typed arrays.
- `inline.ts` uses reusable typed delimiter arrays. Nested spans resolve GFM and attention in remark's order.
- `block.ts` uses source line views and a reusable deferred-task arena (typed parents/start offsets,
  separate views), so references can precede definitions. Consumed views are released immediately.
  Fenced code, HTML and footnote recognizers return consumed line counts; `parseBlocks` owns
  interruption/lazy state and recognition order. JSX blank-line checks use a shared traversal.
- `scan.ts` finds CR/LF with native string searches once. Block lines and positions share the typed
  line-start index. Position lookups use a nearby cursor and binary-search fallback.
- `inline.ts` jumps between native-regex syntax candidates. Email-bearing views use an ASCII table;
  custom inline hooks keep character-by-character dispatch. Regex cursors reset before every search.
- `autolink.ts` searches URL prefixes and `@` candidates instead of retrying at every text character.
- GFM has two autolink passes: tokenizer links keep positions; fallback transform nodes have no positions.
- `entities.ts` and `punctuation.ts` are generated by `scripts/generate-parser-tables.ts`. Do not edit.

## Stream parser

`createStreamParser()` in `index.ts` is a cache over `parseDocument`, not a second parser. Its
contract: every result deep-equals `parse(text)`. It keeps the top-level nodes before `from`, a
line start. `checked` is the text that decided the cut, through the next block's first line; any
change in it drops the cache. It calls `parseDocument({ source, config, from })`, which parses
only lines from `from` on. Line index, positions, estree and errors stay document-relative.

```text
text so far ──► checked unchanged? ──no──► drop cache
                      │ yes
                      ▼
            parseDocument(from) ──► documentScoped? ──yes──► full parse, no cache
                      │ no
                      ▼
            stable nodes + tail nodes ──► advance `from` to the last safe block cut
```

A cut between two top-level nodes is safe only when all hold (each rule has a failing case in
`conformance/src/stream.test.ts`):

- a blank line separates them: multi-line MDX tags and expressions interrupt paragraphs
- the next node's first line is complete: `1. a\n\n1` becomes one list once `.` arrives
- neither is indented code: micromark carries interruption state through it across blank lines
- no open frontmatter fence at offset 0: `---` reads ahead to its closing fence
- `documentScoped` is false: definitions, footnotes and MDX imports affect other blocks

Compare prefixes with `slice() ===`, not `startsWith`: V8 compares sliced strings char by char in
`startsWith` (19 µs vs 0.4 µs on 20 KB). The remaining per-chunk O(n) work is `indexLines` over
the whole text. Benchmark: `scripts/bench-stream.ts`.

## Extension boundary

`heading-id.ts` supplies the inline `{#id}` construct. Its value-only positions match
mdast-heading-id. It runs before MDX text hooks; MDX flow hooks keep their original priority.
Math has no hooks: `$$` fences reuse fenced code in `block.ts` (two or more `$`, no `lang`, the
whole info string is `meta`) and inline math reuses the code span rules in `inline.ts`. With math
off, `$` is neither a fence marker nor an inline candidate, so the hot paths are unchanged.
Inline math indexes dollar runs by length once per view source, then finds bounded closers by
binary search. The index resets at parse entry; unmatched run lengths never rescan the suffix.
`remark.ts` attaches tree-only remark plugins to a minimal data processor, outside parsing.
It rejects syntax extensions; it does not depend on unified or vfile.

`parseDocument({ source, config, hooks })` accepts flow and inline hooks for additional syntax.
Flow hooks append arena nodes and return consumed line count. Inline hooks return an unattached
arena node and the next virtual offset. Map virtual offsets through `offset(view, index)`.
MDX mode already disables HTML flow/text, indented code and standard angle-bracket autolinks.
Do not recursively call `parseDocument` from a hook: the arena is reused. Use the current context.

- `mdx-parser.ts` owns JSX tags/attributes, ESM, cached container views and deferred JSX nesting.
  `parseEsmFlow` handles ESM continuation separately; image alt flattens after JSX resolution.
- `mdx-scan.ts` uses the injected Acorn tokenizer to find expression boundaries, then validates
  once and remaps ESTree positions. Failed predictions retain micromark's brace-by-brace fallback,
  which stops once acorn fails before the end of the input: no later brace can close it then.
  Paragraph probes read raw source across `> ` prefixes, so retrying every brace was cubic.
- Inline JSX tags nest after markdown attention/link resolution, so crossing tags produce the
  same errors as remark. Flow JSX parents redirect block nodes through `flowParent`.
- `positions: false` only removes mdast positions. MDX still indexes lines for ESTree and errors.
- `estree: false` still validates every expression with acorn; it only skips attaching trees.

## Serializer architecture

`stringify.ts` is a behavior port of `mdast-util-to-markdown@2.1.2` (switch dispatch, same
handlers, `join`, `unsafe`, association). `stringify-extensions.ts` ports the gfm, mdx and
frontmatter handlers. `stringify-safe.ts` compiles the `unsafe` patterns once per config into
per-scope candidate tables, so `safe()` scans each value once instead of running every regex.

- Position tracking only runs when custom `handlers` or a finite MDX `printWidth` need it.
- **Fragile:** escaping peeks at most one character into the next text node. This assumes the
  built-in unsafe rules never look further. Custom `unsafe` patterns take the full regex path.
- **One intended difference:** `idString` serializes as `{#value}`. remark-stringify throws,
  because mdast-heading-id has no to-markdown handler.

## Tests

### The oracle

`conformance/src/oracle.ts` runs the real remark stack, pinned to exact versions in
`conformance/package.json` (mdast-util-from-markdown 2.0.3, mdast-util-to-markdown 2.1.2,
micromark-extension-gfm 3.0.0, -mdxjs 3.0.0, -frontmatter 2.0.0, -math 3.1.0, mdast-util-math 3.0.0,
micromark-heading-id 2.0.0). Extensions are registered in safe-mdx / holocron order: mdx,
frontmatter `['yaml', 'toml']`, gfm, math (remark-math defaults), then headingId. Upgrading the
oracle means rerunning everything; differences become work.

```text
fixture { name, input, syntax } ──┬──► oracle (remark) ──► JSON ──┐
                                  │                              ├──► deep equal, first diff
                                  └──► mdastic ─────────► JSON ──┘
                                       positions, estree, error fields
```

**Fixtures store inputs only.** Expected output is computed live by the oracle. So any corpus of
markdown inputs is useful, even suites that only assert HTML.

**Always run the oracle with `NODE_ENV=production`.** Vitest otherwise picks micromark's
`development` export, whose `devlop` assertions throw on inputs the published build accepts
(misnested JSX in link labels). `conformance/vitest.config.ts` sets it; set it yourself for tsx.

### Fixture sources

| Source | Script |
| --- | --- |
| CommonMark 0.31.2 `spec.json`, cmark-gfm `test/spec.txt` | `scripts/extract-specs.ts` |
| micromark, mdast-util-*, remark-*, mdx-js test files, run with capture stubs | `scripts/extract-js-tests.ts` + `scripts/capture/` |
| markdown-rs, mdxjs-rs, Sätteri pulldown-cmark Rust tests (string literals) | `scripts/extract-rust.ts` |
| READMEs, Mintlify `llms-full.txt`, Holocron and mdx-js docs | `scripts/extract-realworld.ts` |
| spec-format files of pulldown-cmark, cmark(-gfm), commonmark.js, md4c, comrak, markdown-it, flexmark, goldmark; bench sample docs | `scripts/extract-spec-files.ts` |
| source MDX of docs sites (mintlify/docs) | `scripts/extract-docs-repos.ts` |
| cmark-style pathological inputs at 1/100 size | `scripts/pathological.ts fixtures` |
| micromark-extension-math, mdast-util-math, remark-math, Sätteri and pulldown-cmark math tests; d2l-en; real documents with `$` | `scripts/extract-math.ts` |
| hand-written bugs and edge cases | `conformance/fixtures/regressions.json`, `smoke.json` |

`conformance/stringify-fixtures/` holds 838 hand-built trees with options, captured from the
upstream `toMarkdown` tests. Candidate suites not yet extracted are in `docs/test-suites.md`.

### Adding fixtures

1. **A bug you found:** add `{ name, input, syntax }` to `conformance/fixtures/regressions.json`,
   confirm it fails, then fix `mdastic/src`.
2. **A new suite:** write or extend a `scripts/extract-*.ts` and call `writeFixtures(file,
   fixtures)` from `scripts/fixtures-lib.ts`. It dedupes by input + syntax, drops inputs where the
   oracle crashes with a non-MDX error, keeps MDX syntax errors (error parity is tested), and
   splits files over 5 MB. Run scripts from `conformance/`: `pnpm exec tsx ../scripts/<x>.ts`.
3. Never edit existing fixture files by hand. Regenerate them with their script.

### Running

```bash
pnpm --dir mdastic build                       # dist must stay fresh, consumers import it
cd conformance
pnpm exec tsx src/report.ts parse              # per-file pass counts + first failures
pnpm exec tsx src/report.ts stringify          # oracle tree ──► both serializers
pnpm exec tsx src/report.ts stringify-trees    # hand-built trees with options
pnpm exec tsx src/report.ts parse markdown-rs --fail 20   # filter files, show 20 failures
pnpm exec vitest run                           # full differential suite
pnpm run typecheck
pnpm exec tsx ../scripts/check-core.ts         # non-MDX parse only, first diff per fixture
```

**`report.ts` never fails the exit code.** It prints `parse: passed/total`. Read the numbers:
the requirement is **passed == total** in every mode. Only vitest fails CI-style. The open
failures from the newest suites, with minimal repros, are listed in `docs/test-suites.md`;
compare against that list before assuming your change broke something.

### Pathological inputs

remark is quadratic on many cmark pathological inputs, so only small sizes are tree-compared.
Linear time and no stack overflow at upstream sizes is checked on mdastic alone:

```bash
# exits 1 on a crash, more than 1 s, or superlinear growth
pnpm exec tsx ../scripts/pathological.ts check [name-filter]
```

### Known oracle problems

- **`{#}` hangs the oracle.** micromark-heading-id loops on its empty `chunkString`, so inline
  empty heading IDs cannot run in-process. They are tested separately in
  `conformance/src/heading-id.test.ts`; mdastic emits an empty `idString`.
- **An unclosed-title stress fixture** takes about 16 s in the oracle parser (mdastic: ms), hence
  `testTimeout: 120_000`. Large pathological inputs belong in timing checks, not fixtures.
- **`toMarkdown` writes `_compiled` onto `unsafe` patterns.** Always `structuredClone` options
  before each oracle or mdastic call.
- **Heading ID precedence** was taken from the oracle: `{#id}` wins over MDX text expressions,
  MDX flow expressions win over `{#id}`, so a standalone `{#id}` line is an acorn error.

## Benchmarks

```bash
pnpm --dir mdastic build
NODE_ENV=production pnpm --dir conformance exec tsx src/bench.ts   # main benchmark
pnpm exec tsx scripts/bench-parse.ts       # 167 KB README corpus vs remark and Sätteri
pnpm exec tsx scripts/bench-mdx.ts         # 530 Holocron MDX docs
pnpm exec tsx scripts/bench-stringify.ts   # 180 KB; PROFILE_STRINGIFY=1, STRESS_STRINGIFY=1
pnpm exec tsx scripts/bench-stream.ts      # 32-char chunks: parse every chunk vs createStreamParser
```

`src/bench.ts` parses each real document separately (342 markdown docs, 2.6 MB; 523 MDX docs that
remark accepts, 1 MB), median of 15 runs after warmup. Last numbers on an M5 Pro, Node 24:

| Task | remark | mdastic |
| --- | ---: | ---: |
| Parse markdown + GFM | 703 ms | 24.7 ms |
| Parse MDX with estree | 289 ms | 16.8 ms |
| Stringify markdown + GFM | 253 ms | 42.7 ms |
| Round trip MDX | 402 ms | 33.9 ms |

Profile with `node --cpu-prof --cpu-prof-dir=tmp/profiles --import tsx <script>`, then
`profano tmp/profiles/*.cpuprofile`. Host load moves numbers a few percent; rerun before
concluding.

**What worked:** shared typed line index, typed task arenas, native candidate search instead of
per-character retries, fast prefix rejection for definitions and tables, cached container views
for MDX (140 ms ──► 33 ms), one acorn parse per expression with micromark's fallback, compiled
escape tables. **What did not matter:** `positions: false` and `estree: false` save under 7%;
acorn was not dominant, so a hand-written JS brace scanner was never built.

## Known limits and open work

- **Deep nesting overflows the stack.** Containers, links, emphasis and MDX JSX recurse.
  `'> '.repeat(25000)` and `'<a>'.repeat(20000)` crash; remark handles both.
- **Some inputs are quadratic where remark is linear**: many link definitions, `[a` floods,
  nested brackets, `![[]()`. See `docs/test-suites.md` for the full table.
- **Allocation is not minimal.** Line and container views are objects, regex searches allocate
  match arrays, some strings decode before materialization, acorn allocates tokens.
- **Stringify is 5.4x, not the 6x target.**
- **Source vs dist.** The harness imports `mdastic/src`, but `heading-id.test.ts` and
  `remark.test.ts` import the built `mdastic`, so build before vitest. `const enum` inlines
  under `tsc` but not under isolated esbuild/tsx transforms, so benchmarks run slightly
  different code than the published build.
- `mdxjs-rs.json` contains 50 plain-JavaScript inputs from `swc_util_build_jsx.rs` tests.

## README figures

`docs/figures/*.html` are rendered to the PNGs next to them with the `diagrams-and-charts` skill.
Update the benchmark numbers in both the html and `README.md` after a perf change.

## Verification checklist

```text
pnpm --dir mdastic build
pnpm --dir conformance exec tsx src/report.ts parse          passed == total
pnpm --dir conformance exec tsx src/report.ts stringify      passed == total
pnpm --dir conformance exec vitest run                       green
NODE_ENV=production pnpm --dir conformance exec tsx src/bench.ts   within noise
lintcn lint (inside mdastic/)
```

Parser details and measured results are in `docs/parser-conformance.md`. Generated entity and
punctuation tables retain upstream licenses.

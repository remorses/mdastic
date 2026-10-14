---
title: Core parser conformance
description: Parser phases, exact remark compatibility, benchmark results, and allocation limits.
---

# Core parser

**The original cohort passes 9,858 / 9,858 fixtures**, including **2,047 MDX fixtures** and all
**7,811 non-MDX fixtures**. Comparison includes every node field, positions, ESTree and error metadata.
The original 7,733 non-MDX trees also match with positions removed.
All **3,926 additional MDX option checks** pass with positions or ESTree attachment disabled.

CommonMark: **652/652**. GFM specification: **671/671**. README corpus: **160/160**.
No runtime dependencies were added. Only the `mdastic/mdx` entry imports Acorn and acorn-jsx.

**MDX link regressions:** four cases in `regressions.json` cover expression brackets inside
resource links, nested expressions, image alt and reference links. Expression brackets do not
cancel an outer Markdown link. A manual 100,000-failure run also confirms delimiter buffers
retain no extra capacity after repeated malformed `*<` inputs.

**Concurrent corpus expansion:** the latest full report is 11,238 / 11,259 parse cases,
11,259 / 11,259 stringify cases and 838 / 838 tree-to-markdown cases. The 21 parser mismatches
are in newly added cmark, comrak, markdown-it, md4c and pulldown fixtures, outside the original cohort.

## Benchmark

**Readability cleanup:** median of three standalone production benchmark runs before and after.
Scanners retain their branch structure; only whole-block and ESM phases were extracted.

| Corpus | Before | After |
| --- | ---: | ---: |
| Markdown + GFM | 25.13 ms | 25.26 ms |
| Markdown, positions disabled | 24.18 ms | 24.41 ms |
| MDX, ESTree enabled | 17.09 ms | 17.55 ms |
| MDX, ESTree disabled | 17.33 ms | 16.64 ms |
| Markdown stringify | 43.87 ms | 44.28 ms |
| MDX stringify | 17.86 ms | 17.53 ms |

Compiled `tsc` output also shows no slowdown against the committed implementation in an
interleaved comparison. Source loaders do not inline imported const enums the same way as `tsc`;
mixed-source interleaved measurements were slower, while the standalone source benchmark above
remained within run-to-run noise. Do not treat source-loader and compiled timings as interchangeable.

**Heading ID and remark adapter change:** production benchmark before and after, same machine.
Ordinary parser paths remain within measurement noise; the benchmark does not enable heading IDs.

| Corpus | Before | After |
| --- | ---: | ---: |
| Markdown + GFM | 24.83 ms | 25.01 ms |
| Markdown, positions disabled | 23.76 ms | 23.60 ms |
| MDX, ESTree enabled | 16.63 ms | 16.92 ms |
| MDX, ESTree disabled | 16.38 ms | 16.65 ms |

**Real-document benchmark:** each document is parsed separately, Node 24.21.0, arm64.
The before column is the supplied baseline. Both requested speed targets are met.

| Corpus | Before | After | Target |
| --- | ---: | ---: | ---: |
| Markdown + GFM, 342 docs, 2.6 MB | 63.1 ms | 27.65 ms | ≤30 ms |
| Markdown, positions disabled | 58.8 ms | 28.54 ms | |
| MDX, 523 docs, 1.05 MB, ESTree enabled | 37.0 ms | 18.93 ms | ≤20 ms |
| MDX, ESTree disabled | 36.4 ms | 19.57 ms | |

```text
NODE_ENV=production pnpm --dir conformance exec tsx src/bench.ts
```

**Remaining costs:** inline/block parsing and final tree materialization dominate markdown.
MDX also spends time in JSX tag scanning, deferred nesting and per-tag closures. Acorn tokenization
was not a dominant cost in these corpora, so expression-boundary/error handling stays unchanged.

### Small README benchmark

Median of 100 runs after 30 warmups, Node 24.21.0, 167,000 UTF-16 units from 13 READMEs.

| Parser | Median |
| --- | ---: |
| mdastic, GFM and positions | 3.004 ms |
| remark, GFM and positions | 56.541 ms |
| Sätteri native | 1.191 ms |

```text
pnpm --dir mdastic build
pnpm exec tsx scripts/check-core.ts
pnpm exec tsx scripts/bench-parse.ts
```

## Data flow

```text
source ──► line views ──► block discovery ──► deferred inline parsing
                              │                        │
                              ▼                        ▼
                    definitions / footnotes     pooled delimiter arrays
                                                       │
                                                       ▼
                pooled SoA node arena ◄────── resolved inline scopes
                         │
                         ▼
             GFM fallback autolinks ──► one mdast materialization pass
                                             ▲
                        UTF-16 line index ────┘
```

**Pooled storage:** node kind, start/end offsets, child/next/previous/last links,
two integer payload slots, position flags; separate value and rare-payload arrays.
Delimiter nodes, owners, run starts, lengths, characters and flags use reusable typed arrays.
The line-position table and deferred-task parents/start offsets are also reusable.
Tasks retain views separately and release each view after consumption. Capacities double only
when needed. Block lines share the position index instead of scanning the document again.

**Scanning:** native CR/LF searches build the shared index. Inline parsing jumps between syntax
and URL-prefix candidates with native regex searches; email-bearing views use an ASCII dispatch
table. Custom inline hooks still receive every character. GFM fallback transforms search URL
prefixes and email candidates, not every character. Plain strings bypass decoding with a native
special-character check. Definition/table probes reject impossible prefixes before building views.

**Mapped views:** ordinary paragraphs retain a contiguous source slice. Container-stripped
content uses a virtual string with an offset map. Inline references run only after all block
definitions are known. GFM tokenizer links retain positions; fallback transform nodes omit
positions, exactly as remark does.

## Limits and extension points

**Heading IDs:** `heading-id.json` adds 158 cases from Eyas/md-heading-id and edge cases.
The oracle pins micromark-heading-id and mdast-heading-id at 2.0.0, after MDX, frontmatter and GFM.
All 992 real-world fixtures are also compared with heading IDs enabled in a separate test.
Inline `{#id}` wins over MDX text expressions; standalone flow expressions and JSX flow probes
still reach Acorn first. Positions cover only the ID content. Stringify writes IDs, while the
upstream serializer throws because it has no handler.

**Upstream limitation:** `{#}` makes the pinned oracle loop on its empty `chunkString` token.
It cannot be included in an in-process differential run. mdastic's empty ID behavior is tested
separately and is not included in the 9,854 conformance count. MDX flow `{#}` still returns the
same Acorn error. Upstream tests were read from Eyas/md-heading-id on 2026-10-14.

**Remark transforms:** real remark-squeeze-paragraphs trees match remark's transform output.
The adapter also checks async/callback completion, file messages and syntax-plugin rejection.

`parseDocument(source, config, hooks?)` supports flow and inline syntax hooks. Flow hooks
append arena nodes and return consumed line count. Inline hooks return an unattached arena
node and its ending virtual offset. `offset(view, index)` maps virtual to original offsets.

**Allocation caveat:** block line views are still objects, not a fully pooled SoA container stack.
Container/link scopes remain recursive. Decoded strings are prepared during parsing, rather than
exclusively during materialization. Native regex candidate searches allocate match arrays. The
speed targets are met, but a complete minimum-allocation rewrite remains unfinished.

The module-level arena is **not reentrant**. A syntax hook must use the current context instead
of recursively calling `parseDocument`. Extreme nesting can hit the JavaScript call-stack limit.
No known non-MDX conformance gaps remain in the collected corpus.

## MDX architecture

```text
mdx() ──► injected Acorn + acorn-jsx parser
                    │
source ──► cached container-stripped views ──► mdx-parser.ts flow / inline hooks
                    │                                      │
                    ▼                                      ▼
           mdx-scan.ts expressions                 JSX tags + attributes + ESM
           JS-aware closing-brace scan                      │
                    │                                      ▼
                    └──► Acorn validation ──► arena ──► deferred JSX nesting ──► mdast
                                │
                                └──► one ESTree location-remapping walk
```

**Expression boundaries:** Acorn's tokenizer handles strings, templates, regexes and JSX.
The predicted closing brace gets one parse. A failed prediction falls back to trying subsequent
braces, retaining the last Acorn error like micromark. Successful expressions are cached per view.
ESM retries blank-line boundaries only when Acorn reports incomplete input. Earlier imported names
are supplied as a synthetic declaration, then removed from the resulting Program.

**Positions:** container prefixes and two columns of continuation indentation are removed before
parsing JavaScript. Tabs can leave virtual spaces in mdast values; Acorn omits those spaces.
One walk remaps node/comment `start`, `end`, `loc` and `range`, and removes parenthesized wrappers.
`positions: false` still indexes lines for ESTree and errors. `estree: false` still validates code,
but skips attaching trees and avoids the ordinary-expression remapping walk.

**JSX precedence:** inline tags remain arena tokens while markdown attention and links resolve.
A final nesting pass builds JSX elements and rejects tags crossing markdown container boundaries.
Flow tags redirect subsequent blocks into the current JSX parent. Disabling indented code also
removes CommonMark's three-column indentation limits for headings, fences, lists and tables.

### MDX benchmark

530 Holocron documents parsed separately, 1,090,038 UTF-16 units, Node 24.21.0.
Median of 25 corpus passes after 5 warmups. All parsers reject the same 6 invalid documents.

| Parser | Median |
| --- | ---: |
| mdastic, ESTree on | 37.869 ms |
| mdastic, ESTree off | 35.782 ms |
| remark, MDX + frontmatter + GFM | 342.986 ms |
| Sätteri 0.10.5 native | 12.413 ms |

```text
pnpm exec tsx scripts/bench-mdx.ts
node --cpu-prof --cpu-prof-dir=tmp/mdx-profiles --import tsx scripts/bench-mdx.ts --mdastic
profano tmp/mdx-profiles/*.cpuprofile
```

**Profiling fix:** building the entire remaining mapped source for every flow tag consumed 58.5%
of self-time. Caching one view per block container reduced the corpus median from 140 ms to 33 ms.
The remaining hot paths are ordinary inline parsing and GFM autolinks.

**Test runner caveat:** the direct Node/tsx report uses the published production oracle and passes
all fixtures. Vitest selects the oracle's development exports: six malformed JSX-in-link/image
cases hit an upstream assertion instead of its production MDX error. One existing long link-title
fixture also exceeds Vitest's default timeout. Neither test was skipped or changed to hide this.

**Limits:** no known gaps remain in the collected fixtures. JSX stacks, remapping and container
views still allocate ordinary arrays/maps; Acorn's tokenizer allocates tokens. Invalid expressions
retain micromark's repeated-parse fallback cost. Extreme nesting remains limited by recursion.

## Per-file results

Only fixtures without `mdx` in their syntax list are counted below. Some MDX-named upstream
fixture files also contain ordinary markdown tests.

<details>
<summary>All 100 fixture files</summary>

| Fixture | Passed |
| --- | ---: |
| commonmark.json | 652/652 |
| gfm-spec.json | 671/671 |
| markdown-rs-attention.json | 131/131 |
| markdown-rs-autolink.json | 39/39 |
| markdown-rs-block-quote.json | 33/33 |
| markdown-rs-character-escape.json | 12/12 |
| markdown-rs-character-reference.json | 30/30 |
| markdown-rs-code-fenced.json | 46/46 |
| markdown-rs-code-indented.json | 20/20 |
| markdown-rs-code-text.json | 27/27 |
| markdown-rs-definition.json | 78/78 |
| markdown-rs-frontmatter.json | 22/22 |
| markdown-rs-fuzz.json | 18/18 |
| markdown-rs-gfm-autolink-literal.json | 62/62 |
| markdown-rs-gfm-footnote.json | 49/49 |
| markdown-rs-gfm-strikethrough.json | 16/16 |
| markdown-rs-gfm-table.json | 63/63 |
| markdown-rs-gfm-tagfilter.json | 5/5 |
| markdown-rs-gfm-task-list-item.json | 7/7 |
| markdown-rs-hard-break-escape.json | 7/7 |
| markdown-rs-hard-break-trailing.json | 18/18 |
| markdown-rs-heading-atx.json | 34/34 |
| markdown-rs-heading-setext.json | 46/46 |
| markdown-rs-html-flow.json | 146/146 |
| markdown-rs-html-text.json | 68/68 |
| markdown-rs-image.json | 34/34 |
| markdown-rs-link-reference.json | 56/56 |
| markdown-rs-link-resource.json | 75/75 |
| markdown-rs-list.json | 94/94 |
| markdown-rs-mdx-esm.json | 1/1 |
| markdown-rs-mdx-expression-flow.json | 7/7 |
| markdown-rs-mdx-expression-text.json | 2/2 |
| markdown-rs-mdx-jsx-flow.json | 1/1 |
| markdown-rs-mdx-jsx-text.json | 24/24 |
| markdown-rs-misc-bom.json | 2/2 |
| markdown-rs-misc-dangerous-html.json | 2/2 |
| markdown-rs-misc-dangerous-protocol.json | 31/31 |
| markdown-rs-misc-default-line-ending.json | 4/4 |
| markdown-rs-misc-line-ending.json | 31/31 |
| markdown-rs-misc-soft-break.json | 2/2 |
| markdown-rs-misc-tabs.json | 44/44 |
| markdown-rs-misc-url.json | 17/17 |
| markdown-rs-misc-zero.json | 4/4 |
| markdown-rs-serde.json | 23/23 |
| markdown-rs-text.json | 3/3 |
| markdown-rs-thematic-break.json | 28/28 |
| mdast-util-from-markdown.json | 66/66 |
| mdast-util-frontmatter.json | 18/18 |
| mdast-util-gfm-autolink-literal.json | 32/32 |
| mdast-util-gfm-footnote.json | 3/3 |
| mdast-util-gfm-strikethrough.json | 2/2 |
| mdast-util-gfm-table.json | 5/5 |
| mdast-util-gfm-task-list-item.json | 7/7 |
| mdast-util-gfm.json | 52/52 |
| mdast-util-to-markdown.json | 288/288 |
| micromark-extension-frontmatter.json | 23/23 |
| micromark-extension-gfm-autolink-literal.json | 49/49 |
| micromark-extension-gfm-footnote.json | 47/47 |
| micromark-extension-gfm-strikethrough.json | 13/13 |
| micromark-extension-gfm-table.json | 55/55 |
| micromark-extension-gfm-task-list-item.json | 4/4 |
| micromark-extension-gfm.json | 29/29 |
| micromark-io.json | 504/504 |
| micromark-misc.json | 6/6 |
| realworld-mintlify.json | 262/262 |
| realworld-readmes.json | 160/160 |
| realworld-satteri-bench.json | 4/4 |
| regressions.json | 5/5 |
| remark-frontmatter.json | 27/27 |
| remark-gfm.json | 13/13 |
| satteri-asides.json | 16/16 |
| satteri-autolink-contexts.json | 272/272 |
| satteri-autolink-fnr-positions.json | 14/14 |
| satteri-autolink-literals.json | 443/443 |
| satteri-autolink-path.json | 166/166 |
| satteri-commonmark-spec-json.json | 652/652 |
| satteri-footnotes.json | 65/65 |
| satteri-frontmatter.json | 12/12 |
| satteri-fuzz-regressions.json | 351/351 |
| satteri-hast.json | 80/80 |
| satteri-html.json | 5/5 |
| satteri-link-edge-cases.json | 268/268 |
| satteri-markdown-js.json | 91/91 |
| satteri-mdast.json | 280/280 |
| satteri-mdx-ast.json | 137/137 |
| satteri-mdx.json | 2/2 |
| satteri-pulldown-footnotes.json | 26/26 |
| satteri-pulldown-gfm-autolink.json | 11/11 |
| satteri-pulldown-gfm-strikethrough.json | 3/3 |
| satteri-pulldown-gfm-table.json | 9/9 |
| satteri-pulldown-gfm-tasklist.json | 2/2 |
| satteri-pulldown-heading-attrs.json | 2/2 |
| satteri-pulldown-metadata-blocks.json | 11/11 |
| satteri-pulldown-regression.json | 196/196 |
| satteri-pulldown-strikethrough.json | 15/15 |
| satteri-pulldown-table.json | 28/28 |
| satteri-pulldown-tests.json | 44/44 |
| satteri-reference.json | 20/20 |
| satteri-spec-deltas.json | 49/49 |
| smoke.json | 4/4 |

</details>

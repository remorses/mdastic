---
title: Test suites
description: Markdown and MDX input corpora from other parsers, which ones mdastic already uses, which to add next, pathological inputs, and the open failures they found.
---

# Test suites

mdastic tests are **differential**: a fixture is only `{ name, input, syntax }`, and the pinned
remark oracle computes the expected tree. So any corpus of inputs is useful, even when the
upstream suite only asserts HTML. This page lists the corpora other markdown projects use.

> **Status at `04050a6`:** 10 new fixture files, **3,936 new inputs**. Stringify passes
> 3,936/3,936. Parse passes **3,890/3,936**: 46 failures, grouped into 17 bugs below.
> The full parse report is now 13,748/13,794. The pathological perf check fails 63 of 114 runs.

```text
upstream test files ──► scripts/extract-*.ts ──► fixtures/*.json ──┬──► remark ───┐
(spec .txt, .rs, .js,      dedupe vs all other     inputs only      │              ├──► diff
 fuzz corpora, docs)       fixture files                            └──► mdastic ──┘
```

## Top 5 to add first

| # | Suite | New inputs | Status |
| --- | --- | ---: | --- |
| 1 | **Spec-format files** of pulldown-cmark, cmark, cmark-gfm, commonmark.js, md4c, markdown-it, comrak | 1,401 | **added** |
| 2 | **flexmark-java specs** (largest hand-written edge-case corpus) + goldmark testdata | 2,007 | **added** |
| 3 | **Pathological generators** from cmark, commonmark.js, markdown-it, micromark, comrak, pulldown-cmark | 59 cases | **added** (fixtures + `check`) |
| 4 | **OSS-Fuzz public corpora** (cmark, md4c, pulldown-cmark `commonmark_js`) | ~35k under 10 KB | todo, medium |
| 5 | **Source MDX of docs sites**: mintlify/docs, then cloudflare-docs, langchain, bun, next.js | 350 + ~15k | mintlify **added**, rest todo |

### Added in this pass

| Fixture file | Script | Inputs | Parse | Stringify |
| --- | --- | ---: | ---: | ---: |
| `pulldown-cmark-specs.json` | `extract-spec-files.ts` | 346 | 343 | 346 |
| `cmark-tests.json` (cmark, cmark-gfm x2, commonmark.js, spec master) | `extract-spec-files.ts` | 160 | 159 | 160 |
| `comrak-fixtures.json` | `extract-spec-files.ts` | 88 | 85 | 88 |
| `md4c-tests.json` | `extract-spec-files.ts` | 386 | 375 | 386 |
| `markdown-it-fixtures.json` | `extract-spec-files.ts` | 421 | 418 | 421 |
| `flexmark-specs.json` | `extract-spec-files.ts` | 1,877 | 1,860 | 1,877 |
| `goldmark-tests.json` | `extract-spec-files.ts` | 130 | 126 | 130 |
| `benchmark-samples.json` (markdown-it, pulldown bench docs) | `extract-spec-files.ts` | 60 | 58 | 60 |
| `realworld-mintlify-docs.json` (real Mintlify source MDX) | `extract-docs-repos.ts` | 350 | 350 | 350 |
| `pathological.json` (1/100 of upstream sizes) | `pathological.ts fixtures` | 118 | 116 | 118 |

Inputs already present in another fixture file with the same syntax are skipped, so these
counts are new inputs only. Regenerate from `conformance/`:

```bash
opensrc path pulldown-cmark/pulldown-cmark commonmark/cmark commonmark/commonmark.js \
  github/cmark-gfm kivikakk/cmark-gfm commonmark/commonmark-spec kivikakk/comrak mity/md4c \
  markdown-it/markdown-it vsch/flexmark-java yuin/goldmark mintlify/docs
pnpm exec tsx ../scripts/extract-spec-files.ts
pnpm exec tsx ../scripts/extract-docs-repos.ts
pnpm exec tsx ../scripts/pathological.ts fixtures
```

## Spec versions

- **CommonMark 0.31.2** (2024-01-28) is still the latest release. We pin it.
  `commonmark-spec` master has 655 examples: 4 new inputs (HTML tags broken over lines with
  `>`, `*𞋿*delta.`). They are unreleased; `cmark-tests.json` includes them anyway.
- **GFM:** `gfm-spec.json` comes from cmark-gfm `test/spec.txt`. 672 example blocks, 671 unique
  inputs, all extracted, including blocks tagged `table`, `strikethrough`, `autolink`,
  `tagfilter` and `disabled`. The github.github.com/gfm site (0.29-gfm, 677 examples) has 5
  older inputs that are in no fixture. Low value.

## Pathological inputs

remark is quadratic on many cmark pathological cases (nested strong emph: over 60 s), so
large inputs cannot be tree-compared in every test run. Two modes in `scripts/pathological.ts`:

```text
                       ┌─► fixtures  n/100 ──► pathological.json ──► normal oracle diff
59 generators, n = ────┤
upstream size          └─► check     n/16, n/4, n ──► mdastic only ──► fail on crash,
                                                                   > 1000 ms, or time
                                                                   exponent > 1.5 vs length
```

```bash
pnpm exec tsx ../scripts/pathological.ts check            # all cases, exits 1 on failure
pnpm exec tsx ../scripts/pathological.ts check "nested"   # name filter
```

`check` skips the full size when n/4 is already over budget, so a full run takes several minutes.
It is a perf gate, not part of vitest. Results at `04050a6` (remark times are single runs at the
same full size, `>60 s` means killed):

### Crashes: stack overflow (remark does not crash)

| Case | Input | mdastic | remark |
| --- | --- | --- | ---: |
| nested block quotes | `'> '.repeat(25000) + 'a'` | crash | 431 ms |
| comrak deep blockquote markers | `'>'.repeat(150000)` | crash | 14 s |
| emph in deep blockquote | `'>'.repeat(1e5) + 'a*'.repeat(1e5)` | crash | >60 s |
| nested inlines | `'*'.repeat(20000) + 'a' + '*'.repeat(20000)` | crash | 8.4 s |
| nested strong emph | `'*a **a '.repeat(32500) + 'b' + ' a** a*'.repeat(32500)` | crash | >60 s |
| cmark issue #389 | `'*a '.repeat(20000) + '_a*_ '.repeat(20000)` | crash | >60 s |
| empty lines in deep lists | `'- '.repeat(30000) + 'x' + '\n'.repeat(30000)` | crash | >60 s |
| same, in blockquote | `'> ' + '- '.repeat(30000) + 'x\n' + '>\n'.repeat(30000)` | crash | >60 s |
| comrak footnote definitions | `'[^1]:'.repeat(10000) + '\n'.repeat(10000)` (gfm) | crash | >60 s |
| pulldown blank lines in nested lists | `'- '.repeat(2000) + 'a\n' + '\n'.repeat(2000)` (mdx) | crash | 4.9 s |
| **mdx nested jsx** | `'<a>'.repeat(20000) + '</a>'.repeat(20000)` (mdx) | crash | **105 ms** |

### Much slower than remark

| Case | Input | mdastic | remark |
| --- | --- | ---: | ---: |
| `![[]()` repeated | `'![[]()'.repeat(160000)` | ~335 s (25 s at n/4) | 1.1 s |
| many link openers | `'[a'.repeat(32500)` | 2.3 s | 58 ms |
| nested brackets | `'['.repeat(25000) + 'a' + ']'.repeat(25000)` | 4.4 s | 531 ms |
| many references | `[i]: u` lines, i < 80000, then references | 10.7 s at n/4 | 1.6 s |
| micromark tons of definitions | `'[a]: u\n'.repeat(10000)` | 2.1 s | 257 ms |
| comrak footnote label brackets | `'[^'.repeat(20000) + ']'.repeat(20000)` (gfm) | 8.3 s | 1.2 s |
| cdata pattern | `'a <![CDATA['.repeat(8000)` | 1.2 s at n/4 | 3.9 s at n |
| unclosed html comments | `'</' + '<!--'.repeat(300000)` | 35 s at n/4 | >60 s |

The definitions cases matter most for real documents: **definition count is quadratic** in
mdastic, linear in remark.

### Superlinear in both, mdastic faster

Exponent about 2, but faster than remark: emph closers without openers, mismatched openers,
multiple of 3, link openers and emph closers, `[ (](`, backticks, `**_* `, `` ``\ ``, linkify
trailing asterisks, `*_* _ `, `a**b`, comrak emphasis mod three, `a***b~~`, `a<?`. These still
fail the check: cmark keeps all of them linear, and mdastic should too.

## New failures

Minimal repros, verified against the oracle at `04050a6`. Fix them after the readability
refactor, then add each repro to `regressions.json`. `got` is mdastic, `want` is remark.

| # | Repro | Diff | Fixtures |
| ---: | --- | --- | --- |
| 1 | `<style>a</script>\n*b*\n` | html `value` should end at the line with any raw closing tag (`</script>`, `</pre>`, `</style>`, `</textarea>`), not only the one that opened it | pulldown-cmark-specs #285 #286 #287 |
| 2 | `    a\n    \n    \n` | indented code `value`: got `'a'`, want `'a\n'` (also `    x\n    \t\n` wants `'x\n\t'`) | md4c #107; flexmark #37 #179 #321 #322 #394 #1027 #1039 #1040 #1041 #1042 #1043 #1818 |
| 3 | `- <?\n\n  x\n` | html in list item: got `'<?\n\nx'`, want `'<?\n\nx\n'` | md4c #37 |
| 4 | `>>\n>\n` | inner blockquote `position.end.line`: got 2, want 1 (also `- > > a\n  >\n`) | comrak #46 #62 #63; cmark-tests #62 |
| 5 | `>> a\n> 1. b\n` | the outer quote's list item must end the inner paragraph; inner quote `end.line` got 1, want 2 | flexmark #750 |
| 6 | `> 1. one\n2. two\n` | `2.` cannot interrupt a paragraph, so it is a lazy line; got a second listItem | flexmark #215 |
| 7 | `> - - x\n>\n>\n` | inner list `spread`: got false, want true | md4c #147; pathological #38 #39 |
| 8 | `* a\n  # b\n       # c\n       \n  * d\n` | outer item `spread`: got true, want false | flexmark #397 #398 |
| 9 | `[^a]: b\n\n    - c\n    \n    [^d]: e\n` (gfm) | list in footnote `spread`: got false, want true | flexmark #1024 |
| 10 | `[![a](b[)](c)\n` | an unmatched `[` inside an image destination must not break the outer link; got text, want link | md4c #133 to #139 |
| 11 | `<http://a\x7fb>\n` (U+007F) | DEL is not allowed in an autolink; got link, want text | md4c #149 |
| 12 | `- a\n b\n===\n` | lazy `===` / `--` lines continue the list paragraph; got `'a\nb'`, want `'a\nb\n==='` (also `- a\n--\n`) | markdown-it #240; goldmark #109 |
| 13 | `-   a\|b\n---\|---\n` (gfm) | a list item line cannot start a table; got table, want list. Also `    \| a \|\n  \| - \|\n` wants code | markdown-it #372 #387 |
| 14 | `[![[b](c)](x)](y)\n` | a link inside an image label disables the outer link; got link, want text | goldmark #39 |
| 15 | `a\n*  \n` | an empty item with trailing spaces cannot interrupt a paragraph; want `'a\n*'` | goldmark #40 |
| 16 | `<a b=c/d\n/>\n` | unquoted attribute value with `/` before a line ending is not html; got html, want text | goldmark #55 |
| 17 | `   - 3\n    - 4\n     - 5\n    - 4\n` | the last line is a lazy continuation; got `'5'`, want `'5\n- 4'` | benchmark-samples #10 #40 |

Fixture numbers are the `#index` printed by `report.ts parse <file> --fail 100`.

## All candidate suites

Effort: **low** = a format parser of a few lines, **medium** = new extraction logic or download,
**high** = generator or infrastructure. Every upstream suite asserts HTML or its own AST, so
outputs are never used; inputs are enough.

### Parser test suites

| Suite | URL | New inputs | Covers | License | Effort | Status |
| --- | --- | ---: | --- | --- | --- | --- |
| pulldown-cmark `specs/*.txt`, `third_party/` | https://github.com/pulldown-cmark/pulldown-cmark | 346 | regressions (newer than Sätteri's copy), math, wikilinks, alerts, smart punct, heading attrs | MIT | low | added |
| cmark `regression.txt`, `smart_punct.txt` | https://github.com/commonmark/cmark | ~48 | regressions, NBSP, comments, tabs | BSD-2 | low | added |
| cmark-gfm `extensions*.txt`, `regression.txt` | https://github.com/github/cmark-gfm | ~59 | table, strike, autolink, footnote regressions | BSD-2 | low | added |
| commonmark.js `regression.txt` | https://github.com/commonmark/commonmark.js | 47 | regressions | BSD-2 | low | added |
| commonmark-spec master | https://github.com/commonmark/commonmark-spec | 4 | unreleased examples | CC-BY-SA | low | added |
| comrak `src/tests/fixtures/*.md` | https://github.com/kivikakk/comrak | 88 | alerts, multiline blockquotes, wikilinks, math | BSD-2 | low | added |
| md4c `test/*.txt` | https://github.com/mity/md4c | 386 | regressions, coverage, tables, permissive autolinks | MIT | low | added |
| markdown-it `test/fixtures` | https://github.com/markdown-it/markdown-it | 421 | extras, tables, linkify, xss, normalize, proto | MIT | low | added |
| flexmark-java specs | https://github.com/vsch/flexmark-java | 1,877 | list indentation across dialects, issues, extensions | BSD-2 | low | added |
| goldmark `testdata` | https://github.com/yuin/goldmark | 130 | extra edge cases, delimiter options, extensions | MIT | low | added |
| markdown-it, pulldown bench samples | (same repos) | 60 docs | one construct per document, nested | MIT | low | added |
| comrak `src/tests/*.rs` | https://github.com/kivikakk/comrak | ~722 | fuzz regressions with control chars, HEEx (use with mdx), sourcepos edge cases | BSD-2 | medium: `concat!`, juxtaposed literals, macro table | todo |
| markdown-rs math, disabled constructs, to-markdown strings | https://github.com/wooorm/markdown-rs | ~338 | `$` near emphasis; serializer outputs as parser inputs | MIT | low: stop skipping in `extract-rust.ts` | todo |
| pulldown-cmark `src/` unit tests, `tests/html.rs`, `errors.rs` | https://github.com/pulldown-cmark/pulldown-cmark | ~57 | fuzz crash regressions | MIT | low: list `Parser::new` | todo |
| dprint-plugin-markdown specs (deno fmt) | https://github.com/dprint/dprint-plugin-markdown | ~1,009 | real user formatting bugs | MIT | low: split on `!! name !!` | todo |
| entities | `character-entities` npm | 2,125 | every named reference | MIT | low | todo |
| Biome `md_test_suite`, `seed.jsonl` | https://github.com/biomejs/biome | 205 + 154 | block interrupts, lazy quotes, CJK emphasis | MIT/Apache | low | todo |
| marked `test/specs` (new, original, redos) | https://github.com/markedjs/marked | ~245 | regressions, Markdown.pl suite, ReDoS | MIT | low | todo |
| prettier `tests/format/markdown`, `mdx` | https://github.com/prettier/prettier | 282 + 15 | formatter edge cases; MDX v1 gives error-parity cases | MIT | low | todo |
| Bun `test/js/bun/md` | https://github.com/oven-sh/bun | ~100 + ~175 inline | md4c regressions, linear-time generators | MIT | medium | todo |
| markdown-it unit tests, micromark `stream.js`, `perf.js` | (same repos) | ~60 | CR-only input, label normalization | MIT | low, by hand | todo |
| commonmark-java `alerts-spec.txt`, tests | https://github.com/commonmark/commonmark-java | 33 + ~350 | alerts, extension tests | BSD-2 | low / medium | todo |
| markdown-it-py fixtures | https://github.com/executablebooks/markdown-it-py | ~60 | alerts, single tilde, task lists | MIT | low | todo |
| mdx-js other packages, eslint-mdx, mdx-analyzer | https://github.com/mdx-js | ~65 | odd MDX, syntax errors | MIT | low | todo |
| Docusaurus `_dogfooding`, mdx-loader `__fixtures__` | https://github.com/facebook/docusaurus | ~170 | deliberate MDX edge cases, 2 acorn errors | MIT | low | todo |

### Fuzz corpora

OSS-Fuzz publishes minimized corpora without auth:
`https://storage.googleapis.com/<project>-backup.clusterfuzz-external.appspot.com/corpus/libFuzzer/<project>_<fuzzer>/public.zip`
(cmark uses the key `cmark_fuzzer`). The zips change daily: download at script time, vendor a
curated subset.

| Fuzzer | Files | Under 10 KB | Header to strip | remark time, under 10 KB |
| --- | ---: | ---: | --- | ---: |
| pulldown-cmark `commonmark_js` | 13,525 | 10,436 | none | 9 s |
| cmark `cmark_fuzzer` | 30,124 | 13,416 | 8 bytes | 12 s |
| md4c `fuzz-mdhtml` | 22,842 | 11,678 | 8 bytes | 10 s |
| pulldown-cmark `parse` | 28,076 | 12,720 | 4 bytes (unverified) | |
| blackfriday `render_fuzzer` | 11,103 | 5,671 | none | |

No markdown-rs, micromark, comrak, cmark-gfm or goldmark project has a public corpus.
remark takes 1 to 71 s on some fuzz inputs (one-line `- - - - m:` nesting, bracket floods), so
cache oracle output for inputs over 10 KB.

### Real documents

| Corpus | URL | Files | License | Notes |
| --- | --- | ---: | --- | --- |
| mintlify/docs | https://github.com/mintlify/docs | 350 English mdx | MIT | **added**. `realworld-mintlify.json` is rendered markdown and lost the JSX |
| cloudflare-docs | https://github.com/cloudflare/cloudflare-docs | 9,693 mdx, 37 MB | CC-BY-4.0 | tab-indented JSX, `:::` asides; sparse clone, sample |
| langchain-ai/docs | https://github.com/langchain-ai/docs | 2,447 mdx | MIT | Mintlify components |
| bun docs | https://github.com/oven-sh/bun/tree/main/docs | 1,367 mdx | MIT | Mintlify |
| next.js docs, react.dev, withastro/docs, supabase | various | 225 to 1,497 each | MIT, CC-BY, Apache | react.dev `.md` files are MDX |
| github/docs, kubernetes, mdn/content | various | 3k to 15k md | CC-BY, CC-BY-SA | script time only, never vendor share-alike |

Do not vendor sentry-docs (FSL), clerk, prisma, tailwindcss.com (no license) or progit (NC).

## Notes

- **Extension syntax is still a good input.** Math, wikilinks, `==mark==`, `{#id .class}`
  attributes and `:::` containers become plain text in remark. They reach inline code paths
  ordinary documents rarely hit.
- **`mdxjs-rs.json` is partly mislabeled.** 50 of its 110 inputs come from
  `swc_util_build_jsx.rs`, whose tests parse JavaScript, not MDX.
- **Run inputs under more syntax sets.** CommonMark-style inputs under `['mdx']` give cheap
  error-parity cases; not done yet to keep the suite fast.
- **Generator schemes worth copying** for a future fuzzer: comrak `fuzz/quadratic.rs`
  (`md.repeat(k)`, `prefix.repeat(k) + md + suffix.repeat(k)`), cmark-gfm
  `fuzz_quadratic_brackets.c`, Bun's "unit repeated 40,000 times" list, Biome's seeded
  construct generator with the remark oracle as reference.

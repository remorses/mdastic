---
title: JS parser research
description: Can a faster pure-JS ESTree parser replace acorn for MDX expressions? Measurements, candidates, and where the time really goes.
---

# JS parser research

**Short answer: no pure-JS parser is meaningfully faster than acorn on MDX snippets.**
MDX expressions are tiny (average 29 chars), so per-call setup dominates, not parsing.
The wins are in how mdastic calls acorn, not in which parser it calls.

## Where acorn time goes

| Corpus | Total parse | Inside acorn | Calls / MB |
| --- | ---: | ---: | ---: |
| `realworld-holocron.json` (524 docs, 1 MB) | 16.8 ms | ~0.7 ms (**4%**) | ~600 |
| Synthetic API page, 200 components with `{}` attributes (34 KB) | 5.2 ms | about **half** | ~60,000 |

Real docs barely use expressions. Expression-heavy pages (generated API references) do.

In the expression-heavy profile, acorn's **constructor** is the top cost, not parsing:

```
getOptions    14.8%   option copy on every new Parser
wordsRegexp   10.7%   cache key is a ~300 char string concatenated per call
remap          5.6%   mdastic: ESTree position remapping
```

## Candidates

Same 1,080 sources mdastic sends to acorn (all MDX fixtures), same options
(module, JSX, locations, comments, parens). Median of 21 runs, Node 24, Apple Silicon.

| Parser | ms | Same ESTree shape | Same spans | Rejects valid input | Status |
| --- | ---: | ---: | ---: | ---: | --- |
| **acorn 8 + acorn-jsx** | 1.43 | 1080 | 1080 | 0 | maintained, oracle |
| meriyah 7.4 | 1.30 to 1.54 | 779 | 1022 | 24 | maintained, TS, test262 |
| @babel/parser 8 + estree | 2.40 | 806 | 1041 | 24 | maintained, slower |
| cherow 1.6.9 | 0.72 | 911 | 762 | 33 | dead since 2022 |
| seafox 1.7.1 | - | - | - | - | dead since 2022, no JSX |

- **meriyah**: within ±10% of acorn. Shape diffs are fixable (`attributes: []` on imports,
  comment types `SingleLine`/`MultiLine`), but it rejects 24 inputs acorn accepts, and
  error positions differ, so MDX errors would need an acorn fallback anyway.
- **cherow** is 2x faster but unmaintained and not compliant. Not an option.
- Native parsers (oxc, swc, yuku in Zig, esbuild) are out of scope: mdastic must run in
  Workers and browsers as plain JS.

## What actually helps

1. **Skip the tokenizer pass for simple expressions** (done). `candidate()` built a second
   acorn instance per expression just to find the closing `}`. If no `{`, quote, backtick
   or `/` appears before the first `}`, that `}` is the answer. Exact same result.
   Expression-heavy page: **5.2 → 4.2 ms (-20%)**. Real docs: within noise.
2. **acorn upstream: cache reserved-word regexps per ecmaVersion + sourceType.** Measured
   ~10% faster acorn on our inputs with a 15-line patch. Candidate for an acorn PR.
3. **`estree: 'lazy'`** from the plan: build `data.estree` (remap) only on first access.
   estree on vs off is ~1 ms of 5.2 ms on the heavy page.

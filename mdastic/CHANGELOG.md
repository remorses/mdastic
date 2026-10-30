# Changelog

## 0.3.3

1. **Fixed container end positions** for nested block quotes, list items, and other blocks to match remark.
2. **Fixed MDX flow lines in containers**, including paragraph interruption and JSX list item spread.
3. **Fixed fenced code endings and tables in nested containers** to match remark across line endings and container boundaries.
4. **Fixed escaping at the end of link destinations** to match remark.

Thanks @rgodha24 for #44, #45 and #46!

## 0.3.2

1. **Fixed multi-line MDX tags in containers.** A JSX tag that spans lines now follows every tag and expression on its line, inside the container's own view, like remark. These inputs parsed as errors before:
   - `<p><strong \n>o</strong></p>` is `p > strong > "o"`
   - `><_/\n>>>` is a block quote with `<_/>` and `>`
   - `> <a b\n>>>` reports remark's "Expected a closing tag" error
2. **Fixed lists inside footnote definitions.** The definition indent ends list items like a container prefix, so `spread` and item ends match remark when a blank line or a new container follows (`[^1]:-\n\n    -`).
3. **Fixed nested block quotes closed by a new container.** They end at the enclosing prefix for footnote definitions too (`>>a\n>[^1]: b`), and not for thematic breaks that look like list markers (`>>a\n>* * *`).
4. **Fixed MDX end-of-file errors at container boundaries.** When a new container closes an unfinished JSX tag or expression, mdastic reports the same error and place as remark.

Thanks @rgodha24 for #41 and #42!

## 0.3.1

1. **Fixed link and image label parsing** to match remark:
   - JSX tags with spread attributes inside a label no longer fail with an acorn error (`![<a {...b}/>](x)`)
   - references inside a label resolve before the outer label is rejected, and each inner label takes its own resource or reference (`![[a][]([)](/z)` with `[a]` defined)
   - defined footnote calls inside a label take no resource (`[x [^a](])](/z)`)
   - emphasis and strikethrough inside labels resolve in micromark's order
2. **Fixed tables and lazy lines in containers** (block quotes, list items, footnote definitions):
   - tables are tracked through nested containers, so a lazy line after a table never joins it or opens a new table
   - a lazy line declined by a nested quote closes all containers
   - blank lines and footnote labels are never table head rows
   - a table head row ends the link definitions before it (`[a]: u\nb|c\n-|-`), so references to them resolve
   - HTML block starts win over GFM table head rows (`<!-- c -->\n:-`)
3. **Fixed paragraph interruption in containers**: after a paragraph or indented code in a quote, list item or footnote, a marker that cannot interrupt (`*` alone, `2.`) stays paragraph text and keeps taking lazy lines. HTML blocks in containers no longer take lazy lines.
4. **Fixed list and task list details**:
   - list `spread` when quoted lists close and around footnote definitions, and quoted list item positions
   - `[x]` is a task checkbox only in an item's first content, not after `* \n  [x] a` or a blank line after definitions
   - unclosed fenced code or HTML in a list item keeps remark's trailing blank lines when a footnote definition or `- --` follows
5. **Fixed split tabs** in containers: leftover tab columns stay data in code spans, inline math and MDX expression continuation lines, like remark.
6. **Fixed MDX differences from remark**:
   - quoted JSX attribute values decode character references like `parse-entities` (`&#128;` is `€`, `&copye;` is `©e;`)
   - flow tags or expressions on a container's paragraph continuation line that reach a lazy line now return remark's `unexpected-lazy` error (`> a\n{\n}b`)
   - JSX errors are reported in micromark's token exit order, and an unclosed expression at the end of a block quote reports the same place as remark
   - footnotes inside footnotes inside JSX flow tags take the outer indent
7. **Fixed quadratic parse time** for unclosed `{` lines in block quotes, long runs of link definitions, and `[` / `![[]()` bracket floods. These inputs now parse in linear time.

Thanks @rgodha24 for #19 to #40 and #43!

## 0.3.0

1. **New `createStreamParser()` for streaming markdown and MDX**, like an LLM response. Pass the whole text so far on every chunk; each result equals `parse(text)`:

   ```ts
   import { createStreamParser } from 'mdastic'
   import { mdx } from 'mdastic/mdx'
   import { gfm } from 'mdastic/gfm'

   const parser = createStreamParser({ syntax: [mdx(), gfm()] })
   let text = ''
   for await (const chunk of response) {
     text += chunk
     const tree = parser.parse(text)
     if (tree instanceof Error) continue // incomplete MDX, keep the last good tree
     render(tree)
   }
   ```

   Top-level blocks that can no longer change are cached and returned as the **same objects** on every call, so a renderer can memoize them. Only the text after the last safe cut is parsed again. Streaming in 32-character chunks is 2.7x to 10x faster than calling `parse` on every chunk. Do not mutate returned trees: cached blocks are shared. Documents with link or footnote definitions or MDX imports are parsed in full on each call.

2. **Fixed footnote definition parsing** to match remark, which treats them as containers like block quotes and list items:
   - footnote labels are recognized before tables and link definitions (`[a]: b\n[^c]: d`, `[^b]: c\n|-|`)
   - lazy lines after a footnote can start any list (`[^a]: b\n2) x`)
   - paragraph interruption carries through footnote labels, footnotes directly inside footnotes take the outer indent
   - definitions on lines with leftover tab columns, indented code in a container after a definition, and HTML after a definition now parse like remark
3. **Fixed MDX parse differences from remark**:
   - link and footnote definitions take any indentation in MDX (`    [e]: f`), since MDX has no indented code
   - an `import` / `export` line right after a definition stays paragraph text
   - an unclosed frontmatter fence starts no block quotes, lists or footnotes
   - `end-tag-mismatch` errors name micromark tokens like remark (`atxHeading`, `gfmFootnoteDefinition`, `strikethrough`, `tableData`)
4. **Fixed markdown parse differences from remark**:
   - image alt text no longer keeps escapes or character references from GFM literal autolinks (`![http://a\.b](/x.png)` gives alt `http://a.b`)
   - unmatched backtick runs inside link and image labels stay text as a whole (``![``a![b`](/x)``)
   - lazy lines inside quoted list items keep their indentation in code spans and inline math
   - only the first list item after a paragraph inherits its interruption rules (`0\n- a\n- -`)
5. **Fixed cubic MDX parse time** for `{` / `}` lines inside block quotes. A 1.2 MB docs page that never finished now parses in under 200 ms.

Thanks @rgodha24 for #11, #12, #13, #14, #15, #16, #17 and #18!

## 0.2.0

1. **New opt-in math syntax.** Parse and serialize `$x$` inline math and `$$` blocks with the same nodes, positions and markdown as remark-math:

   ```ts
   import { parse, stringify } from 'mdastic'
   import { math } from 'mdastic/math'

   const syntax = [math()]
   const tree = parse('Energy: $E = mc^2$', { syntax })
   if (tree instanceof Error) throw tree
   const markdown = stringify(tree, { syntax })
   ```

   Use `math({ singleDollarTextMath: false })` to require at least two dollars for inline math. Without `math()`, dollar signs remain ordinary text.

Thanks @rgodha24 for #10!

## 0.1.2

1. **Fixed MDX parse differences from remark** in container and multi-line constructs:
   - list items keep wide marker padding in MDX, which has no indented code
   - JSX tags and expressions that span lines end at headings, fences, blank lines and new list items, with the same `unexpected-eof` and `unexpected-lazy` errors as remark
   - MDX flow constructs take no lazy lines; closing-tag mismatch errors are reported in remark's order
   - `import` / `export` lines end a GFM table and parse as ESM
   - only spaces and tabs count as blank in ESM and JSX lines (`\ufeff`, NBSP no longer do)
   - quoted attribute values skip any whitespace after a line ending, like micromark
2. **Fixed markdown parse differences from remark**:
   - fenced code inside block quotes, list items and footnotes takes no lazy lines
   - a setext underline inside a block quote closes the paragraph (`> x\n> ===\ny`)
   - unclosed fenced code at end of file gets the right value and position inside containers
   - lists can start right after a table (`a\n|||\n-|-\n3.`)

Thanks @rgodha24 for #1, #2, #3, #4, #5 and #6!

## 0.1.1

1. **Fixed 17 parse differences from remark** found by new conformance suites (cmark, md4c, flexmark, goldmark, markdown-it, comrak, pulldown-cmark). mdastic now matches remark on all 13,817 fixtures. Fixes include:
   - raw HTML blocks (`<script>`, `<pre>`, `<style>`, `<textarea>`) end at any raw closing tag
   - trailing blank lines in indented code
   - lazy continuation lines and list `spread` inside blockquotes and footnotes
   - tables no longer start on list item or blockquote lines
   - links nested inside image labels and brackets inside image destinations
   - DEL is rejected in autolinks; `/` in unquoted HTML attribute values

## 0.1.0

1. **New `mdastic/heading-id` syntax.** Parses `{#custom-id}` into `idString` nodes, the same tree as `micromark-heading-id` + `mdast-heading-id`:

   ```ts
   import { parse } from 'mdastic'
   import { headingId } from 'mdastic/heading-id'

   parse('# Title {#custom-id}', { syntax: [headingId()] })
   ```

   With MDX, valid IDs win over text expressions. `stringify` writes `{#value}` (remark-stringify throws on `idString`).

2. **New `mdastic/remark` adapter.** Run existing tree-only remark plugins without unified:

   ```ts
   import { remarkTransform } from 'mdastic/remark'
   import remarkSqueezeParagraphs from 'remark-squeeze-paragraphs'

   const transform = remarkTransform(remarkSqueezeParagraphs)
   await transform(tree)
   ```

   Sync, Promise and `next` callback transforms are supported. Plugins that add parser or serializer extensions throw at attachment.

3. **`MdxParseError` matches `VFileMessage`.** `message` is the reason and `name` is the place, so `String(error)` is identical to remark.

4. **Fixed brackets inside MDX expressions cancelling an outer link**, for example `[a {foo[bar]}](x)`.

5. **Fixed memory growth after many failed MDX parses.** Delimiter buffers now reset on error.

6. **Faster MDX** on expression-heavy pages: simple `{expr}` expressions skip the extra acorn tokenizer pass.

## 0.0.2

1. **First release.** Markdown and MDX parser and serializer that outputs the exact same mdast as remark:

   ```ts
   import { parse, stringify } from 'mdastic'
   import { gfm } from 'mdastic/gfm'

   const tree = parse('# hello *world*', { syntax: [gfm()] })
   ```

   Passes 9,696 of 9,696 conformance fixtures against the pinned remark stack, including positions, `data.estree` and MDX errors.

2. **MDX, GFM and frontmatter** as subpath exports: `mdastic/mdx`, `mdastic/gfm`, `mdastic/frontmatter`. One `syntax` list drives both `parse` and `stringify`.

3. **`visit` and `toString` helpers** with the same semantics as `unist-util-visit` and `mdast-util-to-string`. `visit` narrows the node type from the filter.

4. **Speed:** 28x faster than remark on markdown, 17x on MDX, 6x on stringify.

This release is experimental and unstable. The API can break in any 0.x release.

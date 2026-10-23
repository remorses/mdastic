# Changelog

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

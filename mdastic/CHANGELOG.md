# Changelog

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

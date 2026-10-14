# Changelog

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

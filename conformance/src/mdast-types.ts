// Type-level test, checked by `pnpm run typecheck`: mdastic trees are assignable to @types/mdast
// (with the mdast-util-* augmentations a remark project loads), so they can go to mdast tooling
// like mdast-util-to-hast without casts. The reverse does not hold: mdastic types are stricter
// (`position.start.offset` is always set, `title` is never undefined).
import type * as Mdast from 'mdast'
import type * as Mdastic from 'mdastic'
import type {} from 'mdast-util-frontmatter'
import type {} from 'mdast-util-gfm'
import type {} from 'mdast-util-math'
import type {} from 'mdast-util-mdx'

// mdast-heading-id ships this augmentation but does not wire it into its published types.
declare module 'mdast' {
  interface RootContentMap {
    idString: Mdastic.IdString
  }
  interface PhrasingContentMap {
    idString: Mdastic.IdString
  }
}

export function toMdast(tree: Mdastic.Root): Mdast.Root {
  return tree
}

import fs from 'node:fs'
import { characterEntities } from '../node_modules/.pnpm/character-entities@2.0.2/node_modules/character-entities/index.js'

console.log('Generate HTML named character reference table')
const entitiesLicense = fs.readFileSync(new URL('../node_modules/.pnpm/character-entities@2.0.2/node_modules/character-entities/license', import.meta.url), 'utf8')
fs.writeFileSync(new URL('../mdastic/src/entities.ts', import.meta.url), '// Generated HTML named character references (WHATWG, character-entities).\n/*\n' + entitiesLicense + '*/\nexport const entities: Record<string, string> = ' + JSON.stringify(characterEntities, null, 2) + '\n')
console.log('Generate Unicode punctuation ranges from Sätteri')
const source = fs.readFileSync('/Users/morse/.opensrc/repos/github.com/bruits/satteri/main/crates/satteri-pulldown-cmark/src/puncttable.rs', 'utf8')
const tab = source.slice(source.indexOf('const PUNCT_TAB:'), source.indexOf('const PUNCT_MASKS:'))
const masks = source.slice(source.indexOf('const PUNCT_MASKS:'), source.indexOf('pub(crate)'))
const blocks = Array.from(tab.matchAll(/^\s*(\d+),/gm), m => Number(m[1]))
const bits = Array.from(masks.matchAll(/^\s*(0x[\da-f]+),/gm), m => Number(m[1]))
const ranges: number[] = []
for (let i = 0; i < blocks.length; i++) {
  for (let j = 0; j < 16; j++) {
    if (!(bits[i] & (1 << j))) continue
    const cp = blocks[i] * 16 + j
    if (ranges.length && ranges[ranges.length - 1] === cp - 1) ranges[ranges.length - 1] = cp
    else ranges.push(cp, cp)
  }
}
fs.writeFileSync(new URL('../mdastic/src/punctuation.ts', import.meta.url), '// Generated from the pulldown-cmark Unicode punctuation table.\n' + source.slice(0, source.indexOf('//!')) + 'export const punctuation = new Uint32Array(' + JSON.stringify(ranges) + ')\n')
console.log('Parser tables generated')

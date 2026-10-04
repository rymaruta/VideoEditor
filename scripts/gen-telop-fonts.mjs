// テロップ用の同梱フォントの @font-face を作る(woff2 だけ。woff まで入れると容量が倍になる)
// 使い方: node scripts/gen-telop-fonts.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const FONTS = [
  ['noto-sans-jp', [400, 700, 900]],
  ['noto-serif-jp', [400, 700]],
  ['m-plus-rounded-1c', [400, 700, 800]],
  ['dela-gothic-one', [400]],
  ['rocknroll-one', [400]],
  ['kosugi-maru', [400]],
  ['zen-maru-gothic', [500, 700]],
  ['yomogi', [400]],
  ['klee-one', [400, 600]],
  ['shippori-mincho', [400, 700]]
]
const out = [
  '/* scripts/gen-telop-fonts.mjs が作る。手で直さない。フォントはすべて SIL Open Font License */'
]
for (const [pkg, weights] of FONTS) {
  for (const w of weights) {
    const css = readFileSync(`node_modules/@fontsource/${pkg}/${w}.css`, 'utf-8')
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? []
    for (const face of faces) {
      // 日本語・英数字の分だけ(キリル文字・ギリシャ文字・ベトナム語は使わない)
      if (/cyrillic|greek|vietnamese/i.test(face)) continue
      const fixed = face
        .replace(
          /src:\s*url\(([^)]+\.woff2)\)\s*format\('woff2'\)\s*,\s*url\([^)]+\.woff\)\s*format\('woff'\)/,
          (_, f) =>
            `src: url(../../../../node_modules/@fontsource/${pkg}/files/${f.replace(/^\.\/files\//, '')}) format('woff2')`
        )
        .replace(/\n\s*/g, ' ')
      out.push(fixed)
    }
  }
}
writeFileSync('src/renderer/src/assets/telopFonts.css', out.join('\n') + '\n')
console.log('faces', out.length - 1)

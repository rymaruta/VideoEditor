// 画面(UI)用の同梱フォントの @font-face を作る(Graphite 3 の決まり: 英数字は Geist、
// 数字・時刻は Geist Mono。和文はテロップ用に同梱済みの Noto Sans JP を使う)。使う太さだけにする。
// woff2 だけ・キリル/ギリシャ/ベトナム語は除く(テロップ用の gen-telop-fonts.mjs と同じ作り)。
// フォントは unicode-range で分かれているので、画面に出た字の分だけが読み込まれる。
// 使い方: node scripts/gen-ui-fonts.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const FONTS = [
  ['geist-sans', [400, 500, 600, 700]],
  ['geist-mono', [400, 500, 600]]
]
const out = [
  '/* scripts/gen-ui-fonts.mjs が作る。手で直さない。フォントはすべて SIL Open Font License */'
]
for (const [pkg, weights] of FONTS) {
  for (const w of weights) {
    const css = readFileSync(`node_modules/@fontsource/${pkg}/${w}.css`, 'utf-8')
    const faces = css.match(/@font-face\s*{[^}]*}/g) ?? []
    for (const face of faces) {
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
writeFileSync('src/renderer/src/assets/uiFonts.css', out.join('\n') + '\n')
console.log('faces', out.length - 1)

import { telopDrawnChars, telopFontWeight, TELOP_FONT_STACKS } from '@shared/telop/render'
import type { TextStyle } from '@shared/types'

/**
 * テロップの同梱フォントを、描く前に読み込む。
 *
 * 同梱フォントは文字の範囲ごとに分かれていて(`unicode-range`)、画面のどこかでその文字が
 * 使われるまで読み込まれない。Canvas に描くだけでは読み込みが始まらず、最初の1回は代わりの
 * 書体で描かれる(書き出しでは、そのまま代わりの書体で焼かれる)。
 * 使う書体・太さ・文字を `document.fonts.load` で先に読み込む。
 */
export async function loadTelopFonts(
  telops: readonly { text: string; style: TextStyle }[]
): Promise<boolean> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined
  if (!fonts?.load) return false
  // 書体と太さの組ごとに、使う文字をまとめる
  const chars = new Map<string, Set<string>>()
  for (const t of telops) {
    const family = TELOP_FONT_STACKS[t.style.fontFamily]?.split(',')[0]
    if (!family || !family.startsWith('"')) continue // PC の標準書体は読み込み不要
    const key = `${t.style.italic ? 'italic ' : ''}${telopFontWeight(t.style)} 40px ${family}`
    const set = chars.get(key) ?? new Set<string>()
    // ルビの文字も読み込む(読み込まないと、ルビだけ代わりの書体で焼かれる)
    for (const ch of telopDrawnChars(t.text)) set.add(ch)
    chars.set(key, set)
  }
  let loaded = false
  await Promise.all(
    [...chars].map(async ([font, set]) => {
      const text = [...set].join('')
      if (!text.trim()) return
      try {
        if (fonts.check(font, text)) return
        await fonts.load(font, text)
        loaded = true
      } catch {
        // 読めなければ代わりの書体で描く
      }
    })
  )
  return loaded
}

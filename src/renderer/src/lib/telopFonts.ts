import {
  invalidateTelopLayouts,
  telopDrawnChars,
  telopFontWeight,
  TELOP_FONT_STACKS
} from '@shared/telop/render'
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
    // 書体の並び(stack)の同梱フォントを全部読む。1つ目の書体に無い文字(𠮷・㎏ など)は
    // 2つ目以降の書体で描かれるので、それも先に読んでおかないと、書き出しでは
    // 代わりの書体や「豆腐」(空の四角)のまま焼かれていた
    const families = (TELOP_FONT_STACKS[t.style.fontFamily] ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f.startsWith('"')) // PC の標準書体は読み込み不要
    for (const family of families) {
      const key = `${t.style.italic ? 'italic ' : ''}${telopFontWeight(t.style)} 40px ${family}`
      const set = chars.get(key) ?? new Set<string>()
      // ルビの文字も読み込む(読み込まないと、ルビだけ代わりの書体で焼かれる)
      for (const ch of telopDrawnChars(t.text)) set.add(ch)
      chars.set(key, set)
    }
  }
  let loaded = false
  await Promise.all(
    [...chars].map(async ([font, set]) => {
      // 読み込みを確かめ済みの文字は数えない(`fonts.check` は同梱フォントの範囲の数だけ照合し、
      // 1回 15〜170ms かかる。再生中は毎フレーム呼ばれ、6秒の再生で 5.4秒をここで使っていた)
      const done = confirmed.get(font)
      const missing = [...set].filter((ch) => !done?.has(ch))
      const text = missing.join('')
      if (!text.trim()) return
      try {
        if (!fonts.check(font, text)) {
          await fonts.load(font, text)
          loaded = true
        }
        const known = confirmed.get(font) ?? new Set<string>()
        for (const ch of missing) known.add(ch)
        confirmed.set(font, known)
      } catch {
        // 読めなければ代わりの書体で描く(確かめ済みにはしない。次にまた試す)
      }
    })
  )
  // 書体が替わると文字の幅も替わる。覚えている配置を捨てる
  if (loaded) invalidateTelopLayouts()
  return loaded
}

// 読み込みはここ以外(画面の別の所・ブラウザ自身)でも進むので、終わるたびに配置を捨てる
if (typeof document !== 'undefined') {
  document.fonts?.addEventListener?.('loadingdone', () => invalidateTelopLayouts())
}

/** 書体(`loadTelopFonts` の鍵)ごとに、読み込みを確かめ済みの文字。フォントはページから消えないので覚えておける */
const confirmed = new Map<string, Set<string>>()

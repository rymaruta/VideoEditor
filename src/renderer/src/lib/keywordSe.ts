import type { TextOverlay } from '@shared/types'
import type { SfxDictionaryEntry } from '../store/sfxDictionaryStore'

export interface KeywordSeMatch {
  id: string
  overlayId: string
  keyword: string
  entry: SfxDictionaryEntry
  time: number
  contextText: string
}

/**
 * キーワードが**言われた瞬間**の時刻を、語のタイムスタンプから求める。
 *
 * 「語がキーワードの部分文字列なら当たり(`keyword.includes(w.text)`)」で最初の語を
 * 採ると、whisper の語割りは日本語だと1〜2文字が普通なので、**キーワードより前にある
 * 無関係な語**へ時刻が吸い付く(実測: 「その手の話は拍手もの」で「拍手」のSEが
 * 1.2秒ではなく0.4秒の「手」に、「いまからすごい技」で「すごい」のSEが0.8秒ではなく
 * 0秒の「い」に置かれていた)。
 *
 * 語の本文は `buildWordSegment` が連結してテロップ本文を作っているので、
 * **連結した文字列の中でキーワードが始まる位置**を探し、文字数の累積で
 * その位置を含む語を選ぶ。連結と本文が食い違う(手で本文だけ直した等)ときは、
 * キーワードを**丸ごと含む語**だけを控えめに探す(部分文字列側の当て方は誤爆するので使わない)。
 */
function keywordTime(overlay: TextOverlay, keyword: string): number {
  const words = overlay.words
  if (!words || words.length === 0) return overlay.startTime
  const joined = words.map((w) => w.text).join('')
  const at = joined.indexOf(keyword)
  if (at >= 0) {
    let consumed = 0
    for (const w of words) {
      if (at < consumed + w.text.length) return w.start
      consumed += w.text.length
    }
  }
  const containing = words.find((w) => w.text.includes(keyword))
  return containing ? containing.start : overlay.startTime
}

export function detectKeywordSeMatches(
  textOverlays: TextOverlay[],
  dictionary: SfxDictionaryEntry[]
): KeywordSeMatch[] {
  const matches: KeywordSeMatch[] = []
  for (const overlay of textOverlays) {
    for (const entry of dictionary) {
      const keyword = entry.keyword.trim()
      if (!keyword || !overlay.text.includes(keyword)) continue
      const time = keywordTime(overlay, keyword)
      matches.push({
        id: `${overlay.id}-${entry.id}`,
        overlayId: overlay.id,
        keyword,
        entry,
        time,
        contextText: overlay.text
      })
    }
  }
  return matches.sort((a, b) => a.time - b.time)
}

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

export function detectKeywordSeMatches(
  textOverlays: TextOverlay[],
  dictionary: SfxDictionaryEntry[]
): KeywordSeMatch[] {
  const matches: KeywordSeMatch[] = []
  for (const overlay of textOverlays) {
    for (const entry of dictionary) {
      const keyword = entry.keyword.trim()
      if (!keyword || !overlay.text.includes(keyword)) continue
      let time = overlay.startTime
      const word = overlay.words?.find((w) => w.text.includes(keyword) || keyword.includes(w.text))
      if (word) time = word.start
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

import { normalizeGameKey } from './gameResearch'

export interface TrendSnapshot {
  timestamp: number
  gameNames: string[]
}

const STORAGE_KEY = 've-game-trend-history'
const MAX_HISTORY = 10

export function loadTrendHistory(): TrendSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 配列であることだけ見て中身を信じると、`[null]` のような値で compareTrend の
    // `previous.gameNames` が落ちる(この関数には try がないのでトレンド画面ごと死ぬ)。
    // 使える要素だけ残す。
    return parsed.filter(
      (v): v is TrendSnapshot =>
        typeof v === 'object' &&
        v !== null &&
        typeof (v as TrendSnapshot).timestamp === 'number' &&
        Array.isArray((v as TrendSnapshot).gameNames)
    )
  } catch {
    return []
  }
}

export function saveTrendSnapshot(gameNames: string[]): void {
  const history = loadTrendHistory()
  history.push({ timestamp: Date.now(), gameNames })
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY)))
}

export interface TrendComparison {
  previousTimestamp: number
  newGames: string[]
  sustainedGames: string[]
}

/**
 * 前回と比べる。
 *
 * 突き合わせは**正規化した鍵**で行う。生の文字列で比べると、AIが前回「Apex Legends」・
 * 今回「APEX」と書いただけで**同じゲームが毎回「新規」**として出続け、
 * 「新規」という表示そのものが当てにならなくなる(画面に出す名前は今回の表記のまま)。
 */
export function compareTrend(currentGameNames: string[]): TrendComparison | null {
  const history = loadTrendHistory()
  if (history.length === 0) return null
  const previous = history[history.length - 1]
  const previousSet = new Set(
    previous.gameNames
      .filter((g): g is string => typeof g === 'string')
      .map((g) => normalizeGameKey(g))
  )
  const seen = new Set<string>()
  const newGames: string[] = []
  const sustainedGames: string[] = []
  for (const name of Array.isArray(currentGameNames) ? currentGameNames : []) {
    if (typeof name !== 'string') continue
    const key = normalizeGameKey(name)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    if (previousSet.has(key)) sustainedGames.push(name)
    else newGames.push(name)
  }
  return { previousTimestamp: previous.timestamp, newGames, sustainedGames }
}

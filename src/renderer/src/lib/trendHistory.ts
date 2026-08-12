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

export function compareTrend(currentGameNames: string[]): TrendComparison | null {
  const history = loadTrendHistory()
  if (history.length === 0) return null
  const previous = history[history.length - 1]
  const previousSet = new Set(previous.gameNames)
  return {
    previousTimestamp: previous.timestamp,
    newGames: currentGameNames.filter((g) => !previousSet.has(g)),
    sustainedGames: currentGameNames.filter((g) => previousSet.has(g))
  }
}

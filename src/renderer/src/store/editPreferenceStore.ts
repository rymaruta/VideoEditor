import { create } from 'zustand'
import type { AutoEditPattern, AutoEditStyle, TransitionType } from '@shared/types'
import { AUTO_EDIT_STYLES, STYLE_LABELS, TRANSITION_TYPES } from '../lib/autoEditStyles'

const STORAGE_KEY = 've-edit-preferences'

interface StyleStat {
  liked: number
  disliked: number
}

interface StoredPrefs {
  styleStats: Record<AutoEditStyle, StyleStat>
  transitionCounts: Record<TransitionType, number>
  likedSegmentSecondsSum: number
  likedSegmentSampleCount: number
}

function emptyPrefs(): StoredPrefs {
  return {
    styleStats: Object.fromEntries(
      AUTO_EDIT_STYLES.map((s) => [s, { liked: 0, disliked: 0 }])
    ) as Record<AutoEditStyle, StyleStat>,
    transitionCounts: Object.fromEntries(TRANSITION_TYPES.map((t) => [t, 0])) as Record<
      TransitionType,
      number
    >,
    likedSegmentSecondsSum: 0,
    likedSegmentSampleCount: 0
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 0以上の有限な数だけ通す。それ以外(文字列・null・NaN・Infinity・負)は 0 */
function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/**
 * localStorage は外部入力。**`JSON.parse` が通ったことは「期待した形」を何も保証しない。**
 *
 * 以前はスプレッドで浅く混ぜていた(`{ ...base.styleStats, ...parsed.styleStats }`)ため、
 * `{"styleStats":{"score":null}}` のような値がそのまま state に入り、読む側の
 * `styleStats[s].liked` が落ちた。`getSummaryText` は AIおまかせ全自動編集モーダルの
 * **レンダー中**に呼ばれるので、**モーダルを開いた瞬間に画面ごと落ちる**
 * (実測: `Cannot read properties of null (reading 'liked')` で ErrorBoundary が出た)。
 * 知っているキーだけを1件ずつ検証して取り込み、使えない分は既定値のままにする。
 */
function loadPrefs(): StoredPrefs {
  const base = emptyPrefs()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return base
    const rawStats = isRecord(parsed.styleStats) ? parsed.styleStats : {}
    const rawTransitions = isRecord(parsed.transitionCounts) ? parsed.transitionCounts : {}
    const styleStats = { ...base.styleStats }
    for (const style of AUTO_EDIT_STYLES) {
      const v = rawStats[style]
      if (!isRecord(v)) continue
      styleStats[style] = { liked: asCount(v.liked), disliked: asCount(v.disliked) }
    }
    const transitionCounts = { ...base.transitionCounts }
    for (const t of TRANSITION_TYPES) {
      transitionCounts[t] = asCount(rawTransitions[t])
    }
    return {
      styleStats,
      transitionCounts,
      likedSegmentSecondsSum: asCount(parsed.likedSegmentSecondsSum),
      likedSegmentSampleCount: asCount(parsed.likedSegmentSampleCount)
    }
  } catch {
    return base
  }
}

function savePrefs(prefs: StoredPrefs): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
}

function averageSegmentSeconds(pattern: AutoEditPattern): number {
  if (pattern.segments.length === 0) return 0
  const total = pattern.segments.reduce((sum, s) => sum + (s.end - s.start), 0)
  return total / pattern.segments.length
}

interface EditPreferenceState {
  prefs: StoredPrefs
  recordFeedback: (pattern: AutoEditPattern, liked: boolean) => void
  getPreferredStyleOrder: () => AutoEditStyle[]
  getPreferredTransition: () => TransitionType
  getPreferredSegmentSeconds: () => number | null
  getSummaryText: () => string
  resetPreferences: () => void
}

export const useEditPreferenceStore = create<EditPreferenceState>((set, get) => ({
  prefs: loadPrefs(),

  recordFeedback: (pattern, liked) =>
    set((state) => {
      const prefs: StoredPrefs = {
        styleStats: { ...state.prefs.styleStats },
        transitionCounts: { ...state.prefs.transitionCounts },
        likedSegmentSecondsSum: state.prefs.likedSegmentSecondsSum,
        likedSegmentSampleCount: state.prefs.likedSegmentSampleCount
      }
      const stat = prefs.styleStats[pattern.style] ?? { liked: 0, disliked: 0 }
      prefs.styleStats[pattern.style] = liked
        ? { ...stat, liked: stat.liked + 1 }
        : { ...stat, disliked: stat.disliked + 1 }
      if (liked) {
        prefs.transitionCounts[pattern.transition] =
          (prefs.transitionCounts[pattern.transition] ?? 0) + 1
        prefs.likedSegmentSecondsSum += averageSegmentSeconds(pattern)
        prefs.likedSegmentSampleCount += 1
      }
      savePrefs(prefs)
      return { prefs }
    }),

  getPreferredStyleOrder: () => {
    const { styleStats } = get().prefs
    return [...AUTO_EDIT_STYLES].sort((a, b) => {
      const scoreA = styleStats[a].liked - styleStats[a].disliked
      const scoreB = styleStats[b].liked - styleStats[b].disliked
      return scoreB - scoreA
    })
  },

  getPreferredTransition: () => {
    const { transitionCounts } = get().prefs
    let best: TransitionType = 'crossfade'
    let bestCount = 0
    for (const t of TRANSITION_TYPES) {
      if (transitionCounts[t] > bestCount) {
        bestCount = transitionCounts[t]
        best = t
      }
    }
    return best
  },

  getPreferredSegmentSeconds: () => {
    const { likedSegmentSecondsSum, likedSegmentSampleCount } = get().prefs
    if (likedSegmentSampleCount === 0) return null
    return likedSegmentSecondsSum / likedSegmentSampleCount
  },

  getSummaryText: () => {
    const { styleStats } = get().prefs
    const totalFeedback = AUTO_EDIT_STYLES.reduce(
      (sum, s) => sum + styleStats[s].liked + styleStats[s].disliked,
      0
    )
    if (totalFeedback === 0) return 'まだフィードバックの蓄積はありません。'
    const order = get().getPreferredStyleOrder()
    const liked = order.filter((s) => styleStats[s].liked > styleStats[s].disliked)
    const disliked = order.filter((s) => styleStats[s].disliked > styleStats[s].liked)
    const segSeconds = get().getPreferredSegmentSeconds()
    const parts: string[] = []
    if (liked.length > 0) {
      parts.push(`好まれる編集スタイル: ${liked.map((s) => STYLE_LABELS[s]).join('、')}`)
    }
    if (disliked.length > 0) {
      parts.push(`評価が低い編集スタイル: ${disliked.map((s) => STYLE_LABELS[s]).join('、')}`)
    }
    if (segSeconds) {
      parts.push(`好まれるカット尺の目安: 約${segSeconds.toFixed(1)}秒`)
    }
    return parts.length > 0 ? parts.join(' / ') : '傾向はまだ明確ではありません。'
  },

  resetPreferences: () => {
    const prefs = emptyPrefs()
    savePrefs(prefs)
    set({ prefs })
  }
}))

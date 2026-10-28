import type { AutoEditLock, Project } from '@shared/types'
import { frameSeconds } from '@shared/frameRate'
import { clipTimes, timelineBlocksOf, type TimelineRange } from '@shared/roughCut/range'
import { toCommon } from '@shared/sync/multicam'
import { TURN_RATE } from '@shared/diarize/micTurns'

/**
 * 範囲の自動編集・ロックに使う「今選んでいる範囲」(タイムラインの秒)。
 * 1. イン点・アウト点(両方あるとき)
 * 2. ルーラーを Shift+ドラッグした範囲
 * 3. 本編のクリップを2本以上選んでいれば、その外枠
 * どれも無ければ null(場面の帯の右クリックは、その場面の範囲を直に渡す)
 */
export interface RangeSource {
  /** イン点・アウト点(`projectStore` の UI 状態。タイムラインの秒。Shift+Delete と同じく両方あるときだけ使う) */
  timelineIn?: number | null
  timelineOut?: number | null
  dragRange?: TimelineRange | null
  multiSelectedClipIds?: readonly string[]
  project: Pick<Project, 'clips'>
}

export type RangeOrigin = 'marks' | 'drag' | 'selection' | 'scene'

export function currentTimelineRange(
  s: RangeSource
): { range: TimelineRange; origin: RangeOrigin } | null {
  const inT = s.timelineIn ?? undefined
  const outT = s.timelineOut ?? undefined
  if (typeof inT === 'number' && typeof outT === 'number' && Math.abs(outT - inT) > 1e-3)
    return {
      range: { start: Math.min(inT, outT), end: Math.max(inT, outT) },
      origin: 'marks'
    }
  if (s.dragRange && s.dragRange.end - s.dragRange.start > 1e-3)
    return { range: { ...s.dragRange }, origin: 'drag' }
  const ids = new Set(s.multiSelectedClipIds ?? [])
  if (ids.size >= 2) {
    const times = clipTimes(s.project.clips)
    let start = Infinity
    let end = -Infinity
    s.project.clips.forEach((c, i) => {
      if (!ids.has(c.id)) return
      start = Math.min(start, times[i].start)
      end = Math.max(end, times[i].end)
    })
    if (end > start) return { range: { start, end }, origin: 'selection' }
  }
  return null
}

/** 範囲の境を寄せる距離(秒) */
export const RANGE_SNAP_SEC = 0.3

/**
 * 範囲の境を、前後 0.3 秒の中のいちばん静かな所と、フレームの境へ寄せる(言葉の途中で切らない)。
 * 境が収録素材でないクリップ(差し込みの画)の中なら、そのクリップの外の端へ広げる(画を割らない)。
 * 寄せる先はその境を含むクリップの中だけ(隣のクリップへは越えない)
 */
export function snapRangeBoundaries(
  project: Pick<Project, 'clips' | 'assets' | 'multicam'>,
  range: TimelineRange,
  level: Float32Array | undefined
): TimelineRange {
  const info = project.multicam
  const times = clipTimes(project.clips)
  const total = times.length > 0 ? times[times.length - 1].end : 0
  const frame = frameSeconds(project.clips, project.assets) || 1 / 30
  const fileOf = new Map((info?.files ?? []).map((f) => [f.assetId, f]))
  const snapOne = (t: number, side: 'start' | 'end'): number => {
    if (t <= 1e-6) return 0
    if (t >= total - 1e-6) return total
    const i = times.findIndex((x) => t >= x.start - 1e-9 && t < x.end)
    if (i < 0) return t
    const c = project.clips[i]
    const span = times[i]
    const f = fileOf.get(c.assetId)
    if (!f) return side === 'start' ? span.start : span.end
    let best = t
    if (level && level.length > 0) {
      const speed = c.speed || 1
      const lo = Math.max(span.start, t - RANGE_SNAP_SEC)
      const hi = Math.min(span.end, t + RANGE_SNAP_SEC)
      const commonAt = (x: number): number => toCommon(f, c.inPoint + (x - span.start) * speed)
      let bestDb = Infinity
      const step = 1 / TURN_RATE
      for (let x = lo; x <= hi + 1e-9; x += step) {
        const k = Math.floor(commonAt(x) * TURN_RATE)
        const v = k >= 0 && k < level.length ? level[k] : NaN
        const db = Number.isNaN(v) ? -Infinity : v
        // 同じ静かさなら元の位置に近い方
        if (
          db < bestDb - 1e-6 ||
          (Math.abs(db - bestDb) <= 1e-6 && Math.abs(x - t) < Math.abs(best - t))
        ) {
          bestDb = db
          best = x
        }
      }
    }
    // フレームの境へ(クリップの中に収める)
    const framed = Math.round(best / frame) * frame
    return Math.min(span.end, Math.max(span.start, framed))
  }
  const start = snapOne(range.start, 'start')
  const end = snapOne(range.end, 'end')
  return end - start > 1e-3 ? { start, end } : { ...range }
}

const RANGE_REQUEST_EVENT = 've:range-auto-edit'

/** ほかの画面から範囲の自動編集を頼むときの添え書き */
export interface RangeAutoEditRequestOptions {
  /** どこで決めた範囲か(省略は場面) */
  origin?: RangeOrigin
  /** 最初に選んでおく案(確認の画面の「残す」は案C) */
  prefer?: 'A' | 'B' | 'C'
}

/**
 * ほかの画面(自動編集の画面の「選んだ場面だけ作り直す」・確認の画面の「この範囲を再編集」「残す」)から、
 * 範囲の自動編集のダイアログを開く
 */
export function requestRangeAutoEdit(
  range: TimelineRange,
  options: RangeAutoEditRequestOptions = {}
): void {
  window.dispatchEvent(new CustomEvent(RANGE_REQUEST_EVENT, { detail: { range, ...options } }))
}

/** タイムラインが受ける(ダイアログはタイムラインが持つ) */
export function onRangeAutoEditRequest(
  handler: (range: TimelineRange, options: RangeAutoEditRequestOptions) => void
): () => void {
  const listener = (e: Event): void => {
    const { range, ...options } = (
      e as CustomEvent<{ range: TimelineRange } & RangeAutoEditRequestOptions>
    ).detail
    handler(range, options)
  }
  window.addEventListener(RANGE_REQUEST_EVENT, listener)
  return () => window.removeEventListener(RANGE_REQUEST_EVENT, listener)
}

/**
 * ロック(共通の時刻)の、今の本編での区間。続いて並んでいなければ(複製・並べ替え)、続いて並ぶ塊ごとに
 * 1つずつ(作り直しは塊ごとにそのまま差し戻す)。`key` は帯の印(ロックと塊の順)
 */
export function lockRangesOf(
  project: Pick<Project, 'clips' | 'multicam' | 'autoEditLocks'>
): { lock: AutoEditLock; range: TimelineRange; key: string }[] {
  const info = project.multicam
  const locks = project.autoEditLocks ?? []
  if (!info || locks.length === 0) return []
  return locks.flatMap((lock) =>
    timelineBlocksOf(project.clips, info, lock).map((b, i) => ({
      lock,
      range: { start: b.start, end: b.end },
      key: `${lock.id}#${i}`
    }))
  )
}

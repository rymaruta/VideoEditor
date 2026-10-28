import type { Project } from '@shared/types'
import { frameSeconds } from '@shared/frameRate'
import {
  getTotalDuration,
  MIN_CLIP_SOURCE_DURATION,
  runAsOneUndoStep,
  useProjectStore
} from '../store/projectStore'
import { hasNonMainSelection } from './timelineSelection'

/**
 * 編集画面のキー(Premiere の既定)から呼ぶ、本編への操作。
 *
 * 本編(V1)はクリップを隙間なく並べる作りなので、クリップを消す・縮めると後ろは必ず詰まる
 * (Premiere のリップル削除・リップルトリムと同じ結果)。ここではキーで狙う範囲を決めて、
 * 既存の操作(分割・トリム・削除)を組み合わせ、**1回の取り消しで丸ごと戻る**1件にして書き込む。
 */

/** 境目の比べで「同じ所」とみなす幅(秒) */
const EPS = 1e-4

interface MainSpan {
  id: string
  start: number
  end: number
  inPoint: number
  outPoint: number
  speed: number
}

/** 本編のクリップのタイムライン上の位置(`splitClipAtTime` と同じ数え方) */
function mainSpans(project: Project): MainSpan[] {
  let cursor = 0
  return project.clips.map((c) => {
    const speed = c.speed || 1
    const start = cursor
    cursor += (c.outPoint - c.inPoint) / speed
    return { id: c.id, start, end: cursor, inPoint: c.inPoint, outPoint: c.outPoint, speed }
  })
}

/** 本編の編集点(先頭・クリップの境目・末尾)。昇順・重複なし */
export function mainEditPoints(project: Project): number[] {
  const out: number[] = [0]
  for (const s of mainSpans(project)) {
    if (s.end - out[out.length - 1] > EPS) out.push(s.end)
  }
  return out
}

/** `t` より前で一番近い編集点(無ければ null) */
export function previousEditPoint(points: readonly number[], t: number): number | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i] < t - EPS) return points[i]
  return null
}

/** `t` より後で一番近い編集点(無ければ null) */
export function nextEditPoint(points: readonly number[], t: number): number | null {
  for (const p of points) if (p > t + EPS) return p
  return null
}

/** ↑ / ↓: 前・次の編集点へ再生位置を移す。動いたら true */
export function goToEditPoint(direction: -1 | 1): boolean {
  const store = useProjectStore.getState()
  const points = mainEditPoints(store.project)
  const t =
    direction < 0
      ? previousEditPoint(points, store.playheadTime)
      : nextEditPoint(points, store.playheadTime)
  if (t === null) return false
  store.seekTo(t)
  return true
}

/** 再生位置を `frames` フレームぶん動かす(先頭と末尾で止める) */
export function stepFrames(frames: number): void {
  const store = useProjectStore.getState()
  const frame = frameSeconds(store.project.clips, store.project.assets)
  const total = getTotalDuration(store.project)
  store.seekTo(Math.max(0, Math.min(total, store.playheadTime + frames * frame)))
}

/**
 * Q / W(リップルトリム): 再生位置の下のクリップの、再生位置より前(Q)・後ろ(W)を切って詰める。
 * Q のあとは再生位置を切った所(そのクリップの頭だった所)へ移す(Premiere と同じ)。
 * 残りが最短のクリップより短くなるときは、クリップごと消す。何かしたら true
 */
export function rippleTrimToPlayhead(side: 'start' | 'end'): boolean {
  const store = useProjectStore.getState()
  // 本編(V1)を固定していたら切らない(トラックの固定)
  if (store.project.mainTrackLocked) return false
  const p = store.playheadTime
  const span = mainSpans(store.project).find((s) => p >= s.start - EPS && p < s.end - EPS)
  if (!span) return false
  const cutStart = side === 'start' ? span.start : p
  const cutEnd = side === 'start' ? p : span.end
  if (cutEnd - cutStart <= EPS) return false
  const keepSource =
    side === 'start'
      ? span.outPoint - (span.inPoint + (p - span.start) * span.speed)
      : (p - span.start) * span.speed
  const changed = runAsOneUndoStep(() => {
    const s = useProjectStore.getState()
    if (keepSource < MIN_CLIP_SOURCE_DURATION - 1e-9) {
      s.removeClips([span.id])
    } else if (side === 'start') {
      s.updateClipTrim(span.id, span.inPoint + (p - span.start) * span.speed, span.outPoint)
    } else {
      s.updateClipTrim(span.id, span.inPoint, span.inPoint + (p - span.start) * span.speed)
    }
  })
  if (changed && side === 'start') useProjectStore.getState().seekTo(span.start)
  return changed
}

/**
 * タイムラインの [start, end) を本編から抜いて詰める(イン〜アウトのリップル削除)。
 * 両端で分割し、間に入ったクリップを消す——を1件の履歴にまとめる。何かしたら true
 */
export function rippleDeleteRange(start: number, end: number): boolean {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= EPS) return false
  if (useProjectStore.getState().project.mainTrackLocked) return false
  const before = useProjectStore.getState()
  const splitAt = (t: number): void => {
    const s = useProjectStore.getState()
    const span = mainSpans(s.project).find((x) => t > x.start + EPS && t < x.end - EPS)
    if (span) s.splitClipAtTime(span.id, t)
  }
  let removed = false
  const changed = runAsOneUndoStep(() => {
    splitAt(end)
    splitAt(start)
    const s = useProjectStore.getState()
    // 分割したあとは、どのクリップも範囲の中か外のどちらか。分割できなかった端(最短より短い
    // 切れ端になる所)は、クリップの真ん中が範囲に入るかで決める
    const ids = mainSpans(s.project)
      .filter((x) => {
        const mid = (x.start + x.end) / 2
        return mid > start && mid < end
      })
      .map((x) => x.id)
    if (ids.length > 0) {
      s.removeClips(ids)
      removed = true
    }
  })
  if (changed && !removed) {
    // 消すものが無かったのに分割だけ残さない(始める前へ戻す)
    useProjectStore.setState({
      project: before.project,
      past: before.past,
      future: before.future,
      isDirty: before.isDirty
    })
    return false
  }
  return removed
}

/**
 * Shift+Delete / Alt+Backspace: 選んでいる本編のクリップを消して詰める。
 * 選んでいなければ、イン〜アウト(両方打ってあるとき)を抜いて詰め、範囲を消して再生位置をインへ移す。
 * 何かしたら true
 */
export function rippleDelete(): boolean {
  // 音声・PiP・テロップを選んでいるなら、それを消すのはタイムライン側(Delete と同じ処理)。
  // ここでは何もしない(イン〜アウトまで抜くと、1回の押下で2つの操作になっていた)
  if (hasNonMainSelection()) return false
  const store = useProjectStore.getState()
  if (store.project.mainTrackLocked) return false
  const ids =
    store.multiSelectedClipIds.length > 0
      ? store.multiSelectedClipIds
      : store.selectedClipId
        ? [store.selectedClipId]
        : []
  if (ids.length > 0) {
    // 本編は隙間なく並ぶので、消せば後ろは詰まる(Delete と同じ書き込み。1件の履歴)
    return runAsOneUndoStep(() => useProjectStore.getState().removeClips(ids))
  }
  const { timelineIn, timelineOut } = store
  if (timelineIn === null || timelineOut === null) return false
  if (!rippleDeleteRange(timelineIn, timelineOut)) return false
  const after = useProjectStore.getState()
  after.clearTimelineInOut()
  after.seekTo(Math.min(timelineIn, getTotalDuration(after.project)))
  return true
}

/** I: イン点を再生位置に */
export function markIn(): void {
  const s = useProjectStore.getState()
  s.setTimelineIn(s.playheadTime)
}

/** O: アウト点を再生位置に */
export function markOut(): void {
  const s = useProjectStore.getState()
  s.setTimelineOut(s.playheadTime)
}

/** Shift+I / Shift+O: イン点・アウト点へ移る。打っていなければ何もしない */
export function goToMark(which: 'in' | 'out'): boolean {
  const s = useProjectStore.getState()
  const t = which === 'in' ? s.timelineIn : s.timelineOut
  if (t === null) return false
  s.seekTo(Math.min(t, getTotalDuration(s.project)))
  return true
}

/** M: 再生位置にマーカー */
export function addMarkerAtPlayhead(): string {
  const s = useProjectStore.getState()
  return s.addMarker(s.playheadTime)
}

/** Ctrl+Alt+M: 再生位置(半フレーム以内)のマーカーを消す */
export function removeMarkerAtPlayhead(): boolean {
  const s = useProjectStore.getState()
  const half = frameSeconds(s.project.clips, s.project.assets) / 2
  const hit = (s.project.markers ?? []).find((m) => Math.abs(m.time - s.playheadTime) < half)
  if (!hit) return false
  s.removeMarker(hit.id)
  return true
}

/** Shift+M / Ctrl+Shift+M: 次・前のマーカーへ */
export function goToMarker(direction: -1 | 1): boolean {
  const s = useProjectStore.getState()
  // 0〜本編の長さに収めて見る(本編を縮めたあと、末尾より先へ飛ばない)
  const total = getTotalDuration(s.project)
  const times = (s.project.markers ?? []).map((m) => Math.min(Math.max(0, m.time), total))
  const t =
    direction < 0 ? previousEditPoint(times, s.playheadTime) : nextEditPoint(times, s.playheadTime)
  if (t === null) return false
  s.seekTo(t)
  return true
}

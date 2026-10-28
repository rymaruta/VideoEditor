import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { isRangePlaying } from './shuttle'

/**
 * ループ再生(トランスポートのループのボタン)。
 *
 * - 繰り返す範囲は **イン〜アウト**。どちらかが無ければ、無い側はタイムラインの頭・終わり。
 *   イン・アウトが逆さま・同じなら全体を繰り返す
 * - Ctrl+Shift+Space(イン〜アウトを再生)と同じ範囲を使う。ループがオンなら
 *   Ctrl+Shift+Space もアウトで止まらずインへ戻って繰り返す(`shuttle.playRange`)
 * - スペースのふつうの再生でも、範囲の終わりを越えたら頭へ戻る
 * - タイムラインの終わりに着いたときはプレビューが止める代わりに頭へ戻す(`restartLoopAtEnd`)
 */

/** 範囲がこれより短ければ繰り返さない(1 コマ未満を回し続けない) */
export const MIN_LOOP_SECONDS = 0.05
/** 範囲の終わりのこれだけ手前に来たら戻す(毎フレームの確かめの間隔より少し広く) */
export const LOOP_EDGE_SECONDS = 0.03

export interface LoopBounds {
  from: number
  to: number
}

/** 繰り返す範囲。短すぎれば null */
export function loopBounds(
  timelineIn: number | null,
  timelineOut: number | null,
  total: number
): LoopBounds | null {
  if (!(total > 0)) return null
  let from = timelineIn ?? 0
  let to = Math.min(timelineOut ?? total, total)
  if (!(to - from > MIN_LOOP_SECONDS) || from < 0) {
    from = 0
    to = total
  }
  return to - from > MIN_LOOP_SECONDS ? { from, to } : null
}

/**
 * ふつうの再生で、範囲の終わりを今越えたか。越えたら戻す先(範囲の頭)を返す。
 * 範囲の外(終わりより後)から再生を始めたときは戻さない(タイムラインの終わりで戻る)
 */
export function loopRestartTime(
  previous: number,
  current: number,
  bounds: LoopBounds
): number | null {
  const edge = bounds.to - LOOP_EDGE_SECONDS
  return previous < edge && current >= edge ? bounds.from : null
}

function currentBounds(): LoopBounds | null {
  const s = useProjectStore.getState()
  return loopBounds(s.timelineIn, s.timelineOut, getTotalDuration(s.project))
}

/**
 * プレビューがタイムラインの終わりに着いたとき: ループがオンなら範囲の頭へ戻して
 * 再生を続ける(true)。オフなら何もしない(false。今までどおり止める)
 */
export function restartLoopAtEnd(): boolean {
  const s = useProjectStore.getState()
  if (!s.loopPlayback) return false
  const b = currentBounds()
  if (!b) return false
  s.seekTo(b.from)
  return true
}

/** ふつうの再生でループの範囲の終わりを越えたら頭へ戻す見張り。外すときの関数を返す */
export function installLoopWatcher(): () => void {
  let previous = useProjectStore.getState().playheadTime
  return useProjectStore.subscribe((state, prevState) => {
    const now = state.playheadTime
    const before = previous
    previous = now
    // 手で再生位置を動かした(シーク)ときは引き戻さない。動かした先から続けて、次に終わりを越えたら戻す
    if (state.seekRequest !== prevState.seekRequest) return
    if (!state.isPlaying || !state.loopPlayback || isRangePlaying()) return
    if (now === before) return
    const b = loopBounds(state.timelineIn, state.timelineOut, getTotalDuration(state.project))
    if (!b) return
    const back = loopRestartTime(before, now, b)
    if (back !== null) {
      previous = back
      state.seekTo(back)
    }
  })
}

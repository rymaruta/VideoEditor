import { v4 as uuid } from 'uuid'
import type { Clip, SilenceRange } from '@shared/types'

/**
 * これ以下の切れ端は断片として作らない(素材秒)。丸ごと消える見た目なのに
 * タイムライン上の1件として残ってしまうため。
 */
const MIN_SEGMENT_SOURCE_DURATION = 0.05

/**
 * クリップから指定区間を抜いた残りを、断片クリップの配列として組み立てる。
 *
 * 無音カット・フィラーカット・テキストで編集は、どれも「素材内の区間を消して
 * 残りを並べる」という同じ操作。式を書き写すと片方にだけ手当てが入って差が開くので、
 * ここ1箇所に置いて3経路とも同じ関数を呼ぶ。
 *
 * - 断片には元クリップを `...c` でスプレッドし、クロップ・音声分離などの設定を引き継ぐ。
 * - つなぎ(`transitionIn`)は先頭の断片だけが持つ。2件目以降に付くと元は無かった
 *   場所に重なりが生まれて尺が変わる。
 * - 全部が削除対象になった場合はクリップを丸ごと残す(消し飛ばさない)。
 */
export function buildCutSegments(clip: Clip, cutRanges: SilenceRange[]): Clip[] {
  // 数値になっていない区間・長さ0の区間は捨てる。混ざったまま進めると `cursor` が
  // NaN に汚染されて**他の正常な区間まで全部無効**になり、長さ0の区間は何も削らないのに
  // その位置でクリップを分割してしまう。1件の異常で全滅させない。
  const sorted = cutRanges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const segments: Clip[] = []
  let cursor = clip.inPoint
  for (const range of sorted) {
    // 両端ともクリップの範囲に収める。start を下側だけクランプしていると、
    // クリップの外で始まる区間(文字起こしが尺の外まで返すことがある)を渡されたとき
    // `outPoint = start` がクリップの終端を超え、削除したはずが逆に伸びる。
    const start = Math.min(clip.outPoint, Math.max(clip.inPoint, range.start))
    const end = Math.min(clip.outPoint, Math.max(clip.inPoint, range.end))
    if (start > cursor + MIN_SEGMENT_SOURCE_DURATION) {
      segments.push({
        ...clip,
        id: uuid(),
        inPoint: cursor,
        outPoint: start,
        transitionIn: undefined
      })
    }
    cursor = Math.max(cursor, end)
  }
  if (cursor < clip.outPoint - MIN_SEGMENT_SOURCE_DURATION) {
    segments.push({
      ...clip,
      id: uuid(),
      inPoint: cursor,
      outPoint: clip.outPoint,
      transitionIn: undefined
    })
  }
  if (segments.length === 0) return [{ ...clip }]
  // **1つも削れなかったなら、クリップは作り直さない。** 区間が1つも選ばれていない・
  // 選ばれた区間が全部クリップの外だった(文字起こしは尺の外まで返すことがある)のどちらでも
  // ここへ来る。新しい `id` を振った「同じ範囲の断片1本」を返すと、置き換え側が
  // 分離音声のIDまで作り直し、**中身は同じなのに参照だけが総取り替え**になる。
  // 全部が削除対象だった上の枝が丸ごと残すのと同じ扱いにする。
  if (
    segments.length === 1 &&
    segments[0].inPoint === clip.inPoint &&
    segments[0].outPoint === clip.outPoint
  ) {
    return [{ ...clip }]
  }
  segments[0] = { ...segments[0], transitionIn: clip.transitionIn }
  return segments
}

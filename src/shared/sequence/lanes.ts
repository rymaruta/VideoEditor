/**
 * 時間が重なるアイテムを、重ならない段(トラック)へ振り分ける。
 *
 * v2 は「1本のトラックの中でアイテムは重ならない」を不変条件にしている(繋ぎを除く)。
 * v1 は PiP・テロップ・音声のどれも同じレーンに重ねて置けたので、移行のときに段を分ける。
 *
 * - 開始の早い順(同じなら元の並び順)に、**入る一番下の段**へ置く。
 * - 段の中は開始順に並ぶ。元の配列は変えない。
 * - **重なり順(どちらが手前か)は保証しない。** 下の段が先に空けば、後から始まった
 *   ものが下の段に入る。重なり順を決めたいものは、呼び出し側で段を固定すること。
 */
export function assignLanes<T extends { startFrame: number; durationFrames: number }>(
  items: readonly T[]
): T[][] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.startFrame - b.item.startFrame || a.index - b.index)
  const lanes: T[][] = []
  const laneEnds: number[] = []
  for (const { item } of order) {
    let lane = laneEnds.findIndex((end) => end <= item.startFrame)
    if (lane < 0) {
      lane = lanes.length
      lanes.push([])
      laneEnds.push(0)
    }
    lanes[lane].push(item)
    laneEnds[lane] = item.startFrame + item.durationFrames
  }
  return lanes
}

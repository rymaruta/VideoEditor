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

/**
 * 重なる物を段に分ける。並びで後の物ほど上の段(手前)に置く(プレビュー・標準の書き出しは
 * 並びの順に描くので、後の物が手前)。`assignLanes` は始まりの順に詰めるので、後から始まる物が
 * 手前になり、区間ごとの書き出しだけワイプの重なり順が逆になっていた
 */
export function assignStackedLanes<T extends { startFrame: number; durationFrames: number }>(
  items: readonly T[]
): T[][] {
  const lanes: T[][] = []
  const overlaps = (a: T, b: T): boolean =>
    a.startFrame < b.startFrame + b.durationFrames && b.startFrame < a.startFrame + a.durationFrames
  for (const item of items) {
    let min = 0
    lanes.forEach((lane, li) => {
      if (lane.some((o) => overlaps(o, item))) min = li + 1
    })
    let lane = min
    while (lane < lanes.length && lanes[lane].some((o) => overlaps(o, item))) lane++
    if (lane === lanes.length) lanes.push([])
    lanes[lane].push(item)
  }
  return lanes.map((l) => [...l].sort((a, b) => a.startFrame - b.startFrame))
}

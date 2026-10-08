import type { ItemBase, Sequence } from './types'

/**
 * 書き出しを**短い区間(セグメント)に分けて並列に**レンダリングするための区切り方。
 * 計画書: `docs/VARIETY_AUTO_EDIT_PLAN.md` §4.3
 *
 * 現行の書き出しはクリップ1本ごとに ffmpeg の入力を1つ足し、1つのフィルタグラフで全部を
 * 繋ぐ。数千クリップの長尺では入力数とグラフの規模が破綻するので、区間ごとに小さい
 * グラフを組んで書き出し、最後に再エンコードなしで連結する。
 *
 * 区切る位置の決まり:
 *
 * 1. **繋ぎ(重なり)の途中と、その両端ちょうどでは切らない。** 繋ぎは前後2本を同時に
 *    混ぜるので、途中で切ると片側の区間に相手が居なくなる。両端ちょうどで切ると、
 *    出ていく側か入ってくる側の片方が区間の中に**繋ぎの長さぶんしか無く**、`xfade`
 *    (入力より短い必要がある)が組めずに**繋ぎが丸ごと消える**
 *    (実測: 0.7秒のクロスフェードが、区間の境目が繋ぎの終わりに来たときも、
 *     始まりに来たときも、ハードカットになって書き出された)。
 * 2. **カット点(どこかのアイテムの始まり・終わり)を優先**して切る。そこなら
 *    区間の頭で途中から読み始めるアイテムが少なく、デコードの無駄が減る。
 * 3. 区間の長さは `minFrames`〜`maxFrames` に収め、`targetFrames` に一番近いカット点を選ぶ。
 *    範囲にカット点が無ければ、`maxFrames` の位置(繋ぎの途中なら手前へずらす)で切る。
 *
 * 4. 1区間で読む素材の数を `maxItems` 以下に抑える(映像と音声それぞれで数える)。
 *    ffmpeg は入力1つごとにデコーダを開くので、**メモリは区間の長さではなく本数で決まる**。
 *    細かく刻んだ企画ほど区間を短くして、1区間あたりのメモリをほぼ一定に保つ
 *    (実測: 0.75秒×400カット・5分の企画を2並列で、本数の上限なしだと ffmpeg が
 *     合計 4.8GB まで膨らんだ)。上限に収めるためなら `minFrames` より短い区間も作る。
 *
 * 長さが `maxFrames` を超える(または本数が `maxItems` を超える)のは、繋ぎを割らないと
 * 切れないときだけ(そのときは繋ぎの終わりの次のフレームで切る)。
 */
export interface SegmentPlanOptions {
  targetFrames: number
  minFrames: number
  maxFrames: number
  /** 1区間に掛かってよい素材アイテムの数(映像・音声それぞれ)。未指定は上限なし */
  maxItems?: number
}

export interface Segment {
  index: number
  startFrame: number
  /** 区間の終わり(この値は含まない) */
  endFrame: number
  /** この区間に1フレームでも掛かる映像・音声アイテムの ID */
  itemIds: string[]
}

/** 30fps で 45秒前後・20〜90秒。並列数と、1区間の失敗でやり直す量の釣り合い */
export function defaultSegmentOptions(fps: number): SegmentPlanOptions {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 30
  return {
    targetFrames: Math.round(45 * f),
    minFrames: Math.round(20 * f),
    maxFrames: Math.round(90 * f),
    maxItems: 24
  }
}

/** シーケンスの尺(フレーム)。どのトラックのアイテムでも、一番遅い終わり */
export function sequenceDurationFrames(sequence: Sequence): number {
  let end = 0
  for (const track of [...sequence.videoTracks, ...sequence.audioTracks]) {
    for (const item of track.items) {
      end = Math.max(end, item.startFrame + item.durationFrames)
    }
  }
  return end
}

export function planSegments(sequence: Sequence, options: SegmentPlanOptions): Segment[] {
  const total = sequenceDurationFrames(sequence)
  if (total <= 0) return []
  const minFrames = Math.max(1, Math.floor(options.minFrames))
  const maxFrames = Math.max(minFrames, Math.floor(options.maxFrames))
  const targetFrames = Math.min(maxFrames, Math.max(minFrames, Math.round(options.targetFrames)))

  // 切ってはいけない閉区間 [重なりの始まり, 重なりの終わり]
  const forbidden: [number, number][] = []
  const cuts = new Set<number>()
  for (const track of sequence.videoTracks) {
    for (const item of track.items) {
      cuts.add(item.startFrame)
      cuts.add(item.startFrame + item.durationFrames)
      if (item.kind === 'media' && item.transitionIn && item.transitionIn.durationFrames > 0) {
        forbidden.push([item.startFrame, item.startFrame + item.transitionIn.durationFrames])
      }
    }
  }
  for (const track of sequence.audioTracks) {
    for (const item of track.items) {
      cuts.add(item.startFrame)
      cuts.add(item.startFrame + item.durationFrames)
    }
  }
  const isForbidden = (f: number): boolean => forbidden.some(([a, b]) => f >= a && f <= b)
  /** 繋ぎに掛かるなら、その繋ぎの始まりの1つ手前へ戻す(重なりが連なっていても繰り返し戻す) */
  const backOff = (f: number): number => {
    let x = f
    for (;;) {
      const hit = forbidden.find(([a, b]) => x >= a && x <= b)
      if (!hit) return x
      x = hit[0] - 1
    }
  }
  /** 繋ぎに掛かるなら、その繋ぎの終わりの次のフレームへ進める */
  const forward = (f: number): number => {
    let x = f
    for (;;) {
      const hit = forbidden.find(([a, b]) => x >= a && x <= b)
      if (!hit) return x
      x = hit[1] + 1
    }
  }
  // 本数の数え方: 素材を読むアイテム(テロップは入力を持たないので数えない)
  const spans = (items: ItemBase[]): [number, number][] =>
    items.map((i) => [i.startFrame, i.startFrame + i.durationFrames])
  const videoSpans = spans(
    sequence.videoTracks.flatMap((t) => t.items.filter((i) => i.kind === 'media'))
  )
  const audioSpans = spans(sequence.audioTracks.flatMap((t) => t.items))
  const countIn = (from: number, to: number): number => {
    let v = 0
    let a = 0
    for (const [s, e] of videoSpans) if (s < to && e > from) v++
    for (const [s, e] of audioSpans) if (s < to && e > from) a++
    return Math.max(v, a)
  }
  const maxItems =
    options.maxItems !== undefined && Number.isFinite(options.maxItems) && options.maxItems >= 1
      ? Math.floor(options.maxItems)
      : Infinity
  /**
   * `cursor` から始まる区間に許す本数。**その瞬間に重なっている本数だけで上限を超える**
   * (トラックを何十段も重ねた場面)ときは、上限を守ろうとすると区間が1フレームずつに
   * なってしまうので、重なっている本数 + 上限の半分までは許す(必ず前へ進むため)。
   */
  const allowedAt = (cursor: number): number =>
    maxItems === Infinity
      ? Infinity
      : Math.max(maxItems, countIn(cursor, cursor + 1) + Math.ceil(maxItems / 2))
  /** `cursor` から始めて本数が許容に収まる一番遠い終わり(`limit` まで) */
  const farthestWithinItems = (cursor: number, limit: number): number => {
    const allowed = allowedAt(cursor)
    if (allowed === Infinity || countIn(cursor, limit) <= allowed) return limit
    let ok = cursor + 1
    let ng = limit
    while (ng - ok > 1) {
      const mid = Math.floor((ok + ng) / 2)
      if (countIn(cursor, mid) <= allowed) ok = mid
      else ng = mid
    }
    return ok
  }

  const cutList = [...cuts]
    .filter((f) => f > 0 && f < total && !isForbidden(f))
    .sort((a, b) => a - b)

  const bounds: number[] = [0]
  let cursor = 0
  while (total - cursor > maxFrames || countIn(cursor, total) > allowedAt(cursor)) {
    const hi = farthestWithinItems(cursor, Math.min(total, cursor + maxFrames))
    const lo = Math.min(cursor + minFrames, hi)
    const target = Math.min(cursor + targetFrames, hi)
    let best = -1
    for (const f of cutList) {
      if (f < lo) continue
      if (f > hi) break
      if (best < 0 || Math.abs(f - target) < Math.abs(best - target)) best = f
    }
    if (best < 0) {
      // 手前へずらした結果が `minFrames` より短くなることはある(長い繋ぎの直前)。
      // 短い区間は無駄が増えるだけで正しく書き出せるので、繋ぎを割るよりこちらを選ぶ。
      best = backOff(hi)
      if (best <= cursor) best = forward(hi)
    }
    // 繋ぎの終わりまで進めたら尺の終わりに届いた: 最後の区間は下で足す(ここで足すと長さ 0 の区間ができ、
    // 区間ごとの書き出しがその区間で落ちていた)
    if (best >= total) break
    bounds.push(best)
    cursor = best
  }
  bounds.push(total)

  const allItems: ItemBase[] = [
    ...sequence.videoTracks.flatMap((t) => t.items),
    ...sequence.audioTracks.flatMap((t) => t.items)
  ]
  const segments: Segment[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const startFrame = bounds[i]
    const endFrame = bounds[i + 1]
    segments.push({
      index: i,
      startFrame,
      endFrame,
      itemIds: allItems
        .filter((it) => it.startFrame < endFrame && it.startFrame + it.durationFrames > startFrame)
        .map((it) => it.id)
    })
  }
  return segments
}

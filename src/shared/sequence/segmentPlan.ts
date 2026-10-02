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
 * 1. **繋ぎ(重なり)の途中では切らない。** 繋ぎは前後2本を同時に混ぜるので、
 *    途中で切ると片側の区間に相手が居なくなる。重なりの両端ちょうどは切ってよい。
 * 2. **カット点(どこかのアイテムの始まり・終わり)を優先**して切る。そこなら
 *    区間の頭で途中から読み始めるアイテムが少なく、デコードの無駄が減る。
 * 3. 区間の長さは `minFrames`〜`maxFrames` に収め、`targetFrames` に一番近いカット点を選ぶ。
 *    範囲にカット点が無ければ、`maxFrames` の位置(繋ぎの途中なら手前へずらす)で切る。
 *
 * 長さが `maxFrames` を超えるのは、`maxFrames` より長い繋ぎがあって手前に切れる位置が
 * 無いときだけ(そのときは繋ぎの終わりで切る)。
 */
export interface SegmentPlanOptions {
  targetFrames: number
  minFrames: number
  maxFrames: number
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
    maxFrames: Math.round(90 * f)
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

  // 切ってはいけない開区間 (重なりの始まり, 重なりの終わり)
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
  const isForbidden = (f: number): boolean => forbidden.some(([a, b]) => f > a && f < b)
  /** 繋ぎの途中なら、その繋ぎの始まりへ戻す(重なりが連なっていても繰り返し戻す) */
  const backOff = (f: number): number => {
    let x = f
    for (;;) {
      const hit = forbidden.find(([a, b]) => x > a && x < b)
      if (!hit) return x
      x = hit[0]
    }
  }
  /** 繋ぎの途中なら、その繋ぎの終わりへ進める */
  const forward = (f: number): number => {
    let x = f
    for (;;) {
      const hit = forbidden.find(([a, b]) => x > a && x < b)
      if (!hit) return x
      x = hit[1]
    }
  }
  const cutList = [...cuts]
    .filter((f) => f > 0 && f < total && !isForbidden(f))
    .sort((a, b) => a - b)

  const bounds: number[] = [0]
  let cursor = 0
  while (total - cursor > maxFrames) {
    const lo = cursor + minFrames
    const hi = cursor + maxFrames
    const target = cursor + targetFrames
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

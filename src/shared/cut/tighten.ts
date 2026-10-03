import { TURN_RATE } from '../diarize/micTurns'

/**
 * カット(計画書 §5.6): 残した場面の中の長い「間」を詰めて、バラエティのテンポにする。
 *
 * - 間 = どのマイクでも音が鳴っていない時間。笑い声・リアクションは音として鳴っているので間にならず、残る
 * - 発話(文字起こしの区間)の途中では切らない
 * - 長い間は `keepPauseSec` まで詰める(前後に半分ずつ残す)。場面の頭と終わりの無音も詰める
 *
 * 時刻は共通の時間軸。結果は時刻順の区間の並び(この順にタイムラインへつなぐ)。
 */

export interface CutRange {
  start: number
  end: number
  /** どの場面から来たか */
  sceneId?: string
}

export interface TightenOptions {
  /** これより長い間を詰める(秒) */
  maxPauseSec?: number
  /** 詰めた後に残す間(秒) */
  keepPauseSec?: number
  /** これより短い区間は捨てる(秒) */
  minPieceSec?: number
}

export function tightenRanges(
  ranges: readonly CutRange[],
  activity: Uint8Array,
  protectedRanges: readonly { start: number; end: number }[],
  options: TightenOptions = {}
): CutRange[] {
  const maxPause = options.maxPauseSec ?? 0.7
  const keep = options.keepPauseSec ?? 0.3
  const minPiece = options.minPieceSec ?? 0.3
  const n = activity.length
  // 鳴っている所 + 発話の区間を「切らない所」にする
  const busy = new Uint8Array(n)
  busy.set(activity)
  for (const p of protectedRanges) {
    const a = Math.max(0, Math.floor(p.start * TURN_RATE))
    const b = Math.min(n, Math.ceil(p.end * TURN_RATE))
    busy.fill(1, a, b)
  }

  const out: CutRange[] = []
  for (const r of ranges) {
    const a = Math.max(0, Math.floor(r.start * TURN_RATE))
    const b = Math.min(n, Math.ceil(r.end * TURN_RATE))
    // 区間の中の「鳴っている塊」を拾い、塊の間の長い無音を詰める
    const blocks: [number, number][] = []
    let t = a
    while (t < b) {
      while (t < b && !busy[t]) t++
      if (t >= b) break
      let e = t
      while (e < b && busy[e]) e++
      blocks.push([t, e])
      t = e
    }
    if (blocks.length === 0) continue
    const half = (keep / 2) * TURN_RATE
    let curStart = Math.max(a, blocks[0][0] - half)
    let curEnd = blocks[0][1]
    for (let i = 1; i < blocks.length; i++) {
      const gap = blocks[i][0] - curEnd
      if (gap > maxPause * TURN_RATE) {
        out.push({
          start: curStart / TURN_RATE,
          end: (curEnd + half) / TURN_RATE,
          sceneId: r.sceneId
        })
        curStart = blocks[i][0] - half
      }
      curEnd = blocks[i][1]
    }
    out.push({
      start: curStart / TURN_RATE,
      end: Math.min(b, curEnd + half) / TURN_RATE,
      sceneId: r.sceneId
    })
  }
  return out.filter((p) => p.end - p.start >= minPiece)
}

export function totalLength(ranges: readonly CutRange[]): number {
  return ranges.reduce((t, r) => t + (r.end - r.start), 0)
}

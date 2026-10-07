import { TURN_RATE } from '../diarize/micTurns'

/**
 * カット(計画書 §5.6): 残した場面の中の長い「間」を詰めて、バラエティのテンポにする。
 *
 * - 間 = どのマイクでも音が鳴っていない時間。笑い声・リアクションは音として鳴っているので間にならず、残る
 * - 発話(文字起こしの区間)の途中では切らない
 * - 長い間は `keepPauseSec` まで詰める(前後に半分ずつ残す)。場面の頭と終わりの無音も詰める
 * - ただし `insertMinSec` 以上の無音は、頭から数秒を「絵」として残す(長いほど少し長く、最長 `insertMaxSec`)。
 *   ロケでは声の無い所が見せ場のことが多い(一口目を食べる・料理の寄り・景色)。実写の食べ歩き(12分)で
 *   2.5 秒以上の無音 9 か所のうち 8 か所が、食べている所か料理の寄りだった。頭から残すのは、
 *   言ったこと(「いただきます」)と、その後の動き(食べる)をつなげて見せるため
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
  /** これ以上の無音は、頭の数秒を絵として残す(秒)。Infinity で残さない */
  insertMinSec?: number
  /** 絵として残す長さ: `insertBaseSec + insertRate ×(無音 − insertMinSec)`、最長 `insertMaxSec` */
  insertBaseSec?: number
  insertRate?: number
  insertMaxSec?: number
}

/** 絵として残す無音の既定値 */
export const INSERT_DEFAULTS = {
  insertMinSec: 2.5,
  insertBaseSec: 1.5,
  insertRate: 0.25,
  insertMaxSec: 5
} as const

export function tightenRanges(
  ranges: readonly CutRange[],
  activity: Uint8Array,
  protectedRanges: readonly { start: number; end: number }[],
  options: TightenOptions = {}
): CutRange[] {
  const maxPause = options.maxPauseSec ?? 0.7
  const keep = options.keepPauseSec ?? 0.3
  const minPiece = options.minPieceSec ?? 0.3
  const insertMin = options.insertMinSec ?? INSERT_DEFAULTS.insertMinSec
  const insertBase = options.insertBaseSec ?? INSERT_DEFAULTS.insertBaseSec
  const insertRate = options.insertRate ?? INSERT_DEFAULTS.insertRate
  const insertMax = options.insertMaxSec ?? INSERT_DEFAULTS.insertMaxSec
  /** 長さ gap(100Hz の数)の無音のうち、頭から絵として残す長さ(100Hz の数)。残さないなら 0 */
  const insertOf = (gap: number): number => {
    const sec = gap / TURN_RATE
    if (!(sec >= insertMin)) return 0
    return Math.round(Math.min(insertMax, insertBase + insertRate * (sec - insertMin)) * TURN_RATE)
  }
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
        // 長い無音は頭の数秒を絵として残す(次の塊の手前の間は、ふつうに詰める)
        const insert = Math.min(insertOf(gap), gap - 2 * half)
        out.push({
          start: curStart / TURN_RATE,
          end: (curEnd + Math.max(half, insert)) / TURN_RATE,
          sceneId: r.sceneId
        })
        curStart = blocks[i][0] - half
      }
      curEnd = blocks[i][1]
    }
    // 場面の終わりの無音も、長ければ頭の数秒を絵として残す。場面は長い無音の所で分かれるので
    // (8 秒以上の無音は、話の無い場面として独りになる)、無音の長さは場面の外まで見て測り、
    // 絵は次の場面へはみ出してよい(次に音が鳴る所の手前まで)
    let next = curEnd
    while (next < n && !busy[next]) next++
    const tailGap = next - curEnd
    const tailInsert = Math.min(insertOf(tailGap), tailGap - 2 * half)
    out.push({
      start: curStart / TURN_RATE,
      end: (tailInsert > half ? curEnd + tailInsert : Math.min(b, curEnd + half)) / TURN_RATE,
      sceneId: r.sceneId
    })
  }
  return out.filter((p) => p.end - p.start >= minPiece)
}

export function totalLength(ranges: readonly CutRange[]): number {
  return ranges.reduce((t, r) => t + (r.end - r.start), 0)
}

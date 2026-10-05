import type { CutRange } from '../cut/tighten'
import { TURN_RATE, type MicTrack } from '../diarize/micTurns'

/**
 * カット点を、近くの「いちばん静かな所」へ寄せる(計画書 §5.6)。
 *
 * 間を詰めるカット(`tightenRanges`)は、0.2 秒でならした音の大きさで「鳴っている塊」を決め、
 * その外側に間を半分ずつ残して切る。ならすと、語尾の息・「〜です」の無声の「す」・舌打ちのような
 * 数十 ms の短い音は塊にならず、切る位置にちょうど掛かることがある。
 * 30分の回(切れ目 452 か所)で、切る位置の音が -40dB を超えていた(音の途中で切っていた)のが 8 か所、
 * うち 4 か所は -21〜-14dB の短い音のど真ん中だった(音がぷつっと切れ、書き出すとクリック音になる)。
 *
 * そこで、時間の飛ぶ切れ目だけを、前後 `radiusSec` の中の静かな所(周りのいちばん静かな所 + `quietDb` 以内)へ動かす。
 * - すでに静かな所で切っているなら動かさない(今うまくいっている所は変えない)
 * - 動かす向きは**残す側を広げる向き**を先に探す(頭なら前へ、終わりなら後ろへ)。言葉の頭・語尾を
 *   削るより、短い音を丸ごと残すほうが安全。広げる側に静かな所が無いときだけ、狭める側を探す
 * - 前後の区間とは重ならない・入れ替わらない
 */

export interface SnapOptions {
  /** 探す範囲(秒) */
  radiusSec?: number
  /** 周りのいちばん静かな所より、これ以内なら静かとみなす(dB) */
  quietDb?: number
  /** 周りの静かさを測る範囲(秒) */
  floorSec?: number
}

/** 時間が飛んだとみなす切れ目(秒)。これより近い区間どうしは続いている */
const CONTIGUOUS_SEC = 0.05

/**
 * マイク(と基準カメラ)の音を足した大きさ(dB、100Hz)。どのマイクも録っていない所は NaN。
 * 書き出しでは全部のマイクが鳴るので、どれか1本でも鳴っていれば「鳴っている」
 */
export function mixLevelDb(tracks: readonly MicTrack[]): Float32Array {
  const n = Math.max(0, ...tracks.map((t) => t.envelope.length))
  const out = new Float32Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    let power = 0
    let any = false
    for (const t of tracks) {
      const v = t.envelope[i]
      if (v === undefined || Number.isNaN(v)) continue
      power += v * v
      any = true
    }
    if (any) out[i] = 10 * Math.log10(power + 1e-12)
  }
  return out
}

export function snapCutsToQuiet(
  pieces: readonly CutRange[],
  level: Float32Array,
  options: SnapOptions = {}
): CutRange[] {
  const radius = Math.round((options.radiusSec ?? 0.12) * TURN_RATE)
  const quietDb = options.quietDb ?? 6
  const floorWin = Math.round((options.floorSec ?? 0.3) * TURN_RATE)
  const n = level.length
  const at = (k: number): number => (k >= 0 && k < n ? level[k] : NaN)
  const floorAround = (k: number): number => {
    let m = Infinity
    for (let j = k - floorWin; j <= k + floorWin; j++) {
      const v = at(j)
      if (!Number.isNaN(v) && v < m) m = v
    }
    return m
  }
  const quiet = (k: number, thr: number): boolean => {
    const v = at(k)
    return Number.isNaN(v) || v <= thr
  }
  /** t の切れ目を静かな所へ。outward = 残す側を広げる向き(-1 = 前、+1 = 後ろ) */
  const snap = (t: number, outward: -1 | 1, lo: number, hi: number): number => {
    const k0 = Math.floor(t * TURN_RATE)
    const floor = floorAround(k0)
    if (!Number.isFinite(floor)) return t
    const thr = floor + quietDb
    if (quiet(k0, thr)) return t
    for (const dir of [outward, -outward]) {
      for (let d = 1; d <= radius; d++) {
        const k = k0 + dir * d
        if (!quiet(k, thr)) continue
        // 静かな 10ms の真ん中で切る。その先も静かなら1つ先へ(音の際から少し離し、
        // 切れ目に付ける短いフェードが音の頭・語尾に掛からないように)
        const k2 = d < radius && quiet(k + dir, thr) ? k + dir : k
        const c = (k2 + 0.5) / TURN_RATE
        if (c > lo && c < hi) return c
        break
      }
    }
    return t
  }
  const out = pieces.map((p) => ({ ...p }))
  for (let i = 0; i < out.length; i++) {
    const p = out[i]
    const prev = out[i - 1]
    const next = pieces[i + 1]
    const jumpBefore = !prev || p.start - prev.end > CONTIGUOUS_SEC
    const jumpAfter = !next || next.start - p.end > CONTIGUOUS_SEC
    // 頭は前の区間の終わりより後、終わりは次の区間の頭より前に(間を少し残す)
    const mid = (p.start + p.end) / 2
    if (jumpBefore) p.start = snap(p.start, -1, prev ? prev.end + CONTIGUOUS_SEC : -Infinity, mid)
    if (jumpAfter) p.end = snap(p.end, 1, mid, next ? next.start - CONTIGUOUS_SEC : Infinity)
  }
  return out
}

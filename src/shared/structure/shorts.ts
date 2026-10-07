import { widenToLines, type HypeMoment } from './hype'

/**
 * ゲーム実況のショート(縦型・15〜60 秒)にする区間を選ぶ(`docs/GAME_AUTO_EDIT_PLAN.md` G4)。
 *
 * 山(叫び・大声・笑い)ごとに、前に何が起きたか(10 秒)と後の反応(6 秒)を含む区間を作り、
 * 端が発話の途中なら発話を丸ごと入れる。近い山はつないで1本にする(長さの上限まで)。
 * 強い山(上がり幅が大きい・笑いが重なる)から順に、重ならないものを選ぶ。
 */

export interface ShortCandidate {
  start: number
  end: number
  /** 強さ(山の上がり幅 dB の合計。笑いは 1 回 8dB として足す) */
  strength: number
  /** 入っている山の数 */
  peaks: number
}

export interface ShortOptions {
  /** 作る本数 */
  count?: number
  /** 1本の長さの下限・上限(秒) */
  minSec?: number
  maxSec?: number
  /** 山の前・後に入れる長さ(秒) */
  leadSec?: number
  tailSec?: number
}

/** 笑い1回を、声の盛り上がりの何 dB ぶんと数えるか */
const LAUGH_STRENGTH = 8

export function pickShortWindows(
  hype: readonly HypeMoment[],
  laughs: readonly { start: number; end: number }[],
  lines: readonly { start: number; end: number }[],
  range: { start: number; end: number },
  options: ShortOptions = {}
): ShortCandidate[] {
  const count = options.count ?? 5
  const minSec = options.minSec ?? 15
  const maxSec = options.maxSec ?? 60
  const lead = options.leadSec ?? 10
  const tail = options.tailSec ?? 6

  const clamp = (t: number): number => Math.max(range.start, Math.min(range.end, t))
  /** 端が発話の途中なら、発話を丸ごと入れる */
  const widen = (start: number, end: number): [number, number] => {
    const [a, b] = widenToLines(start, end, lines)
    return [clamp(a), clamp(b)]
  }

  const peaks = [
    ...hype.map((h) => ({ start: h.start, end: h.end, strength: Math.max(1, h.riseDb) })),
    ...laughs.map((l) => ({ start: l.start, end: l.end, strength: LAUGH_STRENGTH }))
  ].sort((a, b) => a.start - b.start)

  // 山ごとの区間。近い(重なる)ものはつなぐ。つないで上限を超えるなら別の区間にする
  const merged: ShortCandidate[] = []
  for (const p of peaks) {
    const [a, b] = widen(p.start - lead, p.end + tail)
    const last = merged[merged.length - 1]
    if (last && a <= last.end && Math.max(b, last.end) - last.start <= maxSec) {
      last.end = Math.max(last.end, b)
      last.strength += p.strength
      last.peaks++
    } else merged.push({ start: a, end: b, strength: p.strength, peaks: 1 })
  }

  // 長さを下限・上限に収める(短ければ前後に広げ、長ければ真ん中を残す)
  const sized = merged.map((c) => {
    let { start, end } = c
    if (end - start < minSec) {
      const pad = (minSec - (end - start)) / 2
      start = clamp(start - pad)
      end = clamp(start + minSec)
      start = clamp(end - minSec)
    }
    if (end - start > maxSec) {
      const mid = (start + end) / 2
      start = mid - maxSec / 2
      end = mid + maxSec / 2
    }
    // 長さを直して端が動いたときだけ、新しい端を発話の切れ目へ(動いていない端は広げ直さない。
    // 広げた先からさらに広げると、続く掛け合いで区間が伸び続ける)
    const a = start !== c.start ? widen(start, start)[0] : start
    const b = end !== c.end ? widen(end, end)[1] : end
    return { ...c, start: a, end: Math.min(b, a + maxSec + 3) }
  })

  const chosen: ShortCandidate[] = []
  for (const c of [...sized].sort((x, y) => y.strength - x.strength)) {
    if (chosen.length >= count) break
    if (chosen.some((x) => c.start < x.end && c.end > x.start)) continue
    chosen.push(c)
  }
  return chosen
}

import { describe, expect, it } from 'vitest'
import { createExportTimeMap, exportToTimelineTime } from '@shared/exportTimeline'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

/** 5秒2本を 1.0秒のつなぎでつないだ企画。書き出しの並びは [0,5] と [4,9]、総尺 9。 */
const oneSecondTransition = (): ReturnType<typeof createExportTimeMap> =>
  createExportTimeMap([0, 5], [5, 5], [0, 4])

describe('createExportTimeMap — タイムライン秒 → 書き出し秒', () => {
  it('つなぎが無ければ恒等', () => {
    const { toExportTime, toExportEndTime } = createExportTimeMap([0, 5], [5, 5], [0, 5])
    for (const t of [0, 1, 4.999, 5, 7, 10]) expect(toExportTime(t)).toBe(t)
    expect(toExportEndTime(2, 6)).toBe(6)
  })

  it('つなぎをまたぐと、境目で**巻き戻る**(単調でない)', () => {
    const { toExportTime } = oneSecondTransition()
    expect(round(toExportTime(4.99))).toBe(4.99)
    expect(round(toExportTime(5))).toBe(4) // 2本目の書き出し開始へ飛ぶ
  })

  it('区間の終わりは**始まりが属する1本の中で**測る', () => {
    const { toExportTime, toExportEndTime } = oneSecondTransition()
    // [2, 6] は1本目から始まる。終わりは1本目の終わり(書き出し 5.0)で頭打ち。
    expect(toExportTime(2)).toBe(2)
    expect(toExportEndTime(2, 6)).toBe(5)
    // 2本目の中だけに収まる [6, 9] は 2本目で測る。
    expect(toExportTime(6)).toBe(5)
    expect(toExportEndTime(6, 9)).toBe(8)
  })

  it('境目ちょうどで終わる区間は詰められない', () => {
    const { toExportEndTime } = oneSecondTransition()
    // [1, 5] は1本目に収まる。1本目の終わりは書き出し 5.0 なので尺 4.0 のまま。
    expect(toExportEndTime(1, 5)).toBe(5)
  })

  it('【不変条件】終わりは必ず始まり以上(負の尺を作らない)', () => {
    const rnd = seeded(777)
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(rnd() * 5)
      const durs = Array.from({ length: n }, () => 0.2 + rnd() * 6)
      const starts: number[] = []
      let acc = 0
      for (const d of durs) {
        starts.push(acc)
        acc += d
      }
      const exportStarts: number[] = []
      let eacc = 0
      for (let k = 0; k < n; k++) {
        exportStarts.push(eacc)
        eacc += durs[k] - (k + 1 < n ? Math.min(rnd() * 0.9, durs[k] * 0.5) : 0)
      }
      const { toExportTime, toExportEndTime } = createExportTimeMap(starts, durs, exportStarts)
      const a = rnd() * acc
      const b = a + rnd() * acc
      const s = toExportTime(a)
      const e = toExportEndTime(a, b)
      expect(Number.isFinite(s), `start ${a}`).toBe(true)
      expect(Number.isFinite(e), `end ${a}..${b}`).toBe(true)
      expect(e).toBeGreaterThanOrEqual(s - 1e-9)
    }
  })

  it('異常な入力でも落ちず、有限を返す', () => {
    const { toExportTime, toExportEndTime } = oneSecondTransition()
    for (const t of NASTY_NUMBERS) {
      expect(() => toExportTime(t)).not.toThrow()
      expect(() => toExportEndTime(t, t)).not.toThrow()
    }
  })

  it('クリップが1本も無い企画', () => {
    const { toExportTime, toExportEndTime } = createExportTimeMap([], [], [])
    expect(Number.isFinite(toExportTime(3))).toBe(true)
    expect(toExportEndTime(1, 3)).toBeGreaterThanOrEqual(toExportTime(1))
  })
})

describe('【レグレッション】繋ぎをまたぐ PiP は絵も音も同じ秒で終わる', () => {
  /**
   * 2026-09-08 のバグ狩り。絵は `enable` の窓を詰めた終わりで閉じていたのに、
   * 音の枝には切る処理が無く、**絵が消えたあとも 0.967秒 鳴り続けていた**。
   * 書き出しの式(`min(toExportEndTime(...), totalDuration)`)をここで固定する。
   */
  const pipEnd = (clipStart: number, dur: number, total: number): number => {
    const { toExportTime, toExportEndTime } = oneSecondTransition()
    const pipStart = toExportTime(clipStart)
    const visible = Math.min(dur, total - pipStart)
    const end = Math.min(toExportEndTime(clipStart, clipStart + dur), total)
    return Math.max(0, Math.min(visible, end - pipStart))
  }

  it('タイムライン [2.0, 6.0] の PiP は、繋ぎのぶん詰められて 3.0秒', () => {
    expect(pipEnd(2, 4, 9)).toBe(3)
  })

  it('繋ぎをまたがない PiP は詰められない', () => {
    expect(pipEnd(0.5, 3, 9)).toBe(3)
    expect(pipEnd(6, 3, 9)).toBe(3)
  })

  it('本編をはみ出すぶんは総尺で頭打ち', () => {
    expect(pipEnd(7, 5, 9)).toBe(3)
  })

  it('尺0・負の尺でも負を返さない', () => {
    expect(pipEnd(2, 0, 9)).toBe(0)
    expect(pipEnd(2, -3, 9)).toBe(0)
  })
})

describe('exportToTimelineTime — ファイルの秒からタイムラインの秒へ', () => {
  it('4秒+4秒に1秒のクロスフェード: ファイルの 3.9 秒は2本目の 0.9 秒(タイムラインの 4.9 秒)', () => {
    expect(exportToTimelineTime(3.9, [0, 4], [0, 3])).toBeCloseTo(4.9, 9)
    expect(exportToTimelineTime(2, [0, 4], [0, 3])).toBeCloseTo(2, 9)
    expect(exportToTimelineTime(7, [0, 4], [0, 3])).toBeCloseTo(8, 9)
  })
})

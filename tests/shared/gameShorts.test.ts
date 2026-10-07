import { describe, expect, it } from 'vitest'
import { pickShortWindows } from '../../src/shared/structure/shorts'

const range = { start: 0, end: 600 }
const hype = (start: number, riseDb: number): { start: number; end: number; riseDb: number } => ({
  start,
  end: start + 1.5,
  riseDb
})

describe('ショートにする区間(pickShortWindows)', () => {
  it('山の前 10 秒・後 6 秒を入れ、15 秒に満たなければ広げる。強い順に選ぶ', () => {
    const w = pickShortWindows([hype(100, 8), hype(300, 14)], [], [], range, { count: 5 })
    expect(w.map((x) => Math.round(x.start))).toEqual([290, 90])
    for (const x of w) {
      expect(x.end - x.start).toBeGreaterThanOrEqual(15 - 1e-9)
      expect(x.end - x.start).toBeLessThanOrEqual(60)
    }
  })

  it('近い山は1本にまとめ(強さを足す)、上限を超えるなら分ける。重ならないものを本数まで', () => {
    const w = pickShortWindows(
      [hype(100, 8), hype(110, 8), hype(118, 8), hype(400, 20)],
      [{ start: 500, end: 505 }],
      [],
      range,
      { count: 2, maxSec: 45 }
    )
    expect(w).toHaveLength(2)
    expect(w[0].peaks).toBe(3)
    expect(w[0].strength).toBe(24)
    expect(w[1].start).toBeGreaterThan(380)
    expect(w[0].end - w[0].start).toBeLessThanOrEqual(45 + 3)
  })

  it('端が発話の途中なら発話を丸ごと入れ、収録の外にははみ出さない', () => {
    const w = pickShortWindows([hype(5, 10)], [], [{ start: 13, end: 25 }], range, {
      minSec: 15
    })
    expect(w[0].start).toBe(0)
    expect(w[0].end).toBe(25)
  })
})

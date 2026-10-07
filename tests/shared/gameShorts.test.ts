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

describe('ショートの終わりは発話の切れ目', () => {
  it('長すぎて終わりを詰めるときも、発話の途中で切らない', () => {
    // 途切れない実況(10 秒ごとに 9.5 秒の発話)
    const lines = Array.from({ length: 60 }, (_, k) => ({ start: k * 10 + 3, end: k * 10 + 12.5 }))
    const [w] = pickShortWindows([{ start: 100, end: 180, riseDb: 10 }], [], lines, {
      start: 0,
      end: 600
    })
    expect(w.end - w.start).toBeLessThanOrEqual(63)
    expect(lines.some((l) => l.start < w.end - 1e-6 && l.end > w.end + 1e-6)).toBe(false)
    expect(lines.some((l) => l.start < w.start - 1e-6 && l.end > w.start + 1e-6)).toBe(false)
  })
})

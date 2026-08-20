import { describe, expect, it } from 'vitest'
import {
  CAPTION_LANE_MIN_HEIGHT,
  CAPTION_MIN_DRAW_PX,
  CAPTION_ROW_HEIGHT,
  assignCaptionRows,
  captionLaneHeight,
  captionRowCount,
  captionRowRect
} from '@renderer/lib/captionRows'
import { seeded } from '../helpers/boundary'

type Span = { id: string; startTime: number; endTime: number }
const rows = (o: Span[], min = 0): Record<string, number> =>
  Object.fromEntries([...assignCaptionRows(o, min)].sort((a, b) => (a[0] < b[0] ? -1 : 1)))

describe('assignCaptionRows — 重なったテロップを段に分ける', () => {
  it('1枚も無ければ空', () => {
    expect(rows([])).toEqual({})
  })

  it('重ならない2枚は同じ段', () => {
    expect(
      rows([
        { id: 'a', startTime: 0, endTime: 2 },
        { id: 'b', startTime: 3, endTime: 5 }
      ])
    ).toEqual({ a: 0, b: 0 })
  })

  it('端が触れるだけなら同じ段(画面でも重ならない)', () => {
    expect(
      rows([
        { id: 'a', startTime: 0, endTime: 5 },
        { id: 'b', startTime: 5, endTime: 9 }
      ])
    ).toEqual({ a: 0, b: 0 })
  })

  it('完全に同じ時刻の2枚は別の段', () => {
    expect(
      rows([
        { id: 'a', startTime: 1, endTime: 5 },
        { id: 'b', startTime: 1, endTime: 5 }
      ])
    ).toEqual({ a: 0, b: 1 })
  })

  it('3枚が同時なら3段', () => {
    expect(
      rows([
        { id: 'a', startTime: 1, endTime: 5 },
        { id: 'b', startTime: 2, endTime: 6 },
        { id: 'c', startTime: 3, endTime: 7 }
      ])
    ).toEqual({ a: 0, b: 1, c: 2 })
  })

  it('空いた段は上から詰め直す', () => {
    expect(
      rows([
        { id: 'a', startTime: 0, endTime: 4 },
        { id: 'b', startTime: 1, endTime: 2 },
        { id: 'c', startTime: 3, endTime: 8 },
        { id: 'd', startTime: 5, endTime: 6 }
      ])
    ).toEqual({ a: 0, b: 1, c: 1, d: 0 })
  })

  it('入力の並び順に依らない', () => {
    const a = rows([
      { id: 'b', startTime: 3, endTime: 5 },
      { id: 'a', startTime: 0, endTime: 2 }
    ])
    expect(a).toEqual({ a: 0, b: 0 })
  })

  it('描かれる最低幅を見込むと、短い1枚も隣の下に潜らない', () => {
    // 0.05秒の1枚も画面では CAPTION_MIN_DRAW_PX ぶん場所を取る
    expect(
      rows(
        [
          { id: 'sliver', startTime: 3, endTime: 3.05 },
          { id: 'big', startTime: 3.1, endTime: 9 }
        ],
        0.35
      )
    ).toEqual({ big: 1, sliver: 0 })
  })

  it('境界値: 尺0・逆転・負・NaN・Infinity でも落ちない', () => {
    expect(
      rows([
        { id: 'a', startTime: 2, endTime: 2 },
        { id: 'b', startTime: 2, endTime: 2 }
      ])
    ).toEqual({ a: 0, b: 0 })
    expect(
      rows(
        [
          { id: 'a', startTime: 2, endTime: 2 },
          { id: 'b', startTime: 2, endTime: 2 }
        ],
        0.35
      )
    ).toEqual({ a: 0, b: 1 })
    expect(
      rows([
        { id: 'a', startTime: 5, endTime: 1 },
        { id: 'b', startTime: 5, endTime: 6 }
      ])
    ).toEqual({ a: 0, b: 0 })
    expect(
      rows([
        { id: 'a', startTime: NaN, endTime: NaN },
        { id: 'b', startTime: 0, endTime: 1 }
      ])
    ).toEqual({ a: 0, b: 0 })
    expect(
      rows([
        { id: 'a', startTime: 0, endTime: Infinity },
        { id: 'b', startTime: 10, endTime: 11 }
      ])
    ).toEqual({ a: 0, b: 0 })
    expect(
      rows([
        { id: 'a', startTime: -Infinity, endTime: 5 },
        { id: 'b', startTime: 1, endTime: 2 }
      ])
    ).toEqual({ a: 0, b: 1 })
  })

  it('最低幅が NaN・Infinity・負でも 0 扱いにする', () => {
    const two: Span[] = [
      { id: 'a', startTime: 0, endTime: 1 },
      { id: 'b', startTime: 1, endTime: 2 }
    ]
    for (const bad of [NaN, Infinity, -5]) {
      expect(rows(two, bad), String(bad)).toEqual({ a: 0, b: 0 })
    }
  })

  it('【不変条件】同じ段に置かれた2枚は、描かれた幅でも重ならない', () => {
    const rnd = seeded(13579)
    const MIN_SEC = CAPTION_MIN_DRAW_PX / 40
    for (let round_ = 0; round_ < 40; round_++) {
      const many: Span[] = Array.from({ length: 200 }, (_, i) => {
        const s = rnd() * 60
        return { id: 'x' + i, startTime: s, endTime: s + rnd() * 4 }
      })
      const assigned = assignCaptionRows(many, MIN_SEC)
      expect(assigned.size).toBe(many.length)
      for (let i = 0; i < many.length; i++) {
        for (let j = i + 1; j < many.length; j++) {
          const a = many[i]
          const b = many[j]
          const ae = Math.max(a.endTime, a.startTime + MIN_SEC)
          const be = Math.max(b.endTime, b.startTime + MIN_SEC)
          const overlap = a.startTime < be && b.startTime < ae
          if (overlap) expect(assigned.get(a.id)).not.toBe(assigned.get(b.id))
        }
      }
    }
  })
})

describe('レーンと段の寸法', () => {
  it('段の数', () => {
    expect(captionRowCount(new Map())).toBe(1)
    expect(captionRowCount(new Map([['a', 0]]))).toBe(1)
    expect(
      captionRowCount(
        new Map([
          ['a', 0],
          ['b', 2]
        ])
      )
    ).toBe(3)
  })

  it('1段のときのレーンの高さは他のレーンと同じ', () => {
    expect(captionLaneHeight(1)).toBe(CAPTION_LANE_MIN_HEIGHT)
    expect(captionLaneHeight(0)).toBe(CAPTION_LANE_MIN_HEIGHT)
  })

  it('2段以上は段の数ぶん伸びる', () => {
    expect(captionLaneHeight(2)).toBe(2 * CAPTION_ROW_HEIGHT)
    expect(captionLaneHeight(3)).toBe(3 * CAPTION_ROW_HEIGHT)
  })

  it('1段のときの見た目は段分け前と同じ(top 2 / 高さ 40)', () => {
    expect(captionRowRect(0, 1)).toEqual({ top: 2, height: 40 })
  })

  it('多段のときは段ごとにずれる', () => {
    expect(captionRowRect(0, 2)).toEqual({ top: 2, height: 18 })
    expect(captionRowRect(1, 2)).toEqual({ top: 24, height: 18 })
    expect(captionRowRect(2, 3)).toEqual({ top: 46, height: 18 })
  })

  it('負・NaN の段は先頭に倒す', () => {
    expect(captionRowRect(-1, 2)).toEqual({ top: 2, height: 18 })
    expect(captionRowRect(NaN, 2)).toEqual({ top: 2, height: 18 })
  })

  it('【不変条件】最後の段は必ずレーンの中に収まる', () => {
    for (let n = 1; n <= 20; n++) {
      const last = captionRowRect(n - 1, n)
      expect(last.top + last.height + 2, `段=${n}`).toBeLessThanOrEqual(captionLaneHeight(n))
      expect(last.height).toBeGreaterThan(0)
    }
  })
})

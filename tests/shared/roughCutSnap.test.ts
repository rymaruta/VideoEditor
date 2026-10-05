import { describe, expect, it } from 'vitest'
import { mixLevelDb, snapCutsToQuiet } from '../../src/shared/roughCut/snap'

/** 100Hz の大きさ(dB)。既定は -56dB(ピンマイクの静かな所)、`loud` の区間(秒)だけ大きい */
function level(sec: number, loud: [number, number, number][]): Float32Array {
  const out = new Float32Array(Math.round(sec * 100)).fill(-56)
  for (const [a, b, db] of loud)
    for (let k = Math.round(a * 100); k < Math.round(b * 100); k++) out[k] = db
  return out
}

describe('snapCutsToQuiet — カット点を近くの静かな所へ寄せる', () => {
  it('静かな所で切っているなら動かさない', () => {
    const lv = level(20, [
      [1, 4, -15],
      [8, 12, -15]
    ])
    const pieces = [
      { start: 0.85, end: 4.15 },
      { start: 7.85, end: 12.15 }
    ]
    expect(snapCutsToQuiet(pieces, lv)).toEqual(pieces)
  })

  it('語尾の短い音(60ms)の真ん中で切っていたら、その音を丸ごと残す側へ寄せる', () => {
    // 4.0 秒で話し終わり、4.20〜4.26 秒に短い音(無声の「す」・息)。間を詰めたカットは 4.23 秒で切っていた
    const lv = level(20, [
      [1, 4, -15],
      [4.2, 4.26, -14],
      [8, 12, -15]
    ])
    const [a, b] = snapCutsToQuiet(
      [
        { start: 0.85, end: 4.23 },
        { start: 7.85, end: 12.15 }
      ],
      lv
    )
    expect(a.end).toBeGreaterThanOrEqual(4.26)
    expect(a.end).toBeLessThan(4.3)
    // 切る位置は静かな所
    expect(lv[Math.floor(a.end * 100)]).toBeLessThanOrEqual(-50)
    expect(b).toEqual({ start: 7.85, end: 12.15 })
  })

  it('頭は前へ(言葉の頭を削らない向き)を先に探す', () => {
    const lv = level(20, [
      [5.0, 5.05, -20],
      [5.3, 9, -15]
    ])
    const [, b] = snapCutsToQuiet(
      [
        { start: 0, end: 2 },
        { start: 5.02, end: 9.15 }
      ],
      lv
    )
    expect(b.start).toBeLessThan(5.0)
    expect(b.start).toBeGreaterThan(4.9)
  })

  it('広げる側が鳴り続けていれば、狭める側の静かな所へ', () => {
    // 終わりの後ろは 0.12 秒より長く鳴っている(次の区間との間の物音)。前は 3.95 秒から静か
    const lv = level(20, [
      [1, 3.95, -15],
      [4.0, 4.5, -25]
    ])
    const [a] = snapCutsToQuiet([{ start: 0.85, end: 4.02 }], lv)
    expect(a.end).toBeGreaterThanOrEqual(3.95)
    expect(a.end).toBeLessThan(4.0)
  })

  it('時間の続いている区間の境目(場面の境目)は動かさない', () => {
    const lv = level(20, [[1, 9, -15]])
    const pieces = [
      { start: 0.85, end: 5 },
      { start: 5, end: 9.15 }
    ]
    expect(snapCutsToQuiet(pieces, lv)).toEqual(pieces)
  })

  it('寄せても前後の区間と重ならない', () => {
    const lv = level(20, [
      [1, 4.05, -15],
      [4.1, 4.2, -30],
      [4.25, 9, -15]
    ])
    const out = snapCutsToQuiet(
      [
        { start: 0.85, end: 4.08 },
        { start: 4.17, end: 9.15 }
      ],
      lv
    )
    expect(out[0].end).toBeLessThan(out[1].start)
  })
})

describe('mixLevelDb', () => {
  it('マイクの音を足した大きさ(dB)。どのマイクも録っていない所は NaN', () => {
    const a = new Float32Array([0.1, 0.1, NaN])
    const b = new Float32Array([0, 0.1, NaN])
    const db = mixLevelDb([
      { id: 'a', envelope: a },
      { id: 'b', envelope: b }
    ])
    expect(db[0]).toBeCloseTo(-20, 3)
    expect(db[1]).toBeCloseTo(-20 + 10 * Math.log10(2), 3)
    expect(Number.isNaN(db[2])).toBe(true)
  })
})

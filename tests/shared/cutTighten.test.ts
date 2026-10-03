import { describe, expect, it } from 'vitest'
import { tightenRanges, totalLength } from '../../src/shared/cut/tighten'
import { TURN_RATE } from '../../src/shared/diarize/micTurns'

/** 秒の区間のリストから 100Hz の鳴っている/いないを作る */
function mask(seconds: number, on: [number, number][]): Uint8Array {
  const m = new Uint8Array(seconds * TURN_RATE)
  for (const [a, b] of on) m.fill(1, Math.round(a * TURN_RATE), Math.round(b * TURN_RATE))
  return m
}

describe('tightenRanges', () => {
  // 2〜5 秒発話、5〜8 秒無音、8〜9 秒笑い(音はあるが文字起こしは無い)、9.3〜12 秒発話
  const activity = mask(20, [
    [2, 5],
    [8, 9],
    [9.3, 12]
  ])
  const speech = [
    { start: 2, end: 5 },
    { start: 9.3, end: 12 }
  ]

  it('長い無音は 0.3 秒まで詰め、短い間(0.3 秒)と笑いは残す', () => {
    const r = tightenRanges([{ start: 0, end: 15, sceneId: 's1' }], activity, speech)
    expect(r).toEqual([
      { start: 1.85, end: 5.15, sceneId: 's1' },
      { start: 7.85, end: 12.15, sceneId: 's1' }
    ])
    expect(totalLength(r)).toBeCloseTo(7.6, 9)
  })

  it('発話の区間の中は、音が途切れていても切らない', () => {
    // 発話 2〜9 秒の途中 4〜7 秒は音が無い(ささやき・聞き取れない部分)
    const r = tightenRanges(
      [{ start: 0, end: 10 }],
      mask(10, [
        [2, 4],
        [7, 9]
      ]),
      [{ start: 2, end: 9 }]
    )
    expect(r).toHaveLength(1)
    expect(r[0].start).toBeCloseTo(1.85, 9)
    expect(r[0].end).toBeCloseTo(9.15, 9)
  })

  it('音の無い場面は何も残さない', () => {
    expect(tightenRanges([{ start: 13, end: 19 }], activity, speech)).toEqual([])
  })
})

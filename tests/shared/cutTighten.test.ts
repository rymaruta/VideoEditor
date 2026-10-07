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
    const r = tightenRanges([{ start: 0, end: 15, sceneId: 's1' }], activity, speech, {
      insertMinSec: Infinity
    })
    expect(r).toEqual([
      { start: 1.85, end: 5.15, sceneId: 's1' },
      { start: 7.85, end: 12.15, sceneId: 's1' }
    ])
    expect(totalLength(r)).toBeCloseTo(7.6, 9)
  })

  it('2.5 秒以上の無音は、頭の数秒を絵として残す(食べる・料理の寄り)', () => {
    // 3 秒の無音: 1.5 + 0.25 × 0.5 = 1.625 秒を残し、残りは詰める
    const r = tightenRanges([{ start: 0, end: 15, sceneId: 's1' }], activity, speech)
    expect(r).toHaveLength(2)
    expect(r[0].start).toBeCloseTo(1.85, 9)
    expect(r[0].end).toBeCloseTo(6.63, 9)
    expect(r[1].start).toBeCloseTo(7.85, 9)
  })

  it('場面の境目にある長い無音(料理の寄りなど)も、前の場面の話し終わりから絵として残す', () => {
    // 1〜3 秒に話して 17 秒の無音、20〜22 秒にまた話す。場面は無音の所で3つに分かれている
    const act = mask(30, [
      [1, 3],
      [20, 22]
    ])
    const sp = [
      { start: 1, end: 3 },
      { start: 20, end: 22 }
    ]
    const r = tightenRanges(
      [
        { start: 0, end: 3.5, sceneId: 's1' },
        { start: 3.5, end: 19.5, sceneId: 's2' },
        { start: 19.5, end: 30, sceneId: 's3' }
      ],
      act,
      sp
    )
    expect(r).toHaveLength(2)
    expect(r[0].sceneId).toBe('s1')
    expect(r[0].end).toBeCloseTo(8, 9)
    expect(r[1].start).toBeCloseTo(19.85, 9)
    // 収録の終わりまで続く無音も、頭の数秒(8 秒の無音 → 1.5 + 0.25 × 5.5 = 2.875 秒、100Hz に丸めて 2.88)
    expect(r[1].end).toBeCloseTo(24.88, 9)
  })

  it('長い無音ほど少し長く残し、最長 5 秒で止める。2 秒の無音はふつうに詰める', () => {
    const run = (gap: number): number => {
      const end = 3 + gap + 2
      const r = tightenRanges(
        [{ start: 0, end }],
        mask(Math.ceil(end) + 1, [
          [1, 3],
          [3 + gap, end]
        ]),
        [
          { start: 1, end: 3 },
          { start: 3 + gap, end }
        ]
      )
      return r[0].end - 3
    }
    expect(run(2)).toBeCloseTo(0.15, 9)
    expect(run(17)).toBeCloseTo(5, 9)
    expect(run(8)).toBeGreaterThan(run(4))
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

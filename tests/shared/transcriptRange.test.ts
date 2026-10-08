import { describe, expect, it } from 'vitest'

describe('fitSegmentsToRange — 区間を指定した文字起こしを区間に収める', () => {
  it('無音・雑音の作り話は捨て、区間より後ろの言葉は捨てて時刻を区間に収める', async () => {
    const { fitSegmentsToRange } = await import('../../src/shared/transcript')
    expect(
      fitSegmentsToRange([{ start: 23.4, end: 27.6, text: 'ご視聴ありがとうございました' }], 0, 5)
    ).toEqual([])
    const out = fitSegmentsToRange(
      [
        {
          start: 3,
          end: 7,
          text: 'こんにちは世界',
          words: [
            { start: 3, end: 4.5, text: 'こんにちは' },
            { start: 4.8, end: 6, text: '世界' },
            { start: 6, end: 7, text: 'です' }
          ]
        }
      ],
      0,
      5
    )
    expect(out).toHaveLength(1)
    expect(out[0].words?.map((w) => [w.start, w.end])).toEqual([
      [3, 4.5],
      [4.8, 5]
    ])
    expect(out[0].end).toBe(5)
  })
})

import { describe, expect, it } from 'vitest'
import { audibleClipDuration, fadeGainAt } from '@shared/audioFade'

/** プレビューの BGM のフェードアウトは、書き出しと同じく本編の終わりに掛かる */
describe('本編の終わりより先へ続く BGM', () => {
  it('本編 10 秒・BGM 20 秒・フェードアウト 3 秒: 9.5 秒で書き出しと同じく約 0.17', () => {
    const dur = audibleClipDuration(0, 20, 10)
    expect(dur).toBe(10)
    expect(fadeGainAt(9.5, dur, 0, 3)).toBeCloseTo(0.5 / 3, 6)
    expect(fadeGainAt(7.5, dur, 0, 3)).toBeCloseTo(2.5 / 3, 6)
  })
  it('本編が無い・本編より後に始まる音は切らない', () => {
    expect(audibleClipDuration(0, 20, 0)).toBe(20)
    expect(audibleClipDuration(12, 5, 10)).toBe(5)
  })
})

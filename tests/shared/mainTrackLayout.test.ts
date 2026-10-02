import { describe, expect, it } from 'vitest'
import { computeMainTrackLayout, type MainTrackClipInput } from '@shared/mainTrackLayout'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

const clip = (dur: number, extra: Partial<MainTrackClipInput> = {}): MainTrackClipInput => ({
  inPoint: 0,
  outPoint: dur,
  ...extra
})

describe('computeMainTrackLayout — 本編の書き出し位置', () => {
  it('繋ぎが無ければ前から詰めて並ぶ', () => {
    const l = computeMainTrackLayout([clip(2), clip(3), clip(1)], 30)
    expect(l.exportStarts).toEqual([0, 2, 5])
    expect(l.timelineStarts).toEqual([0, 2, 5])
    expect(l.totalExportDuration).toBe(6)
    expect(l.transitionSeconds).toEqual([0, 0, 0])
  })

  it('5秒2本に1秒のクロスフェード: 2本目は書き出しの4秒から、総尺9秒', () => {
    const l = computeMainTrackLayout(
      [clip(5), clip(5, { transitionIn: { type: 'crossfade', duration: 1 } })],
      30
    )
    expect(l.transitionSeconds).toEqual([0, 1])
    expect(l.exportStarts).toEqual([0, 4])
    expect(l.timelineStarts).toEqual([0, 5])
    expect(l.totalExportDuration).toBe(9)
  })

  it('速度を変えたクリップはタイムライン上の尺で数える', () => {
    const l = computeMainTrackLayout([clip(4, { speed: 2 }), clip(1, { speed: 0.5 })], 30)
    expect(l.timelineDurations).toEqual([2, 2])
    expect(l.totalExportDuration).toBe(4)
  })

  it('【レグレッション】尺はフレームに丸めるので、2.345秒×10本は 700フレームちょうど', () => {
    // 書き出し側のコメントの実測(映像 23.334秒=700フレーム)と同じ数
    const l = computeMainTrackLayout(
      Array.from({ length: 10 }, () => clip(2.345)),
      30
    )
    expect(round(l.totalExportDuration * 30)).toBe(700)
    // 位置もフレームの整数倍に乗る
    for (const s of l.exportStarts) expect(Number.isInteger(round(s * 30))).toBe(true)
  })

  it('空なら全部空・尺0', () => {
    const l = computeMainTrackLayout([], 30)
    expect(l.exportStarts).toEqual([])
    expect(l.totalExportDuration).toBe(0)
  })

  it('壊れた尺・速度が来ても落ちず、尺は有限', () => {
    for (const v of NASTY_NUMBERS) {
      const l = computeMainTrackLayout([clip(3), { inPoint: 0, outPoint: v, speed: v }], 30)
      expect(Number.isNaN(l.totalExportDuration)).toBe(false)
    }
  })

  it('【不変条件】総尺は最後のクリップの終わり、次の始まりは手前の終わりから繋ぎぶん戻った位置', () => {
    const rnd = seeded(4242)
    for (let n = 0; n < 2000; n++) {
      const count = 1 + Math.floor(rnd() * 8)
      const clips = Array.from({ length: count }, () =>
        clip(0.05 + rnd() * 6, {
          speed: rnd() < 0.3 ? 0.5 + rnd() * 1.5 : undefined,
          transitionIn: rnd() < 0.5 ? { type: 'crossfade', duration: rnd() * 2 } : undefined
        })
      )
      const l = computeMainTrackLayout(clips, 30)
      const last = count - 1
      expect(round(l.totalExportDuration)).toBe(
        round(l.exportStarts[last] + l.exportDurations[last])
      )
      for (let i = 0; i < count; i++) {
        expect(l.exportStarts[i]).toBeGreaterThanOrEqual(0)
        if (i > 0) {
          // 次の始まりは、手前の終わりから繋ぎの秒数だけ戻った位置
          const prevEnd = l.exportStarts[i - 1] + l.exportDurations[i - 1]
          expect(round(l.exportStarts[i])).toBe(
            round(Math.max(0, prevEnd - l.transitionSeconds[i]))
          )
        }
      }
    }
  })
})

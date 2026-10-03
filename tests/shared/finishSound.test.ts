import { describe, expect, it } from 'vitest'
import {
  normalizeCategory,
  planBgm,
  planSoundEffects,
  timelineRangeOf,
  type ShowKit
} from '../../src/shared/finish/sound'

const kit: ShowKit = {
  se: {
    ツッコミ: [
      { path: '/se/t1.wav', name: 't1.wav', duration: 0.8 },
      { path: '/se/t2.wav', name: 't2.wav', duration: 0.6 }
    ],
    場面転換: [{ path: '/se/w.wav', name: 'w.wav', duration: 1.2 }]
  },
  bgm: {
    楽しい: [{ path: '/bgm/fun.mp3', name: 'fun.mp3', duration: 40 }],
    穏やか: [{ path: '/bgm/calm.mp3', name: 'calm.mp3', duration: 100 }]
  },
  cg: {}
}

describe('normalizeCategory', () => {
  it('言い換えのフォルダ名を分類に揃える', () => {
    expect(normalizeCategory('Tsukkomi')).toBe('ツッコミ')
    expect(normalizeCategory(' calm ')).toBe('穏やか')
    expect(normalizeCategory('状況説明')).toBe('状況')
    expect(normalizeCategory('独自の分類')).toBe('独自の分類')
  })
})

describe('planSoundEffects', () => {
  it('演出テロップの出だしに種類の SE、場面の頭に場面転換。同じ分類は順番に使う', () => {
    const r = planSoundEffects(
      [
        { time: 3, kind: 'tsukkomi', text: 'いや早すぎ!' },
        { time: 10, kind: 'tsukkomi', text: 'なんでやねん' },
        { time: 14, kind: 'kokoro', text: '(帰りたい)' }
      ],
      [0, 20],
      kit
    )
    expect(r.map((x) => [x.startTime, x.path])).toEqual([
      [3, '/se/t1.wav'],
      [10, '/se/t2.wav'],
      // 心の声の SE は無いので置かない。最初の場面の頭(0秒)にも置かない
      [20, '/se/w.wav']
    ])
    expect(r[0].outPoint).toBe(0.8)
  })

  it('近すぎる SE(0.6秒以内)は重ねない', () => {
    const r = planSoundEffects(
      [
        { time: 5, kind: 'tsukkomi', text: 'a' },
        { time: 5.3, kind: 'tsukkomi', text: 'b' }
      ],
      [5.1],
      kit
    )
    expect(r).toHaveLength(1)
  })
})

describe('planBgm', () => {
  it('同じ雰囲気の場面は1曲で通し、曲が短ければ重ねながら繰り返す。雰囲気が変われば曲を替える', () => {
    const r = planBgm(
      [
        { start: 0, end: 50, mood: '楽しい' },
        { start: 50, end: 70, mood: '楽しい' },
        { start: 70, end: 100, mood: '穏やか' }
      ],
      kit
    )
    // 繰り返しの継ぎ目は 1.5 秒重ねる(クロスフェード)。場面の終わりちょうどで止める
    expect(r.map((x) => [x.path, x.startTime, x.outPoint])).toEqual([
      ['/bgm/fun.mp3', 0, 40],
      ['/bgm/fun.mp3', 38.5, 31.5],
      ['/bgm/calm.mp3', 70, 30]
    ])
    expect([r[0].fadeOut, r[1].fadeIn]).toEqual([1.5, 1.5])
    expect(r.every((x) => (x.fadeIn ?? 0) > 0 && (x.fadeOut ?? 0) > 0)).toBe(true)
  })

  it('その雰囲気の曲が無ければ置かない', () => {
    expect(planBgm([{ start: 0, end: 30, mood: '緊張' }], kit)).toEqual([])
  })
})

describe('timelineRangeOf', () => {
  it('共通の時刻の区間を、詰めたあとのタイムラインの区間にする', () => {
    const spans = [
      { timeline: 0, start: 100, end: 110 },
      { timeline: 10, start: 120, end: 130 }
    ]
    expect(timelineRangeOf(spans, 105, 125)).toEqual({ start: 5, end: 15 })
    expect(timelineRangeOf(spans, 111, 119)).toBeNull()
  })
})

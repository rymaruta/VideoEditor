import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '@shared/textStyle'
import { planTelopRuns, telopConcatList, telopItemSource } from '@shared/telop/layer'
import type { Sequence, TelopItem } from '@shared/sequence/types'
import type { TextStyle } from '@shared/types'

const telop = (
  id: string,
  startFrame: number,
  durationFrames: number,
  style: Partial<TextStyle> = {}
): TelopItem => ({
  kind: 'telop',
  id,
  startFrame,
  durationFrames,
  origin: 'auto',
  text: 'テロップ',
  style: defaultTextStyle(style)
})

const seq = (tracks: TelopItem[][], hidden: boolean[] = []): Sequence => ({
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  videoTracks: tracks.map((items, i) => ({
    id: `t${i}`,
    name: 'T',
    hidden: hidden[i] ?? false,
    items
  })),
  audioTracks: []
})

describe('planTelopRuns — 絵が変わる区間だけを並べる', () => {
  it('動かないテロップは出ている間ずっと1区間', () => {
    expect(planTelopRuns(seq([[telop('a', 30, 60)]]), 1080)).toEqual([
      { startFrame: 30, endFrame: 90, imageKey: expect.any(String), itemIds: ['a'] }
    ])
  })

  it('ポップ(200ms=6フレーム)は登場の間だけ1フレームずつ、そのあと1区間', () => {
    const runs = planTelopRuns(seq([[telop('a', 0, 60, { animation: 'popIn' })]]), 1080)
    expect(runs.slice(0, 6).every((r) => r.endFrame - r.startFrame === 1)).toBe(true)
    expect(runs.at(-1)).toMatchObject({ startFrame: 6, endFrame: 60 })
    expect(runs).toHaveLength(7)
  })

  it('重なると両方を下のトラックから順に描く区間になり、隙間は区間を作らない', () => {
    const runs = planTelopRuns(
      seq([[telop('a', 0, 30), telop('c', 100, 10)], [telop('b', 20, 30)]]),
      1080
    )
    expect(runs.map((r) => [r.startFrame, r.endFrame, r.itemIds])).toEqual([
      [0, 20, ['a']],
      [20, 30, ['a', 'b']],
      [30, 50, ['b']],
      [100, 110, ['c']]
    ])
  })

  it('非表示のトラックは描かない', () => {
    expect(planTelopRuns(seq([[telop('a', 0, 10)]], [true]), 1080)).toEqual([])
  })

  it('カラオケは語が切り替わる瞬間だけ区切る', () => {
    const t: TelopItem = {
      ...telop('k', 0, 90, { wordHighlight: true }),
      text: 'あいう',
      words: [
        { text: 'あ', start: 0, end: 1 },
        { text: 'い', start: 1, end: 2 },
        { text: 'う', start: 2, end: 3 }
      ]
    }
    expect(planTelopRuns(seq([[t]]), 1080).map((r) => [r.startFrame, r.endFrame])).toEqual([
      [0, 30],
      [30, 60],
      [60, 90]
    ])
  })

  it('1時間・テロップ1,200本でも1秒以内に組める', () => {
    const items = Array.from({ length: 1200 }, (_, i) =>
      telop(`t${i}`, i * 90, 75, { animation: i % 3 === 0 ? 'popIn' : 'none' })
    )
    const t0 = performance.now()
    const runs = planTelopRuns(seq([items]), 1080)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(runs.length).toBe(400 * 7 + 800)
  })

  it('telopItemSource: 単語の時刻をシーケンスの絶対秒へ戻す', () => {
    const t = { ...telop('a', 60, 30), words: [{ text: 'あ', start: 0.5, end: 1 }] }
    expect(telopItemSource(t, 30)).toMatchObject({
      startTime: 2,
      endTime: 3,
      words: [{ start: 2.5, end: 3 }]
    })
  })
})

describe('telopConcatList — 区間ぶんの画像の一覧', () => {
  const runs = [
    { startFrame: 30, endFrame: 60, image: 1 },
    { startFrame: 60, endFrame: 66, image: 2 },
    { startFrame: 200, endFrame: 260, image: 1 }
  ]
  const paths = ['/w/0.png', '/w/1.png', "/w/it's.png"]
  const fps = { num: 30, den: 1 }

  it('隙間は透明(0番)で埋め、区間の長さちょうどにする。最後の1枚はもう一度並べる', () => {
    expect(telopConcatList(runs, paths, 0, 90, fps)).toBe(
      [
        'ffconcat version 1.0',
        "file '/w/0.png'",
        'option framerate 30/1',
        'duration 1.000000000',
        "file '/w/1.png'",
        'option framerate 30/1',
        'duration 1.000000000',
        "file '/w/it'\\''s.png'",
        'option framerate 30/1',
        'duration 0.200000000',
        "file '/w/0.png'",
        'option framerate 30/1',
        'duration 0.800000000',
        "file '/w/0.png'",
        'option framerate 30/1'
      ].join('\n') + '\n'
    )
  })

  it('区間の途中から始まる・途中で終わるテロップは区間の中だけを並べる', () => {
    const list = telopConcatList(runs, paths, 220, 240, fps)!
    expect(list.split('\n').filter((l) => l.startsWith('duration'))).toEqual([
      'duration 0.666666667'
    ])
  })

  it('テロップの無い区間は一覧を作らない', () => {
    expect(telopConcatList(runs, paths, 100, 200, fps)).toBeNull()
  })

  it('29.97fps でも秒の合計は区間の長さに一致する(誤差は 1e-6 秒未満)', () => {
    const list = telopConcatList(runs, paths, 0, 300, { num: 30000, den: 1001 })!
    const sum = list
      .split('\n')
      .filter((l) => l.startsWith('duration'))
      .reduce((s, l) => s + Number(l.slice(9)), 0)
    expect(Math.abs(sum - (300 * 1001) / 30000)).toBeLessThan(1e-6)
  })
})

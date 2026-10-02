import { describe, expect, it } from 'vitest'
import {
  defaultSegmentOptions,
  planSegments,
  sequenceDurationFrames,
  type SegmentPlanOptions
} from '@shared/sequence/segmentPlan'
import type { MediaItem, Sequence } from '@shared/sequence/types'
import { seeded } from '../helpers/boundary'

const media = (
  id: string,
  startFrame: number,
  durationFrames: number,
  transition = 0
): MediaItem => ({
  kind: 'media',
  id,
  assetId: 'a',
  startFrame,
  durationFrames,
  sourceIn: 0,
  speed: 1,
  origin: 'manual',
  placement: { kind: 'frame', fit: 'contain' },
  ...(transition > 0 ? { transitionIn: { type: 'crossfade', durationFrames: transition } } : {})
})

const seq = (items: MediaItem[], extraTracks: MediaItem[][] = []): Sequence => ({
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  videoTracks: [items, ...extraTracks].map((t, i) => ({
    id: `v${i}`,
    name: `V${i}`,
    hidden: false,
    items: t
  })),
  audioTracks: []
})

/** 長さ `len` フレームのクリップを前から並べる(繋ぎなし) */
const back2back = (lens: number[]): MediaItem[] => {
  let at = 0
  return lens.map((len, i) => {
    const m = media(`c${i}`, at, len)
    at += len
    return m
  })
}

const OPT: SegmentPlanOptions = { targetFrames: 100, minFrames: 50, maxFrames: 200 }

describe('planSegments — 書き出しを区間に分ける', () => {
  it('空のシーケンスは区間なし', () => {
    expect(planSegments(seq([]), OPT)).toEqual([])
  })

  it('最大より短ければ1区間で、全アイテムが入る', () => {
    const s = planSegments(seq(back2back([60, 60])), OPT)
    expect(s).toEqual([{ index: 0, startFrame: 0, endFrame: 120, itemIds: ['c0', 'c1'] }])
  })

  it('目標に一番近いカット点で切る', () => {
    // カット点は 70, 140, 210, ... 目標 100 に近いのは 70(差30)と 140(差40)→ 70
    const s = planSegments(seq(back2back(Array(10).fill(70))), OPT)
    expect(s[0]).toMatchObject({ startFrame: 0, endFrame: 70 })
    expect(s.at(-1)!.endFrame).toBe(700)
  })

  it('範囲にカット点が無ければ最大の位置で切る', () => {
    const s = planSegments(seq([media('long', 0, 1000)]), OPT)
    expect(s.map((x) => [x.startFrame, x.endFrame])).toEqual([
      [0, 200],
      [200, 400],
      [400, 600],
      [600, 800],
      [800, 1000]
    ])
    // 区間をまたぐアイテムは両方の区間に入る
    for (const x of s) expect(x.itemIds).toEqual(['long'])
  })

  it('繋ぎの途中では切らない: 最大の位置が繋ぎの途中なら、繋ぎの始まりへ戻す', () => {
    // c0 [0,230) と c1 [180,1000) の繋ぎ [180,230) が、最大 200 をまたぐ。カット点 180 は範囲内
    const s = planSegments(seq([media('c0', 0, 230), media('c1', 180, 820, 50)]), OPT)
    for (const x of s.slice(1)) expect(x.startFrame <= 180 || x.startFrame >= 230).toBe(true)
    expect(s[0].endFrame).toBe(180)
  })

  it('最大より長い繋ぎは割らない: 手前(最小より短くても)で切り、繋ぎは終わりまで1区間に入れる', () => {
    // 繋ぎ [10,400) は最大(200)より長い。最大の位置 200 から繋ぎの始まり 10 へ戻して切り、
    // 次の区間は繋ぎを割れないので繋ぎの終わり 400 まで伸びる(最大を超えるのはこの場合だけ)
    const s = planSegments(seq([media('c0', 0, 400), media('c1', 10, 990, 390)]), OPT)
    expect(s.slice(0, 2).map((x) => [x.startFrame, x.endFrame])).toEqual([
      [0, 10],
      [10, 400]
    ])
  })

  it('上のトラックのカット点(テロップの出入り等)も切る位置の候補になる', () => {
    const s = planSegments(seq([media('long', 0, 1000)], [[media('t', 95, 300)]]), OPT)
    expect(s[0].endFrame).toBe(95)
  })

  it('既定の長さは 45秒前後・20〜90秒', () => {
    expect(defaultSegmentOptions(30)).toEqual({
      targetFrames: 1350,
      minFrames: 600,
      maxFrames: 2700
    })
    expect(defaultSegmentOptions(NaN)).toEqual(defaultSegmentOptions(30))
    expect(defaultSegmentOptions(-1)).toEqual(defaultSegmentOptions(30))
  })

  it('【不変条件】区間は隙間なく [0, 尺) を覆い、繋ぎの途中で切らず、itemIds は掛かるアイテムと一致', () => {
    const rnd = seeded(9001)
    for (let n = 0; n < 400; n++) {
      const items: MediaItem[] = []
      let at = 0
      const count = 1 + Math.floor(rnd() * 40)
      for (let i = 0; i < count; i++) {
        const len = 1 + Math.floor(rnd() * 400)
        const tr =
          i > 0 && rnd() < 0.3
            ? Math.min(len - 1, items[i - 1].durationFrames - 1, Math.floor(rnd() * 120))
            : 0
        const start = at - Math.max(0, tr)
        items.push(media(`c${i}`, start, len, Math.max(0, tr)))
        at = start + len
      }
      const s = seq(items)
      const total = sequenceDurationFrames(s)
      const opt = {
        targetFrames: 50 + rnd() * 300,
        minFrames: 1 + rnd() * 100,
        maxFrames: 100 + rnd() * 400
      }
      const segs = planSegments(s, opt)
      expect(segs[0].startFrame).toBe(0)
      expect(segs.at(-1)!.endFrame).toBe(total)
      segs.forEach((g, i) => {
        expect(g.index).toBe(i)
        expect(g.endFrame).toBeGreaterThan(g.startFrame)
        if (i > 0) expect(g.startFrame).toBe(segs[i - 1].endFrame)
        for (const it of items) {
          if (it.transitionIn) {
            expect(
              g.startFrame > it.startFrame &&
                g.startFrame < it.startFrame + it.transitionIn.durationFrames
            ).toBe(false)
          }
        }
        const expected = items
          .filter(
            (it) => it.startFrame < g.endFrame && it.startFrame + it.durationFrames > g.startFrame
          )
          .map((it) => it.id)
        expect(g.itemIds).toEqual(expected)
      })
    }
  })
})

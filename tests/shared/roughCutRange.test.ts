import { describe, expect, it } from 'vitest'
import {
  clampPieces,
  clipScenesToWindow,
  clipTimes,
  commonWindowOf,
  fitLength,
  intersectSegs,
  overridesWithPinned,
  overridesWithin,
  pinOverrides,
  spliceClips,
  spliceTimed,
  type RangeClip
} from '@shared/roughCut/range'
import { applyCutOverrides, type CameraSeg } from '@shared/roughCut/overrides'
import type { MulticamInfo } from '@shared/sync/multicam'

const INFO: MulticamInfo = {
  anchorSourceId: 'A',
  sources: [
    { id: 'A', name: 'A', kind: 'camera' },
    { id: 'B', name: 'B', kind: 'camera' }
  ],
  files: [
    { assetId: 'a', sourceId: 'A', start: 0, rate: 1, duration: 1000 },
    // B は 2 秒遅れて回し始めた
    { assetId: 'b', sourceId: 'B', start: 2, rate: 1, duration: 1000 }
  ]
}

let seq = 0
const clip = (assetId: string, inPoint: number, outPoint: number, speed = 1): RangeClip => ({
  id: `c${seq++}`,
  assetId,
  inPoint,
  outPoint,
  speed
})
const newId = (id: string): string => `${id}+`

/** 疑似乱数(試験を毎回同じにする) */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('commonWindowOf', () => {
  it('範囲の中の収録素材の時刻から窓を作る(カメラごとの時刻のずれも直す)', () => {
    const clips = [clip('a', 0, 10), clip('b', 10, 20), clip('a', 40, 50)]
    // タイムライン 5〜15: a の 5〜10(共通 5〜10) と b の 10〜15(共通 12〜17)
    const r = commonWindowOf(clips, INFO, { start: 5, end: 15 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.window.start).toBeCloseTo(5)
    expect(r.window.end).toBeCloseTo(17)
    expect(r.pieces).toHaveLength(2)
  })

  it('人が並べ替えた所(共通の時刻が戻る)は理由付きで断る', () => {
    const clips = [clip('a', 50, 60), clip('a', 10, 20)]
    const r = commonWindowOf(clips, INFO, { start: 0, end: 20 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('並べ替えた')
  })

  it('収録素材が無ければ断る', () => {
    const clips = [clip('title', 0, 5)]
    const r = commonWindowOf(clips, INFO, { start: 0, end: 5 })
    expect(r.ok).toBe(false)
  })

  it('速さを変えたクリップ・差し込みの画・範囲の外の同じ時刻を数える', () => {
    const clips = [clip('a', 0, 10, 2), clip('logo', 0, 3), clip('a', 10, 20), clip('a', 12, 14)]
    const r = commonWindowOf(clips, INFO, { start: 0, end: 18 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.speedChanged).toBe(1)
    expect(r.extras).toBe(1)
    expect(r.outsideOverlap).toBe(1)
  })
})

describe('spliceClips', () => {
  it('範囲に掛からないクリップは同じオブジェクト、境のクリップは外側が元の id', () => {
    const base = [clip('a', 0, 10), clip('a', 20, 30), clip('a', 40, 50), clip('a', 60, 70)]
    const rep = [clip('a', 22, 24), clip('a', 44, 47)]
    const r = spliceClips(base, rep, { start: 5, end: 25 }, newId)
    // 0〜10 は 5 で分かれ、頭が元の id
    expect(r.before).toHaveLength(1)
    expect(r.before[0].id).toBe(base[0].id)
    expect(r.before[0].outPoint).toBeCloseTo(5)
    // 20〜30 は丸ごと範囲の中、40〜50 は 25(素材 45)で分かれ、後ろが元の id
    expect(r.after[0].id).toBe(base[2].id)
    expect(r.after[0].inPoint).toBeCloseTo(45)
    expect(r.after[1]).toBe(base[3])
    expect(r.clips).toEqual([r.before[0], ...rep, ...r.after])
    // 範囲の中の切れ端は外側と別の id
    for (const c of r.inside) expect([base[0].id, base[2].id]).not.toContain(c.id)
  })

  it('両側にはみ出す1本は、前が元の id・後ろが新しい id', () => {
    const base = [clip('a', 0, 100)]
    const r = spliceClips(base, [], { start: 10, end: 20 }, newId)
    expect(r.before[0].id).toBe(base[0].id)
    expect(r.after[0].id).toBe(newId(base[0].id))
    expect(r.after[0].inPoint).toBeCloseTo(20)
  })

  it('乱択: リップルで範囲の前は完全一致、後ろは長さの変わりだけ平行移動、長さを保てば後ろも完全一致', () => {
    const rand = rng(7)
    for (let n = 0; n < 200; n++) {
      const base: RangeClip[] = []
      let src = 0
      const count = 2 + Math.floor(rand() * 10)
      for (let i = 0; i < count; i++) {
        src += rand() * 5
        const len = 0.5 + rand() * 8
        base.push(clip(rand() < 0.2 ? 'b' : 'a', src, src + len, rand() < 0.15 ? 2 : 1))
        src += len
      }
      const times = clipTimes(base)
      const total = times[times.length - 1].end
      const a = rand() * total * 0.8
      const b = a + 0.1 + rand() * (total - a - 0.1)
      const keepLength = rand() < 0.5
      const rep: RangeClip[] = []
      let want = keepLength ? b - a : rand() * 20
      while (want > 1e-9) {
        const len = Math.min(want, 0.3 + rand() * 4)
        const at = 300 + rand() * 500
        rep.push(clip('a', at, at + len))
        want -= len
      }
      const r = spliceClips(base, rep, { start: a, end: b }, newId)
      const repLen = rep.reduce((t, c) => t + (c.outPoint - c.inPoint), 0)
      const delta = repLen - (b - a)
      const t2 = clipTimes(r.clips)
      // 範囲の前: 同じオブジェクト(境で分けた頭は同じ id・同じ頭)
      base.forEach((c, i) => {
        if (times[i].end <= a + 1e-6) expect(r.clips[i]).toBe(c)
      })
      // 範囲の後ろ: 同じオブジェクトが Δ だけ後ろ(長さを保てば同じ時刻)
      base.forEach((c, i) => {
        if (times[i].start < b - 1e-6) return
        const k = r.clips.indexOf(c)
        expect(k).toBeGreaterThanOrEqual(0)
        expect(t2[k].start).toBeCloseTo(times[i].start + delta, 6)
        if (keepLength) expect(t2[k].start).toBeCloseTo(times[i].start, 6)
      })
      expect(t2[t2.length - 1].end).toBeCloseTo(total + delta, 6)
      // id は重ならない
      expect(new Set(r.clips.map((c) => c.id)).size).toBe(r.clips.length)
    }
  })
})

describe('pinOverrides', () => {
  it('窓の中を今の中身(区間とカメラ)に固定し、作り直しの区間に当てると今の中身になる', () => {
    const current: CameraSeg[] = [
      { start: 10, end: 14, cameraId: 'A' },
      { start: 16, end: 18, cameraId: 'B' },
      { start: 30, end: 40, cameraId: 'A' }
    ]
    const pin = pinOverrides([{ start: 12, end: 20 }], current)
    expect(pin.removed).toEqual([
      { start: 14, end: 16 },
      { start: 18, end: 20 }
    ])
    expect(pin.added).toEqual([
      { start: 12, end: 14 },
      { start: 16, end: 18 }
    ])
    expect(pin.angles).toEqual(intersectSegs(current, [{ start: 12, end: 20 }]))
    // 作り直しが窓の中を全部残しても、今の中身だけになる
    const pieces = applyCutOverrides([{ start: 5, end: 25, sceneId: 's' }], pin)
    expect(pieces.map((p) => [p.start, p.end])).toEqual([
      [5, 14],
      [16, 18],
      [20, 25]
    ])
  })

  it('前の判断に重ねると、窓の中だけ固定が勝つ', () => {
    const base = {
      removed: [{ start: 0, end: 30 }],
      added: [{ start: 50, end: 55 }],
      angles: [{ start: 0, end: 60, cameraId: 'B' }]
    }
    const pin = pinOverrides([{ start: 10, end: 20 }], [{ start: 10, end: 20, cameraId: 'A' }])
    const o = overridesWithPinned(base, pin, [{ start: 10, end: 20 }])
    expect(o.removed).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 30 }
    ])
    expect(o.added).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 55 }
    ])
    expect(o.angles.map((a) => [a.start, a.end, a.cameraId])).toEqual([
      [0, 10, 'B'],
      [10, 20, 'A'],
      [20, 60, 'B']
    ])
    expect(overridesWithin(o, [{ start: 10, end: 20 }], false)?.added).toEqual([
      { start: 50, end: 55 }
    ])
  })
})

describe('fitLength', () => {
  const W = { start: 0, end: 100 }
  it('長すぎれば後ろから削る', () => {
    const r = fitLength(
      [
        { start: 0, end: 10 },
        { start: 20, end: 30 }
      ],
      15,
      W
    )
    expect(r.short).toBe(0)
    expect(r.pieces).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 25 }
    ])
  })
  it('短ければ窓の中の素材で後ろの区間から伸ばす', () => {
    const r = fitLength(
      [
        { start: 0, end: 10 },
        { start: 20, end: 30 }
      ],
      30,
      W
    )
    expect(r.short).toBe(0)
    expect(r.pieces).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 40 }
    ])
  })
  it('窓の素材で埋めきれなければ足りない秒を返す', () => {
    const r = fitLength([{ start: 10, end: 20 }], 30, { start: 5, end: 25 })
    expect(r.pieces).toEqual([{ start: 5, end: 25 }])
    expect(r.short).toBeCloseTo(10)
  })
})

describe('窓の部品', () => {
  it('場面を窓で切り、残す区間を窓に収める', () => {
    const scenes = [
      { id: 's1', start: 0, end: 10 },
      { id: 's2', start: 10, end: 20 },
      { id: 's3', start: 20, end: 30 }
    ]
    expect(clipScenesToWindow(scenes, { start: 5, end: 15 })).toEqual([
      { id: 's1', start: 5, end: 10 },
      { id: 's2', start: 10, end: 15 }
    ])
    expect(clampPieces([{ start: 4.9, end: 9 }], { start: 5, end: 15 })).toEqual([
      { start: 5, end: 9 }
    ])
  })
  it('時刻のあるものは真ん中の時刻で入れ替える', () => {
    const base = [
      { startTime: 0, endTime: 4, k: 'a' },
      { startTime: 3, endTime: 9, k: 'b' },
      { startTime: 9, endTime: 12, k: 'c' }
    ]
    const r = spliceTimed(
      base,
      [
        { startTime: 5, endTime: 6, k: 'n' },
        { startTime: 20, endTime: 21, k: 'x' }
      ],
      {
        start: 4,
        end: 10
      }
    )
    expect(r.items.map((o) => o.k)).toEqual(['a', 'c', 'n'])
  })
})

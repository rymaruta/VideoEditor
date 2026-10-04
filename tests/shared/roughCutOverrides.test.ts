import { describe, expect, it } from 'vitest'
import {
  releaseOverridesForScenes,
  angleAlternatives,
  applyAngleOverrides,
  applyCutOverrides,
  coverageOfClips,
  subtractRanges,
  unionRanges,
  updateOverrides
} from '../../src/shared/roughCut/overrides'
import type { MulticamInfo } from '../../src/shared/sync/multicam'

const info: MulticamInfo = {
  anchorSourceId: 'A',
  sources: [
    { id: 'A', name: 'カメラA', kind: 'camera' },
    { id: 'B', name: 'カメラB', kind: 'camera' }
  ],
  files: [
    { assetId: 'a1', sourceId: 'A', start: 0, rate: 1, duration: 100 },
    // カメラB は 10 秒遅れて回り始めた(素材の 0 秒 = 共通の 10 秒)
    { assetId: 'b1', sourceId: 'B', start: 10, rate: 1, duration: 60 }
  ]
}

describe('区間の計算', () => {
  it('まとめる・差し引く', () => {
    expect(
      unionRanges([
        { start: 5, end: 8 },
        { start: 0, end: 3 },
        { start: 2, end: 4 }
      ])
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 8 }
    ])
    expect(subtractRanges([{ start: 0, end: 10 }], [{ start: 3, end: 4 }])).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 10 }
    ])
  })
})

describe('coverageOfClips', () => {
  it('本編のクリップを、共通の時刻とカメラにする', () => {
    expect(
      coverageOfClips(
        [
          { assetId: 'a1', inPoint: 0, outPoint: 5 },
          { assetId: 'b1', inPoint: 2, outPoint: 4 },
          { assetId: 'other', inPoint: 0, outPoint: 1 }
        ],
        info
      )
    ).toEqual([
      { start: 0, end: 5, cameraId: 'A' },
      { start: 12, end: 14, cameraId: 'B' }
    ])
  })
})

describe('updateOverrides', () => {
  const auto = [
    { start: 0, end: 10, cameraId: 'A' },
    { start: 20, end: 30, cameraId: 'A' }
  ]

  it('削った区間・足した区間・替えたカメラを読み取る', () => {
    const current = [
      // 4〜6 秒を削り、20〜30 秒をカメラB に替え、40〜42 秒を足した
      { start: 0, end: 4, cameraId: 'A' },
      { start: 6, end: 10, cameraId: 'A' },
      { start: 20, end: 30, cameraId: 'B' },
      { start: 40, end: 42, cameraId: 'B' }
    ]
    const o = updateOverrides(undefined, auto, current)
    expect(o.removed).toEqual([{ start: 4, end: 6 }])
    expect(o.added).toEqual([{ start: 40, end: 42 }])
    expect(o.angles).toEqual([
      { start: 20, end: 30, cameraId: 'B' },
      { start: 40, end: 42, cameraId: 'B' }
    ])
  })

  it('前の判断を覚えておき、新しい判断が勝つ(削った所を足し直したら、削った判断は消える)', () => {
    const first = updateOverrides(undefined, auto, [
      { start: 0, end: 4, cameraId: 'A' },
      { start: 6, end: 10, cameraId: 'A' },
      { start: 20, end: 30, cameraId: 'A' }
    ])
    // 作り直した本編(判断を当てたもの)が次の「自動」。そこへ人が 4〜6 秒を足し直した
    const rebuilt = [
      { start: 0, end: 4, cameraId: 'A' },
      { start: 6, end: 10, cameraId: 'A' },
      { start: 20, end: 30, cameraId: 'A' }
    ]
    const second = updateOverrides(first, rebuilt, [
      { start: 0, end: 10, cameraId: 'A' },
      { start: 20, end: 30, cameraId: 'A' }
    ])
    expect(second.removed).toEqual([])
    expect(second.added).toEqual([{ start: 4, end: 6 }])
  })

  it('何も直していなければ判断は増えない', () => {
    expect(updateOverrides(undefined, auto, auto)).toEqual({ removed: [], added: [], angles: [] })
  })
})

describe('applyCutOverrides / applyAngleOverrides', () => {
  it('削った区間を抜き、足した区間を加える', () => {
    const r = applyCutOverrides(
      [
        { start: 0, end: 10, sceneId: 's1' },
        { start: 20, end: 30, sceneId: 's2' }
      ],
      { removed: [{ start: 4, end: 6 }], added: [{ start: 40, end: 42 }], angles: [] }
    )
    expect(r.map((x) => [x.start, x.end, x.sceneId])).toEqual([
      [0, 4, 's1'],
      [6, 10, 's1'],
      [20, 30, 's2'],
      [40, 42, undefined]
    ])
  })

  it('替えたカメラはショットを分けて当てる。録っていない時間には当てない', () => {
    const shots = applyAngleOverrides(
      [{ start: 0, end: 30, cameraId: 'A', reason: 'default' }],
      [
        { start: 12, end: 15, cameraId: 'B' },
        // カメラB は 0〜10 秒を録っていないので当てない
        { start: 2, end: 4, cameraId: 'B' }
      ],
      info
    )
    expect(shots.map((s) => [s.start, s.end, s.cameraId])).toEqual([
      [0, 12, 'A'],
      [12, 15, 'B'],
      [15, 30, 'A']
    ])
  })
})

describe('angleAlternatives', () => {
  it('同じ時間を録っているカメラへ替えた値を返す(素材の時刻はそのカメラの時計で)', () => {
    const alts = angleAlternatives({ assetId: 'a1', inPoint: 12, outPoint: 15 }, info)
    expect(alts.find((a) => a.current)?.sourceId).toBe('A')
    expect(alts.find((a) => a.sourceId === 'B')?.clip).toEqual({
      assetId: 'b1',
      inPoint: 2,
      outPoint: 5,
      speed: 1
    })
    // カメラB が録っていない時間は替えられない
    expect(
      angleAlternatives({ assetId: 'a1', inPoint: 2, outPoint: 5 }, info).find(
        (a) => a.sourceId === 'B'
      )?.clip
    ).toBeUndefined()
  })
})

describe('releaseOverridesForScenes', () => {
  it('残すと決めた場面の中の削った区間は戻し、落とすと決めた場面の中の足した区間は外す', () => {
    const o = {
      removed: [{ start: 10, end: 20 }],
      added: [{ start: 40, end: 50 }],
      angles: []
    }
    const scenes = [
      { id: 'a', start: 0, end: 15 },
      { id: 'b', start: 35, end: 60 }
    ]
    expect(releaseOverridesForScenes(o, scenes, { a: true, b: false })).toEqual({
      removed: [{ start: 15, end: 20 }],
      added: [],
      angles: []
    })
    // 決めていなければそのまま
    expect(releaseOverridesForScenes(o, scenes, {})).toBe(o)
  })
})

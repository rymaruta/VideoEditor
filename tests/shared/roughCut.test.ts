import { describe, expect, it } from 'vitest'
import { buildRoughCut, roughTimelineAt } from '../../src/shared/roughCut/build'
import type { MulticamInfo } from '../../src/shared/sync/multicam'

// 共通の時間軸: カメラA は 0〜100 を2本(0〜50, 50〜100)、カメラB は 10〜100、マイクは 0〜100(時計 100ppm 速い)
const info: MulticamInfo = {
  anchorSourceId: 'A',
  sources: [
    { id: 'A', name: 'カメラA', kind: 'camera' },
    { id: 'B', name: 'カメラB', kind: 'camera', subject: '出演者B' },
    { id: 'M', name: '出演者A', kind: 'mic' }
  ],
  files: [
    { assetId: 'a1', sourceId: 'A', start: 0, rate: 1, duration: 50 },
    { assetId: 'a2', sourceId: 'A', start: 50, rate: 1, duration: 50 },
    { assetId: 'b1', sourceId: 'B', start: 10, rate: 1, duration: 90 },
    { assetId: 'm1', sourceId: 'M', start: 0, rate: 1.0001, duration: 100.01 }
  ]
}

describe('buildRoughCut', () => {
  const cut = buildRoughCut(
    [
      { start: 40, end: 45, cameraId: 'A', reason: 'default' },
      { start: 45, end: 60, cameraId: 'B', reason: 'speaker' },
      // 60〜80 はカットで飛ばした
      { start: 80, end: 90, cameraId: 'A', reason: 'jump' }
    ],
    info
  )

  it('本編はショットのカメラの素材を並べ、素材の切れ目では分ける', () => {
    expect(cut.main).toEqual([
      { assetId: 'a1', inPoint: 40, outPoint: 45, speed: 1 },
      { assetId: 'b1', inPoint: 35, outPoint: 50, speed: 1 },
      { assetId: 'a2', inPoint: 30, outPoint: 40, speed: 1 }
    ])
    expect(cut.duration).toBe(30)
  })

  it('マイクの音は、時間の続いている区間ごとに1本にまとめ、本編と同じ位置に置く', () => {
    const mic = cut.audio.find((a) => a.sourceId === 'M')!
    expect(mic.clips).toHaveLength(2)
    expect(mic.clips[0].startTime).toBe(0)
    expect(mic.clips[0].inPoint).toBeCloseTo(40 * 1.0001, 9)
    expect(mic.clips[0].outPoint).toBeCloseTo(60 * 1.0001, 9)
    expect(mic.clips[0].speed).toBe(1.0001)
    expect(mic.clips[1].startTime).toBe(20)
    expect(mic.clips[1].inPoint).toBeCloseTo(80 * 1.0001, 9)
  })

  it('周りの音として基準カメラの音を小さく流す', () => {
    const amb = cut.audio.find((a) => a.sourceId === 'A')!
    expect(amb.name).toBe('周りの音(カメラA)')
    expect(amb.volume).toBeLessThan(1)
    expect(amb.clips.map((c) => [c.assetId, c.startTime, c.inPoint, c.outPoint])).toEqual([
      ['a1', 0, 40, 50],
      ['a2', 10, 0, 10],
      ['a2', 20, 30, 40]
    ])
  })

  it('共通の時刻から、仮編集のタイムラインの時刻を引ける', () => {
    expect(roughTimelineAt(cut.spans, 50)).toBe(10)
    expect(roughTimelineAt(cut.spans, 85)).toBe(25)
    expect(roughTimelineAt(cut.spans, 70)).toBeNull()
  })
})

describe('buildRoughCut: カメラの素材の切れ目に掛かったショット', () => {
  // カメラB は分割ファイル(つなぎ目に同期の丸めで 20ms の隙間)と、録画を止めた間(2000〜2100)がある
  const gapInfo: MulticamInfo = {
    anchorSourceId: 'A',
    sources: [
      { id: 'A', name: 'カメラA', kind: 'camera' },
      { id: 'B', name: 'カメラB', kind: 'camera' }
    ],
    files: [
      { assetId: 'a1', sourceId: 'A', start: 0, rate: 1, duration: 3000 },
      { assetId: 'b1', sourceId: 'B', start: 0, rate: 1, duration: 1000 },
      { assetId: 'b2', sourceId: 'B', start: 1000.02, rate: 1, duration: 999.98 },
      { assetId: 'b3', sourceId: 'B', start: 2100, rate: 1, duration: 900 }
    ]
  }

  it('分割ファイルのつなぎ目では切り捨てず、次のファイルへ続ける', () => {
    const cut = buildRoughCut(
      [{ start: 990, end: 1010, cameraId: 'B', reason: 'speaker' }],
      gapInfo
    )
    expect(cut.main.map((c) => c.assetId)).toEqual(['b1', 'b2'])
    expect(cut.main[1].inPoint).toBeCloseTo(0, 9)
    expect(cut.main[1].outPoint).toBeCloseTo(9.98, 9)
    expect(cut.duration).toBeCloseTo(19.98, 9)
  })

  it('録画を止めていた間は基準カメラで埋め、録画が戻ったらショットのカメラへ戻る', () => {
    const cut = buildRoughCut(
      [{ start: 1990, end: 2110, cameraId: 'B', reason: 'speaker' }],
      gapInfo
    )
    expect(cut.main.map((c) => [c.assetId, c.inPoint, c.outPoint])).toEqual([
      ['b2', expect.closeTo(989.98, 9), expect.closeTo(999.98, 9)],
      ['a1', 2000, 2100],
      ['b3', 0, 10]
    ])
    expect(cut.duration).toBeCloseTo(120, 9)
  })
})

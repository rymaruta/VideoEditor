import { describe, expect, it } from 'vitest'
import { buildMulticamLayout } from '../../../src/shared/sync/multicamLayout'
import type { Placement } from '../../../src/shared/sync/solve'

const sources = [
  { id: 'A', name: 'カメラA', kind: 'camera' as const },
  { id: 'B', name: 'カメラB', kind: 'camera' as const },
  { id: 'M', name: 'マイク1', kind: 'mic' as const }
]
// A は 10〜310 と 400〜700 を録画(間の 310〜400 は止めていた)、B は 50〜650、マイクは 0〜900
const files = [
  { id: 'A1', sourceId: 'A', duration: 300 },
  { id: 'A2', sourceId: 'A', duration: 300 },
  { id: 'B1', sourceId: 'B', duration: 600 },
  { id: 'M1', sourceId: 'M', duration: 900 }
]
const placements: Placement[] = [
  { id: 'A1', start: 10, method: 'audio', rate: 1 },
  { id: 'A2', start: 400, method: 'audio', rate: 1 },
  { id: 'B1', start: 50, method: 'audio', rate: 1 },
  { id: 'M1', start: 0, method: 'audio', rate: 1 }
]

describe('buildMulticamLayout', () => {
  const layout = buildMulticamLayout(sources, files, placements)!

  it('一番長く録れているカメラを本編にし、録画の止まっていた時間は詰める', () => {
    expect(layout.anchorSourceId).toBe('A')
    expect(layout.main).toEqual([
      { fileId: 'A1', inPoint: 0, outPoint: 300, speed: 1 },
      { fileId: 'A2', inPoint: 0, outPoint: 300, speed: 1 }
    ])
    expect(layout.duration).toBe(600)
  })

  it('ほかのカメラは同じ時刻の位置に置き、詰めた時間で切り分ける', () => {
    expect(layout.cameras).toHaveLength(1)
    expect(layout.cameras[0].pieces).toEqual([
      // B の 50〜310 → タイムライン 40〜300
      { fileId: 'B1', startTime: 40, inPoint: 0, outPoint: 260, speed: 1 },
      // B の 400〜650 → タイムライン 300〜550
      { fileId: 'B1', startTime: 300, inPoint: 350, outPoint: 600, speed: 1 }
    ])
  })

  it('マイクも同じ規則で並べる(本編の外の時間は使わない)', () => {
    expect(layout.mics[0].pieces).toEqual([
      { fileId: 'M1', startTime: 0, inPoint: 10, outPoint: 310, speed: 1 },
      { fileId: 'M1', startTime: 300, inPoint: 400, outPoint: 700, speed: 1 }
    ])
  })

  it('同期できなかった素材は並べずに知らせる', () => {
    const l = buildMulticamLayout(sources, files, [
      ...placements.slice(0, 3),
      { id: 'M1', start: 2000, method: 'none', rate: 1 }
    ])!
    expect(l.leftOut).toEqual(['M1'])
    expect(l.mics).toEqual([])
  })

  it('カメラが1台も同期できなければ並べられない', () => {
    expect(
      buildMulticamLayout(
        sources,
        files,
        placements.map((p) => ({ ...p, method: 'none' as const }))
      )
    ).toBeNull()
  })

  it('時計のずれたマイクは速度で補正し、基準カメラの時計に合わせる', () => {
    // マイクの時計が 100ppm 速い(共通の時間軸1秒あたり 1.0001 秒進む)
    const l = buildMulticamLayout(sources, files, [
      ...placements.slice(0, 3),
      { id: 'M1', start: 0, method: 'audio', rate: 1.0001 }
    ])!
    const [first, second] = l.mics[0].pieces
    expect(first.speed).toBeCloseTo(1.0001, 9)
    expect(first.inPoint).toBeCloseTo(10 * 1.0001, 9)
    // 本編の 400 秒の位置は、マイクの時計では 400.04 秒
    expect(second.inPoint).toBeCloseTo(400 * 1.0001, 9)
    expect((second.outPoint - second.inPoint) / second.speed).toBeCloseTo(300, 9)
  })

  it('同期の基準が基準カメラでなくても、基準カメラの時計に直す', () => {
    // 同期の結果がマイクの時計で表されていて、カメラの時計がそれより 100ppm 遅い場合
    const r = 1 / 1.0001
    const l = buildMulticamLayout(sources, files, [
      { id: 'A1', start: 10, method: 'audio', rate: r },
      { id: 'A2', start: 400, method: 'audio', rate: r },
      { id: 'B1', start: 50, method: 'audio', rate: r },
      { id: 'M1', start: 0, method: 'audio', rate: 1 }
    ])!
    expect(l.main.every((m) => Math.abs(m.speed - 1) < 1e-12)).toBe(true)
    expect(l.mics[0].pieces[0].speed).toBeCloseTo(1.0001, 9)
  })
})

import { describe, expect, it } from 'vitest'
import { solvePlacements, type SyncFile } from '../../../src/shared/sync/solve'

const startOf = (r: ReturnType<typeof solvePlacements>, id: string): number =>
  r.placements.find((p) => p.id === id)!.start

describe('solvePlacements', () => {
  // 真の位置: A1=10, A2=400, B1=0, M1=5(4時間のピンマイク)
  const files: SyncFile[] = [
    { id: 'A1', sourceId: 'A', duration: 300 },
    { id: 'A2', sourceId: 'A', duration: 300 },
    { id: 'B1', sourceId: 'B', duration: 900 },
    { id: 'M1', sourceId: 'M', duration: 3600 }
  ]

  it('音で合った組から全素材を並べる(最小が 0)', () => {
    const r = solvePlacements(files, [
      { a: 'M1', b: 'A1', offset: 5, confidence: 100 },
      { a: 'M1', b: 'A2', offset: 395, confidence: 90 },
      { a: 'B1', b: 'M1', offset: 5, confidence: 80 }
    ])
    expect(startOf(r, 'B1')).toBeCloseTo(0)
    expect(startOf(r, 'M1')).toBeCloseTo(5)
    expect(startOf(r, 'A1')).toBeCloseTo(10)
    expect(startOf(r, 'A2')).toBeCloseTo(400)
    expect(r.placements.every((p) => p.method === 'audio')).toBe(true)
    expect(r.issues).toEqual([])
  })

  it('音で合わなかった素材も、同じ機材の録画時刻で並べる', () => {
    const r = solvePlacements(
      [{ ...files[0], recordedAt: 1000 }, { ...files[1], recordedAt: 1390 }, files[2], files[3]],
      [
        { a: 'M1', b: 'A1', offset: 5, confidence: 100 },
        { a: 'B1', b: 'M1', offset: 5, confidence: 80 }
      ]
    )
    expect(startOf(r, 'A2')).toBeCloseTo(400)
    expect(r.placements.find((p) => p.id === 'A2')!.method).toBe('clock')
  })

  it('つながらない素材は最後に並べて要確認にする', () => {
    const r = solvePlacements(files, [
      { a: 'M1', b: 'A1', offset: 5, confidence: 100 },
      { a: 'B1', b: 'M1', offset: 5, confidence: 80 }
    ])
    expect(r.issues).toContainEqual({ kind: 'unsynced', fileId: 'A2' })
    expect(r.placements.find((p) => p.id === 'A2')!.method).toBe('none')
    expect(startOf(r, 'A2')).toBeGreaterThanOrEqual(3605)
  })

  it('使わなかった組の食い違いを報告する', () => {
    const r = solvePlacements(files, [
      { a: 'M1', b: 'A1', offset: 5, confidence: 100 },
      { a: 'M1', b: 'A2', offset: 395, confidence: 90 },
      { a: 'B1', b: 'M1', offset: 5, confidence: 80 },
      { a: 'B1', b: 'A1', offset: 12, confidence: 50 } // 本当は 10
    ])
    const conflict = r.issues.find((i) => i.kind === 'conflict')
    expect(conflict).toBeDefined()
    expect(conflict && 'difference' in conflict ? conflict.difference : 0).toBeCloseTo(-2)
  })

  it('同じカメラで録画が重なれば報告する', () => {
    const r = solvePlacements(files, [
      { a: 'M1', b: 'A1', offset: 5, confidence: 100 },
      { a: 'M1', b: 'A2', offset: 100, confidence: 90 }, // A1(5〜305) と重なる
      { a: 'B1', b: 'M1', offset: 5, confidence: 80 }
    ])
    expect(r.issues.some((i) => i.kind === 'overlap')).toBe(true)
  })
})

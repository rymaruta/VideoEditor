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

  it('時計の進みのずれを、つないだ先へ受け渡す', () => {
    const r = solvePlacements(files, [
      // A1 の時計はマイクより 100ppm 速い。offset はマイクの時計の秒
      { a: 'M1', b: 'A1', offset: 5, confidence: 100, rate: 1.0001 },
      { a: 'B1', b: 'M1', offset: 5, confidence: 90 },
      // A2 は A1 の時計で 390 秒後
      { a: 'A1', b: 'A2', offset: 390, confidence: 80, rate: 1 }
    ])
    // 位置と時計の進みは「最初に並べた素材」の時計で表されるので、比で確かめる
    const rate = (id: string): number => r.placements.find((p) => p.id === id)!.rate
    expect(rate('A2') / rate('M1')).toBeCloseTo(1.0001, 9)
    expect(rate('A2') / rate('A1')).toBeCloseTo(1, 9)
    // A1 の時計の 390 秒後
    expect((startOf(r, 'A2') - startOf(r, 'A1')) * rate('A1')).toBeCloseTo(390, 9)
    // マイクの時計の 5 秒後に A1 が始まる
    expect((startOf(r, 'A1') - startOf(r, 'M1')) * rate('M1')).toBeCloseTo(5, 9)
  })

  it('時計の比を測っていない組で位置を決めても、機材どうしの比で補正する', () => {
    // マイク2(N1)の時計はマイク1(M1)より 62.5ppm 速い。N1 の位置は A1 との短い組で決まる
    const eps = 62.5e-6
    const truth = { M1: 0, N1: 3.2, A1: 12.5 }
    const f2: SyncFile[] = [
      { id: 'M1', sourceId: 'M', duration: 3600 },
      { id: 'N1', sourceId: 'N', duration: 3500 },
      { id: 'A1', sourceId: 'A', duration: 300 }
    ]
    // N1 → A1 の組: N1 の時計で測る。A1 の頭は N1 の時計で (12.5 - 3.2)(1+ε)。測った位置は重なりの中ほど
    const center = (12.5 - 3.2) * (1 + eps) + 150 * (1 + eps)
    // 中ほどで測った offset = 頭 - ε'(center - 頭)、ε' は N に対する A の比 - 1
    const epsNA = 1 / (1 + eps) - 1
    const headNA = (truth.A1 - truth.N1) * (1 + eps)
    const measuredNA = headNA - epsNA * (center - headNA)
    const r = solvePlacements(f2, [
      { a: 'M1', b: 'A1', offset: 12.5, confidence: 100, center: 162.5 },
      {
        a: 'M1',
        b: 'N1',
        offset: 3.2 - eps * (1800 - 3.2),
        confidence: 50,
        rate: 1 + eps,
        center: 1800
      },
      { a: 'N1', b: 'A1', offset: measuredNA, confidence: 90, center }
    ])
    const rate = (id: string): number => r.placements.find((p) => p.id === id)!.rate
    expect(rate('N1') / rate('M1')).toBeCloseTo(1 + eps, 12)
    const n1 = (startOf(r, 'N1') - startOf(r, 'M1')) * rate('M1')
    expect(Math.abs(n1 - truth.N1)).toBeLessThan(1e-6)
  })
})

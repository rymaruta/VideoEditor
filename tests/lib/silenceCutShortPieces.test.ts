import { describe, expect, it } from 'vitest'
import {
  MERGE_PIECE_MAX_SEC,
  buildCutSegments,
  mergeShortPieceCuts
} from '../../src/renderer/src/lib/silenceCut'
import type { Clip, SilenceRange } from '../../src/shared/types'

/**
 * 無音詰めの細切れ(実地テスト: 3時間で 806 区間を詰めると 704 片、うち 0.05〜0.3 秒が 47 片)。
 * 無音の検出は余白なしで切るので、無音の間の短い音が細切れのクリップになっていた
 */

const clip: Clip = { id: 'c', assetId: 'a', inPoint: 1640, outPoint: 1675, speed: 1 }

// 実地テストの検出結果(抜粋)
const detected: SilenceRange[] = [
  { start: 1642.397937, end: 1643.279521 },
  { start: 1644.371062, end: 1645.059604 },
  { start: 1645.276437, end: 1646.63025 },
  { start: 1646.809875, end: 1649.5795 },
  { start: 1649.579646, end: 1652.602271 },
  { start: 1653.521438, end: 1654.215229 },
  { start: 1654.220292, end: 1654.940333 },
  { start: 1654.940687, end: 1656.385417 },
  { start: 1656.386042, end: 1659.927354 },
  { start: 1660.609979, end: 1662.202583 },
  { start: 1662.279042, end: 1664.588979 },
  { start: 1664.593833, end: 1669.344104 },
  { start: 1672.6665, end: 1673.49375 }
]

const lengths = (cs: Clip[]): number[] => cs.map((c) => c.outPoint - c.inPoint)
const total = (rs: SilenceRange[]): number => rs.reduce((t, r) => t + r.end - r.start, 0)

describe('無音詰めで細切れの片を作らない', () => {
  it('実地テストの区間: 言葉になりえない片(0.12 秒未満)を作らず、詰める長さは減らさない', () => {
    // 直す前は 0.08 秒・0.005 秒などの片ができていた
    const before = lengths(buildCutSegments(clip, detected))
    expect(before.some((l) => l < MERGE_PIECE_MAX_SEC)).toBe(true)
    const cuts = mergeShortPieceCuts(clip, detected)
    const pieces = buildCutSegments(clip, cuts)
    expect(Math.min(...lengths(pieces))).toBeGreaterThanOrEqual(MERGE_PIECE_MAX_SEC)
    expect(total(cuts)).toBeGreaterThanOrEqual(total(detected))
    expect(pieces.length).toBeLessThan(before.length)
    // 元の無音はどれも詰める区間に入る(長い無音を残さない)
    for (const r of detected)
      expect(cuts.some((c) => c.start <= r.start + 1e-9 && r.end <= c.end + 1e-9)).toBe(true)
  })

  it('間の切れ端(0.08 秒)は両隣の無音と一緒に詰める(無音をつないで1つにする)', () => {
    const c: Clip = { ...clip, inPoint: 0, outPoint: 20 }
    expect(
      mergeShortPieceCuts(c, [
        { start: 2, end: 5 },
        { start: 5.08, end: 9 }
      ])
    ).toEqual([{ start: 2, end: 9 }])
  })

  it('0.25 秒の「はい」は残す。クリップの頭・終わりの短い片(言葉の尾・頭)もまとめない', () => {
    const c: Clip = { ...clip, inPoint: 10, outPoint: 30 }
    const hai = [
      { start: 12, end: 15 },
      { start: 15.25, end: 18 }
    ]
    expect(mergeShortPieceCuts(c, hai)).toEqual(hai)
    expect(
      lengths(buildCutSegments(c, mergeShortPieceCuts(c, hai))).map((l) => +l.toFixed(2))
    ).toEqual([2, 0.25, 12])
    const edges = [
      { start: 10.25, end: 12 },
      { start: 20, end: 29.9 }
    ]
    expect(mergeShortPieceCuts(c, edges)).toEqual(edges)
    expect(lengths(buildCutSegments(c, edges)).map((l) => +l.toFixed(2))).toEqual([0.25, 8, 0.1])
  })

  it('長い片はそのまま。数値でない・長さ 0・クリップの外の区間は捨てる', () => {
    const c: Clip = { ...clip, inPoint: 0, outPoint: 10 }
    expect(
      mergeShortPieceCuts(c, [
        { start: 2, end: 4 },
        { start: 4.5, end: 6 }
      ])
    ).toEqual([
      { start: 2, end: 4 },
      { start: 4.5, end: 6 }
    ])
    expect(mergeShortPieceCuts(c, [])).toEqual([])
    expect(
      mergeShortPieceCuts(c, [
        { start: NaN, end: 3 },
        { start: 5, end: 5 },
        { start: 12, end: 14 },
        { start: -3, end: 1 }
      ])
    ).toEqual([{ start: 0, end: 1 }])
  })
})

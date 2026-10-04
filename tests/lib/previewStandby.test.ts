import { describe, expect, it } from 'vitest'
import {
  canSwapToStandby,
  standbyTargetFor,
  STANDBY_LEAD_SEC
} from '../../src/renderer/src/lib/previewStandby'

type ClipLike = Parameters<typeof standbyTargetFor>[0]

const clip = (
  url: string,
  inPoint: number,
  outPoint: number,
  end: number,
  speed = 1
): ClipLike => ({
  url,
  inPoint,
  outPoint,
  speed,
  clipId: `${url}@${inPoint}`,
  end
})

describe('standbyTargetFor', () => {
  const cur = clip('A', 10, 14, 4)
  it('別のカメラへ切り替わる手前で、次のクリップの頭を用意する', () => {
    expect(standbyTargetFor(cur, clip('B', 14, 17, 7), 3)).toEqual({
      url: 'B',
      time: 14,
      clipId: 'B@14'
    })
  })
  it('切れ目がまだ遠いうちは用意しない', () => {
    expect(standbyTargetFor(cur, clip('B', 14, 17, 7), 4 - STANDBY_LEAD_SEC - 0.1)).toBeNull()
  })
  it('同じ素材の飛び先(間を詰めた所)も用意する', () => {
    expect(standbyTargetFor(cur, clip('A', 15, 18, 7), 3)?.time).toBe(15)
  })
  it('同じ素材の続き(位置も速さもつながる)は今の要素で流すので用意しない', () => {
    expect(standbyTargetFor(cur, clip('A', 14.02, 18, 7), 3)).toBeNull()
    expect(standbyTargetFor(cur, clip('A', 14, 18, 6, 2), 3)).not.toBeNull()
  })
  it('次が無ければ用意しない', () => {
    expect(standbyTargetFor(cur, null, 3.9)).toBeNull()
  })
})

describe('canSwapToStandby', () => {
  const el = (
    src: string,
    t: number,
    readyState = 4,
    seeking = false
  ): Parameters<typeof canSwapToStandby>[0] => ({
    getAttribute: () => src,
    readyState,
    currentTime: t,
    seeking
  })
  const prepared = { url: 'B', time: 14, clipId: 'B@14' }
  it('用意した素材・位置と一致し、画が出せるなら入れ替える', () => {
    expect(canSwapToStandby(el('B', 14.03), prepared, 'B', 14)).toBe(true)
  })
  it('素材違い・位置違い・読み込み中・シーク中・未用意は入れ替えない', () => {
    expect(canSwapToStandby(el('A', 14), prepared, 'B', 14)).toBe(false)
    expect(canSwapToStandby(el('B', 15), prepared, 'B', 14)).toBe(false)
    expect(canSwapToStandby(el('B', 14, 1), prepared, 'B', 14)).toBe(false)
    expect(canSwapToStandby(el('B', 14, 4, true), prepared, 'B', 14)).toBe(false)
    expect(canSwapToStandby(el('B', 14), null, 'B', 14)).toBe(false)
    expect(canSwapToStandby(null, prepared, 'B', 14)).toBe(false)
  })
})

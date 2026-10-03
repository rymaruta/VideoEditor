import { describe, expect, it } from 'vitest'
import { decideTelopPlacement, telopRect } from '../../src/shared/telop/avoidFaces'
import { defaultTextStyle } from '../../src/shared/textStyle'

const canvas = { w: 1920, h: 1080 }
const telop = {
  text: 'えっ？ヤバイですよね',
  style: { ...defaultTextStyle(), position: 'bottom' as const, fontSize: 60 }
}

describe('decideTelopPlacement', () => {
  it('顔が画面の上の方なら、下のまま', () => {
    expect(
      decideTelopPlacement(telop, [{ x: 0.4, y: 0.15, w: 0.2, h: 0.3, score: 0.9 }], canvas)
    ).toBe('keep')
  })

  it('下のテロップが顔(あご)に掛かるなら、上へ移す', () => {
    const r = telopRect(telop, canvas)
    const face = { x: 0.42, y: r.y - 0.2, w: 0.16, h: 0.25, score: 0.9 }
    expect(decideTelopPlacement(telop, [face], canvas)).toBe('moveTop')
  })

  it('上にも下にも顔があれば、要確認', () => {
    const faces = [
      { x: 0.42, y: 0.75, w: 0.16, h: 0.2, score: 0.9 },
      { x: 0.42, y: 0.02, w: 0.16, h: 0.2, score: 0.9 }
    ]
    expect(decideTelopPlacement(telop, faces, canvas)).toBe('review')
  })

  it('自信の低い検出と、手で置いたテロップは無視する', () => {
    const face = { x: 0.42, y: 0.75, w: 0.16, h: 0.2, score: 0.5 }
    expect(decideTelopPlacement(telop, [face], canvas)).toBe('keep')
    const custom = { ...telop, style: { ...telop.style, customPosition: { x: 0.5, y: 0.9 } } }
    expect(decideTelopPlacement(custom, [{ ...face, score: 0.9 }], canvas)).toBe('keep')
  })
})

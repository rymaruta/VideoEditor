import { describe, expect, it } from 'vitest'
import type { TelopGradient } from '../../src/shared/types'
import { defaultTextStyle, normalizeGradient } from '../../src/shared/textStyle'
import { telopStrokeRings } from '../../src/shared/telop/render'
import {
  addGradientStop,
  addStroke,
  effectiveFillGradient,
  GRADIENT_MAX_STOPS,
  GRADIENT_PRESETS,
  gradientColorAt,
  gradientCss,
  gradientFromColor,
  MAX_STROKES,
  moveGradientStop,
  moveStroke,
  normalizeAngle,
  pointerToward,
  removeGradientStop,
  shadowDisplay,
  strokesFromStyle,
  strokesToStyle
} from '../../src/renderer/src/lib/telopAppearance'

const bw: TelopGradient = {
  angle: 0,
  stops: [
    { at: 0, color: '#000000' },
    { at: 1, color: '#ffffff' }
  ]
}

describe('グラデーションの色の止まり', () => {
  it('間の色は RGB で直線に混ぜる', () => {
    expect(gradientColorAt(bw, 0.5)).toBe('#808080')
    expect(gradientColorAt(bw, -1)).toBe('#000000')
    expect(gradientColorAt(bw, 2)).toBe('#ffffff')
  })

  it('足すとその位置の色で入り、並び順での番号を返す', () => {
    const { gradient, index } = addGradientStop(bw, 0.25)
    expect(index).toBe(1)
    expect(gradient.stops.map((s) => s.at)).toEqual([0, 0.25, 1])
    expect(gradient.stops[1].color).toBe('#404040')
  })

  it('8色より多くは足せない', () => {
    let g = bw
    for (let i = 0; i < 20; i++) g = addGradientStop(g, Math.random()).gradient
    expect(g.stops).toHaveLength(GRADIENT_MAX_STOPS)
    expect(addGradientStop(g, 0.5).index).toBe(-1)
  })

  it('消すのは2色までで止まる', () => {
    const three = addGradientStop(bw, 0.5).gradient
    const two = removeGradientStop(three, 1)
    expect(two.stops.map((s) => s.color)).toEqual(['#000000', '#ffffff'])
    expect(removeGradientStop(two, 0)).toBe(two)
  })

  it('動かすと並べ直し、動かした止まりの新しい番号を返す', () => {
    const three = addGradientStop(bw, 0.5).gradient
    const moved = moveGradientStop(three, 0, 0.8)
    expect(moved.gradient.stops.map((s) => s.at)).toEqual([0.5, 0.8, 1])
    expect(moved.index).toBe(1)
    expect(moved.gradient.stops[1].color).toBe('#000000')
    // 範囲外は 0〜1 に収める
    expect(moveGradientStop(three, 1, 5).gradient.stops.at(-1)!.at).toBe(1)
  })

  it('CSS の向きは描画と同じ(0 = 上→下 → 180deg、90 = 左→右 → 90deg)', () => {
    expect(gradientCss(bw)).toBe('linear-gradient(180deg, #000000 0%, #ffffff 100%)')
    expect(gradientCss({ ...bw, angle: 90 })).toContain('(90deg')
    expect(normalizeAngle(-90)).toBe(270)
    expect(normalizeAngle(720)).toBe(0)
  })

  it('見本のグラデーションは保存しても形が変わらない', () => {
    for (const p of GRADIENT_PRESETS) expect(normalizeGradient(p.gradient)).toEqual(p.gradient)
  })

  it('単色から始めると、今の色とそれと違う色の2色になる', () => {
    const g = gradientFromColor('#ffffff')
    expect(g.stops[0].color).toBe('#ffffff')
    expect(g.stops[1].color).not.toBe('#ffffff')
    expect(gradientFromColor('#000000').stops[1].color).not.toBe('#000000')
  })

  it('旧形式の縦2色も塗りのグラデーションとして読む(新形式が優先)', () => {
    const legacy = defaultTextStyle({ color: '#ffffff', gradientColor: '#ffcc00' })
    expect(effectiveFillGradient(legacy)).toEqual({
      angle: 0,
      stops: [
        { at: 0, color: '#ffffff' },
        { at: 1, color: '#ffcc00' }
      ]
    })
    expect(effectiveFillGradient({ ...legacy, fillGradient: bw })).toBe(bw)
    expect(effectiveFillGradient(defaultTextStyle())).toBeUndefined()
  })
})

describe('縁の一覧と TextStyle の対応', () => {
  it('1本目は従来の縁、2本目以降は外側の縁(内側から順)', () => {
    const style = defaultTextStyle({
      outlineColor: '#111111',
      outlineWidth: 4,
      extraStrokes: [{ color: '#ffffff', width: 6 }]
    })
    const list = strokesFromStyle(style)
    expect(list).toEqual([
      { color: '#111111', width: 4 },
      { color: '#ffffff', width: 6 }
    ])
    expect({ ...style, ...strokesToStyle(list) }).toMatchObject({
      outline: true,
      outlineColor: '#111111',
      outlineWidth: 4,
      extraStrokes: [{ color: '#ffffff', width: 6 }]
    })
  })

  it('書き戻した縁は、描画でも同じ順に積まれる(いちばん外側が最初)', () => {
    const list = [
      { color: '#ff0000', width: 2 },
      { color: '#00ff00', width: 3 },
      { color: '#0000ff', width: 4, gradient: bw }
    ]
    const style = { ...defaultTextStyle(), ...strokesToStyle(list) }
    expect(telopStrokeRings(style).map((r) => [r.color, r.reach])).toEqual([
      ['#0000ff', 9],
      ['#00ff00', 5],
      ['#ff0000', 2]
    ])
    expect(telopStrokeRings(style)[0].gradient).toBe(bw)
  })

  it('縁を付けていないテロップは、外側の縁だけを一覧にする', () => {
    const style = defaultTextStyle({ outline: false, extraStrokes: [{ color: '#fff', width: 5 }] })
    expect(strokesFromStyle(style)).toEqual([{ color: '#fff', width: 5 }])
  })

  it('1本目のグラデーションは outlineGradient に入る', () => {
    expect(strokesToStyle([{ color: '#000', width: 3, gradient: bw }]).outlineGradient).toBe(bw)
    expect(strokesToStyle([{ color: '#000', width: 3 }]).outlineGradient).toBeUndefined()
  })

  it('空にすると縁なし(色・太さは残して、また付けたときに戻る)', () => {
    const patch = strokesToStyle([])
    expect(patch).toEqual({ outline: false, outlineGradient: undefined, extraStrokes: undefined })
    expect('outlineColor' in patch).toBe(false)
  })

  it('足す・並べ替える', () => {
    const one = addStroke([])
    expect(one).toEqual([{ color: '#000000', width: 3 }])
    const two = addStroke(one)
    expect(two[1].color).toBe('#ffffff')
    expect(moveStroke(two, 1, -1).map((s) => s.color)).toEqual(['#ffffff', '#000000'])
    expect(moveStroke(two, 0, -1)).toEqual(two)
    let many = two
    for (let i = 0; i < 10; i++) many = addStroke(many)
    expect(many).toHaveLength(MAX_STROKES)
  })
})

describe('影・矢印', () => {
  it('未指定の影は従来の右下 (2, 2) と同じ向き・距離で見せる', () => {
    const s = shadowDisplay(defaultTextStyle())
    expect(s.angle).toBe(45)
    const rad = (s.angle * Math.PI) / 180
    expect(Math.cos(rad) * s.distance).toBeCloseTo(2, 1)
    expect(Math.sin(rad) * s.distance).toBeCloseTo(2, 1)
  })

  it('矢印の向きを変えても長さは保つ', () => {
    const next = pointerToward({ dx: 0.3, dy: 0.4 }, -1, 0)
    expect(next).toEqual({ dx: -0.5, dy: 0 })
    expect(Math.hypot(...Object.values(pointerToward({ dx: 0, dy: 0 }, 1, 1)))).toBeCloseTo(0.05)
  })
})

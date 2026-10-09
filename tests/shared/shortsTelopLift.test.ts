import { describe, expect, it } from 'vitest'
import {
  liftAboveShortsUi,
  SHORTS_TELOP_BOTTOM,
  stackSimultaneousTelops
} from '@shared/telop/stack'
import { telopHitBounds } from '@shared/telop/render'
import { textCanvasSize } from '@shared/resolution'
import { SHORTS_SAFE_BOTTOM_RATIO } from '../../src/renderer/src/lib/shortsSafeArea'
import { defaultTextStyle } from '@shared/textStyle'
import type { TextOverlay } from '@shared/types'

const telop = (text: string, extra: Partial<TextOverlay['style']> = {}): TextOverlay => ({
  id: text,
  text,
  startTime: 0,
  endTime: 2,
  style: { ...defaultTextStyle({ position: 'bottom' }), ...extra }
})

describe('liftAboveShortsUi — 縦型ショートの下のテロップを Shorts の帯より上へ', () => {
  it('既定の位置のテロップは、下端が帯(84%)より上になる', () => {
    expect(SHORTS_TELOP_BOTTOM).toBeLessThan(SHORTS_SAFE_BOTTOM_RATIO)
    const [t] = liftAboveShortsUi([telop('今日はいい天気ですね')], 1920)
    expect(t.style.customPosition?.x).toBe(0.5)
    expect(t.style.customPosition!.y).toBeLessThan(SHORTS_TELOP_BOTTOM)
    expect(t.style.customPosition!.y).toBeGreaterThan(0.7)
  })

  it('上に積んだテロップは同じだけ上げ(間隔はそのまま)、上・真ん中のテロップは動かさない', () => {
    const [lower, upper] = stackSimultaneousTelops([telop('下の段'), telop('上の段')], 1920)
    const top = telop('見出し', { position: 'top' })
    const center = telop('真ん中', { position: 'center' })
    const out = liftAboveShortsUi([lower, upper, top, center], 1920)
    const lift = 0.92 - SHORTS_TELOP_BOTTOM
    expect(out[1].style.customPosition!.y).toBeCloseTo(upper.style.customPosition!.y - lift, 6)
    expect(out[2]).toBe(top)
    expect(out[3]).toBe(center)
  })

  const canvas = textCanvasSize('9:16')
  const ctx = {
    font: '',
    measureText(ch: string) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
      return { width: size * (/[\x20-\x7e]/.test(ch) ? 0.6 : 1) } as TextMetrics
    }
  }
  const rect = (o: TextOverlay): [number, number] => {
    const b = telopHitBounds(ctx, o, canvas)
    return [(b.anchor.y + b.y) / canvas.h, (b.anchor.y + b.y + b.h) / canvas.h]
  }

  it('積んだ段が画面の真ん中をまたいでも、全部の段を同じだけ上げて重ならない', () => {
    const base = telop('今日はいい天気ですね、本当に')
    const style = { ...base.style, fontSize: base.style.fontSize * 2.4 }
    const ts = [0, 1, 2, 3].map((i) => ({ ...base, id: `s${i}`, style, startTime: i * 0.2 }))
    const stacked = stackSimultaneousTelops(ts, canvas.h)
    // 前提: 段が真ん中(0.5)をまたいでいる
    expect(stacked.some((o) => (o.style.customPosition?.y ?? 1) < 0.5)).toBe(true)
    const rects = liftAboveShortsUi(stacked, canvas.h).map(rect)
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        expect(rects[i][0] < rects[j][1] - 1e-6 && rects[j][0] < rects[i][1] - 1e-6).toBe(false)
    expect(Math.max(...rects.map((r) => r[1]))).toBeLessThanOrEqual(SHORTS_TELOP_BOTTOM + 1e-6)
  })

  it('自由配置(縦書きの発言)も、下端が帯にかかるなら帯より上へ上げる', () => {
    const vertical = telop('ここが噂の絶景スポットか', {
      vertical: true,
      fontSize: 80,
      customPosition: { x: 0.9, y: 0.6 }
    })
    expect(rect(vertical)[1]).toBeGreaterThan(SHORTS_TELOP_BOTTOM)
    const [out] = liftAboveShortsUi([vertical], canvas.h)
    expect(out.style.customPosition!.x).toBe(0.9)
    expect(rect(out)[1]).toBeLessThanOrEqual(SHORTS_TELOP_BOTTOM + 1e-6)
    // 帯にかからない自由配置は動かさない
    const high = telop('見出し', { customPosition: { x: 0.3, y: 0.2 } })
    expect(liftAboveShortsUi([high], canvas.h)[0]).toBe(high)
  })

  it('下の段を消した(段と見分けられない)テロップも、間隔を保って上げ、同じ高さに集めない', () => {
    const base = telop('今日はいい天気ですね')
    const [, b, c] = stackSimultaneousTelops(
      [
        { ...base, id: 'a', startTime: 0, endTime: 2 },
        { ...base, id: 'b', startTime: 1, endTime: 4 },
        { ...base, id: 'c', startTime: 1.5, endTime: 4 }
      ],
      canvas.h
    )
    const rects = liftAboveShortsUi([b, c], canvas.h).map(rect)
    expect(rects[0][0] < rects[1][1] - 1e-6 && rects[1][0] < rects[0][1] - 1e-6).toBe(false)
    for (const r of rects) expect(r[1]).toBeLessThanOrEqual(SHORTS_TELOP_BOTTOM + 1e-6)
  })
})

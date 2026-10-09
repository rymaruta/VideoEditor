import { describe, expect, it } from 'vitest'
import { liftAboveShortsUi, SHORTS_TELOP_BOTTOM } from '@shared/telop/stack'
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
    const stacked = telop('上の段', { customPosition: { x: 0.5, y: 0.83 } })
    const top = telop('見出し', { position: 'top' })
    const center = telop('真ん中', { position: 'center' })
    const out = liftAboveShortsUi([stacked, top, center], 1920)
    expect(out[0].style.customPosition!.y).toBeCloseTo(0.83 - (0.92 - SHORTS_TELOP_BOTTOM), 6)
    expect(out[1]).toBe(top)
    expect(out[2]).toBe(center)
  })
})

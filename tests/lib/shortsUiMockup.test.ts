import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  SHORTS_TELOP_BOTTOM,
  SHORTS_UI_BAND_BOTTOM,
  SHORTS_UI_BAND_TOP,
  SHORTS_UI_RAIL
} from '@shared/telop/stack'
import {
  SHORTS_SAFE_BOTTOM_RATIO,
  shortsUiMockupLayout
} from '../../src/renderer/src/lib/shortsSafeArea'

/**
 * プレビューに重ねる「YouTube Shorts の実際の画面イメージ」は、プレビューの大きさに比例し、
 * 帯・右の列を実際の比率(書き出しで上げる位置と同じ定数)で置く。
 * (固定の px で描いていたため、高さ 366px のプレビューではチャンネル名が 73%・説明文が 80〜86% に来て、
 *  帯より上へ上げた発言テロップ(下端 82%)が説明文に重なって見えていた)
 */
describe('Shorts の画面イメージ', () => {
  it('帯・右の列の位置は、書き出しで使う定数から作る', () => {
    const l = shortsUiMockupLayout()
    expect(l.band.top).toBe(`${SHORTS_UI_BAND_TOP * 100}%`)
    expect(parseFloat(l.band.height)).toBeCloseTo(
      (SHORTS_UI_BAND_BOTTOM - SHORTS_UI_BAND_TOP) * 100,
      6
    )
    expect(parseFloat(l.rail.left)).toBeCloseTo(SHORTS_UI_RAIL.left * 100, 6)
    expect(parseFloat(l.rail.top)).toBeCloseTo(SHORTS_UI_RAIL.top * 100, 6)
    expect(parseFloat(l.rail.height)).toBeCloseTo(
      (SHORTS_UI_RAIL.bottom - SHORTS_UI_RAIL.top) * 100,
      6
    )
    // 書き出しで上げた発言テロップの下端は、帯の上端より上(イメージで重なって見えない)
    expect(SHORTS_TELOP_BOTTOM).toBeLessThan(SHORTS_UI_BAND_TOP)
    expect(SHORTS_SAFE_BOTTOM_RATIO).toBe(SHORTS_UI_BAND_TOP)
  })

  it('画面イメージの文字・間隔・アイコンは固定の px ではなく、プレビューの高さに比例する', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/src/assets/main.css'), 'utf8')
    const rules = [...css.matchAll(/(\.shorts-ui-[^{]*)\{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(5)
    const sized =
      /(font-size|gap|width|height|padding|margin-left|top|left|right|bottom)\s*:\s*[^;]*\d+(\.\d+)?px/
    const fixed = rules
      .filter(([, sel, body]) => {
        // 進捗の線(高さ 2px)と枠線は、大きさに比例させなくてよい
        if (sel.includes('shorts-ui-progress')) return false
        return sized.test(body.replace(/border[^;]*;/g, ''))
      })
      .map(([, sel]) => sel.trim())
    expect(fixed).toEqual([])
    expect(css).toMatch(/\.shorts-ui-mockup\s*\{[^}]*container-type:\s*size/)
  })
})

import { describe, expect, it } from 'vitest'
import {
  TITLE_BAR_HEIGHT,
  TITLE_BAR_OVERLAY_COLOR,
  TITLE_BAR_SYMBOL_COLOR,
  menuPopupPosition,
  needsMenuButton,
  windowChromeOptions
} from '@shared/windowChrome'

describe('windowChromeOptions(窓の枠をプラットフォームごとに)', () => {
  it.each(['win32', 'linux'])('%s: タイトルバーを隠し、閉じる等のボタンを帯の高さで重ねる', (p) => {
    const o = windowChromeOptions(p)
    expect(o.titleBarStyle).toBe('hidden')
    expect(o.titleBarOverlay).toEqual({
      color: TITLE_BAR_OVERLAY_COLOR,
      symbolColor: TITLE_BAR_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT
    })
    // Alt で OS のメニューバーを出さない(Alt は帯のメニューボタンへ)
    expect(o.autoHideMenuBar).toBe(false)
    expect(o.trafficLightPosition).toBeUndefined()
  })
  it('macOS: 信号のボタンを帯の左に重ね、重ねるボタンは使わない', () => {
    const o = windowChromeOptions('darwin')
    expect(o.titleBarStyle).toBe('hiddenInset')
    expect(o.titleBarOverlay).toBeUndefined()
    expect(o.trafficLightPosition).toEqual({ x: 14, y: 15 })
  })
  it.each(['win32', 'linux', 'darwin'])('%s: 窓の最小の大きさは 960×600', (p) => {
    const o = windowChromeOptions(p)
    expect([o.minWidth, o.minHeight]).toEqual([960, 600])
  })
  it('帯の高さはデザイン案の上の帯と同じ 44px(tokens.css の --ve-bar-workflow)', () => {
    expect(TITLE_BAR_HEIGHT).toBe(44)
  })
  it('記号の色は地の色に対して 4.5:1 以上', () => {
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]
    }
    const a = lum(TITLE_BAR_SYMBOL_COLOR)
    const b = lum(TITLE_BAR_OVERLAY_COLOR)
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThan(4.5)
  })
})

describe('needsMenuButton', () => {
  it('Windows・Linux は帯にメニューボタンを置く。macOS は画面の上のメニュー', () => {
    expect(needsMenuButton('win32')).toBe(true)
    expect(needsMenuButton('linux')).toBe(true)
    expect(needsMenuButton('darwin')).toBe(false)
  })
})

describe('menuPopupPosition', () => {
  it('整数に丸める', () => {
    expect(menuPopupPosition({ x: 8.4, y: 44.6 })).toEqual({ x: 8, y: 45 })
  })
  it('おかしな値はマウスの位置(undefined)', () => {
    expect(menuPopupPosition(undefined)).toBeUndefined()
    expect(menuPopupPosition(null)).toBeUndefined()
    expect(menuPopupPosition({ x: '1', y: 2 })).toBeUndefined()
    expect(menuPopupPosition({ x: NaN, y: 2 })).toBeUndefined()
    expect(menuPopupPosition({ x: -1, y: 2 })).toBeUndefined()
    expect(menuPopupPosition({ x: 1, y: Infinity })).toBeUndefined()
  })
})

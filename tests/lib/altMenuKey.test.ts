import { describe, expect, it } from 'vitest'
import { createAltTapDetector } from '@renderer/lib/altMenuKey'

describe('createAltTapDetector(Alt の単独押しでメニューボタンへ)', () => {
  it('Alt を押して離しただけなら true', () => {
    const d = createAltTapDetector()
    d.keydown({ key: 'Alt' })
    expect(d.keyup({ key: 'Alt' })).toBe(true)
  })
  it('押しっぱなしの繰り返しも単独押し', () => {
    const d = createAltTapDetector()
    d.keydown({ key: 'Alt' })
    d.keydown({ key: 'Alt', repeat: true })
    expect(d.keyup({ key: 'Alt' })).toBe(true)
  })
  it('Alt+キーは単独押しではない', () => {
    const d = createAltTapDetector()
    d.keydown({ key: 'Alt' })
    d.keydown({ key: 's' })
    expect(d.keyup({ key: 's' })).toBe(false)
    expect(d.keyup({ key: 'Alt' })).toBe(false)
  })
  it('Alt+クリック(ドラッグ)・窓のフォーカスが外れたら単独押しではない', () => {
    const d = createAltTapDetector()
    d.keydown({ key: 'Alt' })
    d.cancel()
    expect(d.keyup({ key: 'Alt' })).toBe(false)
  })
  it('一度離したら次の Alt まで何もしない', () => {
    const d = createAltTapDetector()
    d.keydown({ key: 'Alt' })
    d.keyup({ key: 'Alt' })
    expect(d.keyup({ key: 'Alt' })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { createAltTapDetector, isComposingKey, menuMnemonicFor } from '@renderer/lib/altMenuKey'

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

describe('日本語入力の変換中は何もしない(変換の Alt・文字を奪わない)', () => {
  it('isComposing・keyCode 229 を変換中とみなす', () => {
    expect(isComposingKey({ isComposing: true })).toBe(true)
    expect(isComposingKey({ keyCode: 229 })).toBe(true)
    expect(isComposingKey({ isComposing: false, keyCode: 70 })).toBe(false)
  })
  it('変換中の Alt はメニューボタンへ移さない', () => {
    const d = createAltTapDetector()
    d.keydown({ key: 'Alt', isComposing: true })
    expect(d.keyup({ key: 'Alt' })).toBe(false)
    d.keydown({ key: 'Alt' })
    expect(d.keyup({ key: 'Alt', keyCode: 229 })).toBe(false)
  })
  it('変換中の Alt+F はメニューを開かない', () => {
    const e = {
      key: 'f',
      code: 'KeyF',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false
    }
    expect(menuMnemonicFor(e, ['F'])).toBe('F')
    expect(menuMnemonicFor({ ...e, isComposing: true }, ['F'])).toBeNull()
    expect(menuMnemonicFor({ ...e, keyCode: 229 }, ['F'])).toBeNull()
  })
})

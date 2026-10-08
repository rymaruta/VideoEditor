import { describe, expect, it } from 'vitest'
import { playheadFromElement } from '../../src/renderer/src/lib/previewPlayhead'

describe('playheadFromElement — 再生中の再生位置', () => {
  it('別のファイルを読み込み直している間は動かさない(負の時刻へ飛ばない)', () => {
    expect(playheadFromElement({ start: 10, inPoint: 1800, speed: 1 }, 0, true)).toBeNull()
  })
  it('読み込み終わっていれば、要素の位置からタイムラインの位置を出す', () => {
    expect(playheadFromElement({ start: 10, inPoint: 1800, speed: 2 }, 1804, false)).toBe(12)
  })
})

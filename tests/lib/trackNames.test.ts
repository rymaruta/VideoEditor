import { describe, expect, it } from 'vitest'
import { nextTrackName } from '@renderer/lib/trackNames'

describe('nextTrackName', () => {
  it('間のトラックを消した後も、残っている名前と重ならない', () => {
    // 音声トラック 1・2 のうち 1 を消した(1本残り) → 数から付けると「音声トラック 2」が2つ
    expect(nextTrackName('音声トラック', ['音声トラック 2'], 2)).toBe('音声トラック 3')
    expect(nextTrackName('音声トラック', [], 1)).toBe('音声トラック 1')
  })
})

import { describe, expect, it } from 'vitest'
import {
  NEW_AUDIO_TRACK_PREFIX,
  NEW_VIDEO_TRACK_PREFIX,
  nextTrackName
} from '@renderer/lib/trackNames'

describe('nextTrackName', () => {
  it('間のトラックを消した後も、残っている名前と重ならない', () => {
    // 音声トラック 1・2 のうち 1 を消した(1本残り) → 数から付けると「音声トラック 2」が2つ
    expect(nextTrackName('音声トラック', ['音声トラック 2'], 2)).toBe('音声トラック 3')
    expect(nextTrackName('音声トラック', [], 1)).toBe('音声トラック 1')
  })
})

describe('新しく作るトラックの既定の名前', () => {
  it('短い名前(「動画 2」「音声 4」)。見出しの名前の欄で省かれない長さ', () => {
    expect(nextTrackName(NEW_VIDEO_TRACK_PREFIX, [], 2)).toBe('動画 2')
    expect(nextTrackName(NEW_AUDIO_TRACK_PREFIX, ['音声 4'], 4)).toBe('音声 5')
    for (const prefix of [NEW_VIDEO_TRACK_PREFIX, NEW_AUDIO_TRACK_PREFIX])
      expect(nextTrackName(prefix, [], 12).length).toBeLessThanOrEqual(5)
  })
})

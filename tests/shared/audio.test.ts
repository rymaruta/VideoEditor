import { describe, expect, it } from 'vitest'
import {
  MEDIA_ELEMENT_MAX_VOLUME,
  audioClipGain,
  needsWebAudioGain,
  toElementVolume
} from '@shared/audioGain'
import {
  MONO_UPMIX_GAIN,
  isMonoChannelCount,
  isMultiChannelCount,
  monoUpmixFilter,
  multiChannelDownmixFilter
} from '@shared/audioUpmix'
import { NASTY_NUMBERS, NASTY_VALUES, round } from '../helpers/boundary'

describe('audioClipGain — トラック音量 × クリップ音量', () => {
  it('掛け算になる', () => {
    expect(audioClipGain(1, 1)).toBe(1)
    expect(audioClipGain(0.5, 0.5)).toBe(0.25)
    expect(audioClipGain(2, 1.5)).toBe(3)
  })

  it('クリップ音量が未設定なら 1 として扱う', () => {
    expect(audioClipGain(0.8, undefined)).toBe(0.8)
  })

  it('負・NaN・Infinity は「指定なし＝等倍」に倒す(黙って無音にしない)', () => {
    for (const bad of [NaN, Infinity, -Infinity, -1, -0.5]) {
      expect(audioClipGain(bad, 2), String(bad)).toBe(2)
      expect(audioClipGain(2, bad), String(bad)).toBe(2)
    }
  })

  it('【不変条件】0 以上を返す(どんな入力でも)', () => {
    for (const a of NASTY_NUMBERS) {
      for (const b of NASTY_NUMBERS) {
        const g = audioClipGain(a, b)
        expect(Number.isNaN(g), `${a} * ${b} -> ${g}`).toBe(false)
        expect(g).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('UIのつまみの範囲(0〜3)では必ず有限', () => {
    for (let a = 0; a <= 3; a += 0.25) {
      for (let b = 0; b <= 3; b += 0.25) {
        const g = audioClipGain(a, b)
        expect(Number.isFinite(g)).toBe(true)
        expect(g).toBeLessThanOrEqual(9 + 1e-9)
      }
    }
  })

  it('【既知の穴】片方ずつは有限でも、掛けた結果は Infinity になりうる', () => {
    // 個々の値は `sanitizeFactor` を通るが、**積は見ていない**。
    // 手で書き換えた `.veproj`(読み込みは有限性しか見ず、上限を持たない)なら
    // ここへ 1e308 を通せて、書き出しに `volume=Infinity` が渡る。
    // つまみからは 0〜3 しか来ないので実用上は届かない。BACKLOG の候補に積んである。
    // **直したらこのテストが落ちる**ので、そのとき期待値を書き換えること。
    expect(audioClipGain(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Infinity)
  })
})

describe('toElementVolume — <video>/<audio> の volume に入れる値', () => {
  it('0〜1 に収める', () => {
    expect(toElementVolume(-1)).toBe(0)
    expect(toElementVolume(0)).toBe(0)
    expect(toElementVolume(0.5)).toBe(0.5)
    expect(toElementVolume(1)).toBe(1)
    expect(toElementVolume(3)).toBe(MEDIA_ELEMENT_MAX_VOLUME)
  })

  it('NaN は 0(要素に NaN を入れると例外になる)', () => {
    expect(toElementVolume(NaN)).toBe(0)
  })

  it('【不変条件】必ず 0〜1 の有限値', () => {
    for (const v of NASTY_NUMBERS) {
      const r = toElementVolume(v)
      expect(Number.isFinite(r), `${v} -> ${r}`).toBe(true)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
    }
  })
})

describe('needsWebAudioGain — 1 を超える倍率は要素だけでは出せない', () => {
  it('1 以下なら要素の volume で足りる', () => {
    expect(needsWebAudioGain(0)).toBe(false)
    expect(needsWebAudioGain(1)).toBe(false)
  })
  it('1 を超えたら GainNode が要る', () => {
    expect(needsWebAudioGain(1.0001)).toBe(true)
    expect(needsWebAudioGain(4)).toBe(true)
  })
  it('NaN・Infinity で true を返さない(付け替えは戻せないため)', () => {
    expect(needsWebAudioGain(NaN)).toBe(false)
    expect(needsWebAudioGain(Infinity)).toBe(false)
    expect(needsWebAudioGain(-Infinity)).toBe(false)
  })
})

describe('モノラル/多チャンネルの判定と補正', () => {
  it('1ch だけがモノラル', () => {
    expect(isMonoChannelCount(1)).toBe(true)
    for (const v of [0, 2, 3, 6, -1, 1.5]) expect(isMonoChannelCount(v)).toBe(false)
  })

  it('3ch 以上が多チャンネル', () => {
    for (const v of [3, 6, 8]) expect(isMultiChannelCount(v)).toBe(true)
    for (const v of [0, 1, 2, -3, 2.5]) expect(isMultiChannelCount(v)).toBe(false)
  })

  it('数でない値(ffprobe が答えなかった)はどちらでもない', () => {
    for (const v of NASTY_VALUES) {
      expect(isMonoChannelCount(v), String(v)).toBe(false)
      expect(isMultiChannelCount(v), String(v)).toBe(false)
    }
  })

  it('モノラルの持ち上げは √2(-3dB を打ち消す)', () => {
    expect(round(MONO_UPMIX_GAIN, 6)).toBe(round(Math.SQRT2, 6))
    expect(monoUpmixFilter(48000)).toContain('rematrix_volume=' + MONO_UPMIX_GAIN)
    expect(monoUpmixFilter(48000)).toContain('48000')
    expect(monoUpmixFilter()).not.toContain('undefined')
  })

  it('多チャンネルの畳み込みは正規化を明示して戻す', () => {
    expect(multiChannelDownmixFilter(48000)).toContain('rematrix_maxval=1.0')
    expect(multiChannelDownmixFilter()).not.toContain('undefined')
  })

  it('どちらのフィルタも fltp / stereo を必ず含む(交渉の余地を残さない)', () => {
    for (const f of [monoUpmixFilter(48000), multiChannelDownmixFilter(48000)]) {
      expect(f).toContain('osf=fltp')
      expect(f).toContain('ochl=stereo')
    }
  })
})

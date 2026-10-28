import { describe, expect, it } from 'vitest'
import { withExtension, withMp4Extension } from '@main/partialOutput'
import { finalAudioCodecArgs, finalMuxArgs, proresEncodeArgs } from '@main/segmentRenderer'
import { OUTPUT_AUDIO_CODEC_ARGS } from '@shared/loudness'
import { EXPORT_FORMAT_EXT } from '@shared/types'

/** 書き出しの形式(MP4 / ProRes 422 の .mov / WAV)ごとの、拡張子と ffmpeg の引数 */
describe('形式ごとの拡張子', () => {
  it('その形式の拡張子で終わらせる(大文字の拡張子はそのまま・別の拡張子には足す)', () => {
    expect(withExtension('/o/a', 'mov')).toBe('/o/a.mov')
    expect(withExtension('/o/a.MOV', 'mov')).toBe('/o/a.MOV')
    expect(withExtension('/o/a.mp4', 'wav')).toBe('/o/a.mp4.wav')
    expect(withMp4Extension('/o/clip')).toBe('/o/clip.mp4')
    expect(EXPORT_FORMAT_EXT).toEqual({ mp4: 'mp4', prores: 'mov', wav: 'wav' })
  })
})

describe('区間ごとの書き出しの最後の引数', () => {
  const audio = ['-f', 'concat', '-safe', '0', '-i', '/w/audio.txt']

  it('MP4: 区間の映像はそのまま連結し、音は AAC', () => {
    const args = finalMuxArgs('mp4', '/w/video.txt', audio, [], '/o/a.mp4')
    expect(args).toContain('/w/video.txt')
    expect(args.join(' ')).toContain('-map 0:v -map 1:a -c:v copy')
    expect(args.join(' ')).toContain(OUTPUT_AUDIO_CODEC_ARGS.join(' '))
    expect(args[args.length - 1]).toBe('/o/a.mp4')
  })

  it('ProRes: 映像は連結のまま、音は PCM 24bit', () => {
    const args = finalMuxArgs('prores', '/w/video.txt', audio, [], '/o/a.mov').join(' ')
    expect(args).toContain('-c:v copy')
    expect(args).toContain('-c:a pcm_s24le')
    expect(args).not.toContain('aac')
  })

  it('WAV: 映像を読まず、音だけを PCM 24bit・48kHz で(4GiB を越えたら RF64)', () => {
    const args = finalMuxArgs('wav', '/w/video.txt', audio, ['-af', 'x'], '/o/a.wav')
    expect(args).not.toContain('/w/video.txt')
    expect(args.join(' ')).toContain('-map 0:a -af x -c:a pcm_s24le -ar 48000 -rf64 auto')
    expect(args.join(' ')).not.toMatch(/0:v|-c:v/)
  })

  it('音の形式: MP4 だけ AAC', () => {
    expect(finalAudioCodecArgs('mp4')).toEqual(OUTPUT_AUDIO_CODEC_ARGS)
    expect(finalAudioCodecArgs('prores')).toEqual(['-c:a', 'pcm_s24le'])
    expect(finalAudioCodecArgs('wav')).toEqual(['-c:a', 'pcm_s24le'])
  })

  it('ProRes の映像: prores_ks の 422(10bit 4:2:2)・区間で同じフレームレート', () => {
    const args = proresEncodeArgs('30000/1001').join(' ')
    expect(args).toContain('-c:v prores_ks -profile:v 2')
    expect(args).toContain('-pix_fmt yuv422p10le')
    expect(args).toContain('-r 30000/1001')
  })
})

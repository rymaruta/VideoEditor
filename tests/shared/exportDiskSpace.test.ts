import { describe, expect, it } from 'vitest'
import {
  LOW_DISK_RESERVE_BYTES,
  SEGMENT_AUDIO_BYTES_PER_SEC,
  chooseWorkLocation,
  estimateSegmentedExportBytes,
  formatBytes
} from '../../src/shared/exportDiskSpace'

const GB = 1024 ** 3

describe('estimateSegmentedExportBytes(区間ごとの書き出しに要るディスクの見込み)', () => {
  it('3時間・480p・標準: 一時ファイルは音の上限ぶん + 映像、出力は映像 + AAC', () => {
    const e = estimateSegmentedExportBytes({
      durationSec: 10800,
      width: 854,
      height: 480,
      fps: 30,
      quality: 'standard'
    })
    // 実測の出力は 450MB(映像 0.011 bit/画素 + AAC 192k)。見込みは少なめにして、止めるのは確実に足りないときだけ
    expect(e.output / 1e6).toBeGreaterThan(350)
    expect(e.output / 1e6).toBeLessThanOrEqual(450)
    expect(e.temp).toBeGreaterThan(10800 * SEGMENT_AUDIO_BYTES_PER_SEC)
    // 前は区間の WAV と full.wav で音だけ 8.3GB。いまの見込みはその半分ほど(上限で見ている)
    expect(e.temp / GB).toBeLessThan(5)
  })

  it('壊れた値でも NaN にしない', () => {
    const e = estimateSegmentedExportBytes({
      durationSec: NaN,
      width: 1920,
      height: 1080,
      fps: NaN,
      quality: 'high'
    })
    expect(e).toEqual({ temp: 0, output: 0 })
  })
})

describe('chooseWorkLocation(一時フォルダの置き場)', () => {
  const need = { temp: 4 * GB, output: 1 * GB }
  const R = LOW_DISK_RESERVE_BYTES

  it('同じドライブなら、一時ファイルと出力の合計が入るか見る', () => {
    expect(chooseWorkLocation({ need, baseFree: 6 * GB, outFree: 6 * GB, together: true })).toEqual(
      { where: 'base' }
    )
    const r = chooseWorkLocation({ need, baseFree: 5 * GB, outFree: 5 * GB, together: true })
    expect('error' in r && r.error).toMatch(
      /^ディスクの空きが足りないため、書き出しを始めませんでした。一時ファイルと書き出す動画で、このドライブに約 5\.5 GB 必要ですが、空きは 5\.0 GB です。/
    )
  })

  it('OS の一時フォルダが小さく、書き出し先のドライブが大きければ書き出し先に置く', () => {
    expect(
      chooseWorkLocation({ need, baseFree: 2 * GB, outFree: 100 * GB, together: false })
    ).toEqual({ where: 'output' })
    // 両方に入るなら OS の一時フォルダ
    expect(
      chooseWorkLocation({ need, baseFree: 4 * GB + R, outFree: 100 * GB, together: false })
    ).toEqual({ where: 'base' })
  })

  it('書き出し先に出力が入らなければ、そのドライブのことを言って止める', () => {
    const r = chooseWorkLocation({ need, baseFree: 100 * GB, outFree: 1 * GB, together: false })
    expect('error' in r && r.error).toMatch(
      /書き出し先のドライブに約 1\.5 GB 必要ですが、空きは 1\.0 GB/
    )
  })

  it('どちらにも一時ファイルが入らなければ止める', () => {
    const r = chooseWorkLocation({ need, baseFree: 2 * GB, outFree: 3 * GB, together: false })
    expect('error' in r).toBe(true)
  })

  it('空きが測れないドライブは足りるとみなす(止めない)', () => {
    expect(chooseWorkLocation({ need, baseFree: null, outFree: null, together: true })).toEqual({
      where: 'base'
    })
    expect(
      chooseWorkLocation({ need, baseFree: null, outFree: 0, together: false })
    ).toHaveProperty('error')
  })

  it('大きさの書き方', () => {
    expect(formatBytes(1.25 * GB)).toBe('1.3 GB')
    expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB')
    expect(formatBytes(0)).toBe('1 MB')
  })
})

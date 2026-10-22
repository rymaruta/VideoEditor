import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath, generateFrameDataUrl, generateThumbnailDataUrl } from '@main/ffmpegService'

/**
 * 【レグレッション 2026-10】静止画・MPEG-2 PS のサムネイル・フレームが取れなかった。
 *
 * - JPEG: 入力に `-ss` を付けると 0 枚(0 秒を頼んだときは `-ss 0` で取れていた)。写真がメディア一覧でサムネイル無しになり、静止画の
 *   クリップのフレーム取得(自動編集・サムネイル作り・AI に見せる絵)も失敗した
 * - PNG: 0 秒なら取れるが、0 より後は全部失敗(画像の長さ N/A を扱えず、そのまま `-ss` していた)
 * - MPEG-2 PS(開始時刻 0.53 秒): 終わりのサムネイルが取れない(6 秒の素材で `-ss 5.91` が 0 枚)
 */
const work = mkdtempSync(join(tmpdir(), 've-stillthumb-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

/** data URL の JPEG を1画素に縮めた色(取れた絵が正しい素材のものかを見る) */
function meanRgb(dataUrl: string): number[] {
  const jpg = join(work, `px-${Math.random().toString(36).slice(2)}.jpg`)
  writeFileSync(jpg, Buffer.from(dataUrl.split(',')[1], 'base64'))
  const out = execFileSync(ffmpegPath, [
    '-v',
    'error',
    '-i',
    jpg,
    '-vf',
    'scale=1:1:flags=area,format=rgb24',
    '-f',
    'rawvideo',
    '-'
  ])
  return [...out]
}

describe.skipIf(!existsSync(ffmpegPath))('静止画・MPEG-2 PS のサムネイルとフレーム', () => {
  it('JPEG・PNG はどの秒を頼んでも1枚目を返し、MPEG-2 PS は終わりでも取れる', async () => {
    const jpg = join(work, 'photo.jpg')
    const png = join(work, 'card.png')
    ff(['-f', 'lavfi', '-i', 'color=c=0xC03020:s=160x120:d=1', '-frames:v', '1', jpg])
    ff(['-f', 'lavfi', '-i', 'color=c=0x2040C0:s=160x120:d=1', '-frames:v', '1', png])
    const ps = join(work, 'ps.mpg')
    ff([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=176x144:r=50:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=d=6:sample_rate=48000',
      '-vf',
      'tinterlace=mode=interleave_top,setfield=tff',
      '-c:v',
      'mpeg2video',
      '-flags',
      '+ilme+ildct',
      '-b:v',
      '500k',
      '-c:a',
      'mp2',
      '-f',
      'mpeg',
      ps
    ])

    const failures: string[] = []
    const tryGet = async (label: string, run: () => Promise<string>): Promise<string> => {
      try {
        return await run()
      } catch (e) {
        failures.push(`${label}: ${(e as Error).message}`)
        return ''
      }
    }
    const jpg0 = await tryGet('jpg@0', () => generateThumbnailDataUrl(jpg, 0))
    const jpg5 = await tryGet('jpg@5', () => generateThumbnailDataUrl(jpg, 5))
    const png5 = await tryGet('png@5', () => generateThumbnailDataUrl(png, 5))
    const jpgFrame = await tryGet('jpg frame@2', () => generateFrameDataUrl(jpg, 2, 160, 90, true))
    const pngFrame = await tryGet('png frame@30', () =>
      generateFrameDataUrl(png, 30, 160, 90, true)
    )
    const psEnd = await tryGet('ps@6', () => generateThumbnailDataUrl(ps, 6))
    const psFrameEnd = await tryGet('ps frame@5.99', () => generateFrameDataUrl(ps, 5.99, 160, 90))
    // 修正前(実測): jpg@5・png@5・jpg frame・png frame・ps@6・ps frame が「指定した位置のフレームを取得できませんでした」
    expect(failures).toEqual([])
    // 取れた絵が素材の色(計器の確かめ: JPEG は赤・PNG は青)
    for (const url of [jpg0, jpg5, jpgFrame]) {
      const [r, , b] = meanRgb(url)
      expect(r).toBeGreaterThan(150)
      expect(b).toBeLessThan(80)
    }
    for (const url of [png5, pngFrame]) {
      const [r, , b] = meanRgb(url)
      expect(b).toBeGreaterThan(150)
      expect(r).toBeLessThan(80)
    }
    expect(psEnd.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(psFrameEnd.startsWith('data:image/jpeg;base64,')).toBe(true)
  }, 60_000)
})

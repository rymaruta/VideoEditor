import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendTelopLayerImages,
  beginTelopLayer,
  materializeTelopLayer,
  releaseAllTelopLayers,
  releaseTelopLayer,
  withTelopLayer
} from '@main/telopLayerStage'
import { cleanupStaleSegmentDirs } from '@main/segmentRenderer'

/**
 * 書き出しのテロップの層の画像を、届いた順にディスクへ書いておく置き場。
 * 書き出しには画像のパスだけが渡り、終わったら(成功・失敗・中止のどれでも)消える。
 */

const bytes = (n: number): Uint8Array => new Uint8Array([n, n, n])
const noScratch = (): string => {
  throw new Error('置き場に書いた層では、作業場へ書き直さない')
}

afterEach(() => releaseAllTelopLayers())

describe('telopLayerStage — 層の画像の置き場', () => {
  it('届いた画像を番号どおりに書き、書き出しにはパスだけを渡す', async () => {
    const id = beginTelopLayer(64, 36)
    await appendTelopLayerImages(id, 0, [bytes(0), bytes(1)])
    await appendTelopLayerImages(id, 2, [bytes(2)])
    const layer = materializeTelopLayer(
      {
        width: 64,
        height: 36,
        stagedId: id,
        imageCount: 3,
        runs: [{ startFrame: 0, endFrame: 5, image: 2 }]
      },
      noScratch
    )!
    expect(layer.imagePaths).toHaveLength(3)
    expect([...readFileSync(layer.imagePaths[2])]).toEqual([2, 2, 2])
    releaseTelopLayer(id)
    expect(existsSync(layer.imagePaths[0])).toBe(false)
  })

  it('届いていない画像・無い画像を指す区間・大きさの食い違いは書き出す前に止める', async () => {
    const id = beginTelopLayer(64, 36)
    await appendTelopLayerImages(id, 0, [bytes(0)])
    const base = { width: 64, height: 36, stagedId: id, runs: [] }
    expect(() => materializeTelopLayer({ ...base, imageCount: 2 }, noScratch)).toThrow(
      '届いていません'
    )
    expect(() =>
      materializeTelopLayer(
        { ...base, imageCount: 1, runs: [{ startFrame: 0, endFrame: 1, image: 1 }] },
        noScratch
      )
    ).toThrow('無い画像')
    expect(() => materializeTelopLayer({ ...base, width: 32, imageCount: 1 }, noScratch)).toThrow(
      '大きさ'
    )
  })

  it('知らない束・負の番号・画像でないものは受け取らない', async () => {
    await expect(appendTelopLayerImages('nope', 0, [bytes(0)])).rejects.toThrow('見つかりません')
    const id = beginTelopLayer(64, 36)
    await expect(appendTelopLayerImages(id, -1, [bytes(0)])).rejects.toThrow('番号')
    await expect(appendTelopLayerImages(id, 0, ['x' as unknown as Uint8Array])).rejects.toThrow(
      '正しくありません'
    )
    expect(() => beginTelopLayer(0, 10)).toThrow('大きさ')
  })

  it('次の書き出しを始めると、中止・失敗で残った束は片付く(使用中の束は残す)', async () => {
    const left = beginTelopLayer(64, 36)
    await appendTelopLayerImages(left, 0, [bytes(0)])
    const busy = beginTelopLayer(64, 36)
    await appendTelopLayerImages(busy, 0, [bytes(0)])
    const busyPath = materializeTelopLayer(
      { width: 64, height: 36, stagedId: busy, imageCount: 1, runs: [] },
      noScratch
    )!.imagePaths[0]
    let during = ''
    await withTelopLayer(
      { width: 64, height: 36, stagedId: busy, imageCount: 1, runs: [] },
      async () => {
        // 使用中に次の層を描き始めても、使っている束は消えない
        beginTelopLayer(64, 36)
        during = readFileSync(busyPath).toString('hex')
      }
    )
    expect(during).toBe('000000')
    // 書き出しが終わったら片付く
    expect(existsSync(busyPath)).toBe(false)
    expect(() =>
      materializeTelopLayer(
        { width: 64, height: 36, stagedId: left, imageCount: 1, runs: [] },
        noScratch
      )
    ).toThrow('見つかりません')
  })

  it('書き出しが失敗しても束は片付く', async () => {
    const id = beginTelopLayer(64, 36)
    await appendTelopLayerImages(id, 0, [bytes(0)])
    const layer = { width: 64, height: 36, stagedId: id, imageCount: 1, runs: [] }
    const path = materializeTelopLayer(layer, noScratch)!.imagePaths[0]
    await expect(
      withTelopLayer(layer, async () => {
        throw new Error('ffmpeg failed')
      })
    ).rejects.toThrow('ffmpeg failed')
    expect(existsSync(path)).toBe(false)
  })

  it('バイト列で渡された層(テスト・小さい層)は作業場へ書く', () => {
    const work = mkdtempSync(join(tmpdir(), 've-stage-test-'))
    try {
      const layer = materializeTelopLayer(
        { width: 4, height: 4, images: [bytes(7)], runs: [] },
        () => work
      )!
      expect(layer.imagePaths[0].startsWith(work)).toBe(true)
      expect([...readFileSync(layer.imagePaths[0])]).toEqual([7, 7, 7])
      expect(materializeTelopLayer({ width: 4, height: 4, images: [], runs: [] }, () => work)).toBe(
        null
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('cleanupStaleSegmentDirs — 前回の残りの一時フォルダを片付ける', () => {
  it('半日より古い作業場(区間・層の画像・波形)だけを消し、新しいもの・関係ないものは残す', () => {
    // 本物の一時フォルダは、並んで走っているテストや書き出しが使っているので触らない
    const base = mkdtempSync(join(tmpdir(), 've-cleanup-test-'))
    const make = (prefix: string): string => mkdtempSync(join(base, prefix))
    try {
      const oldSeg = make('ve-seg-')
      const oldTelop = make('ve-telop-')
      const oldWave = make('ve-wave-')
      const other = make('not-ours-')
      cleanupStaleSegmentDirs(Date.now() + 13 * 3600 * 1000, base)
      expect([oldSeg, oldTelop, oldWave].map(existsSync)).toEqual([false, false, false])
      expect(existsSync(other)).toBe(true)
      // いま動いている処理のもの(新しい)は消さない
      const fresh = make('ve-wave-')
      cleanupStaleSegmentDirs(Date.now(), base)
      expect(existsSync(fresh)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

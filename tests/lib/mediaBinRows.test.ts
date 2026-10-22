import { describe, expect, it } from 'vitest'
import { hasLetterboxInMain } from '../../src/renderer/src/lib/aspect'
import type { Clip, MediaAsset } from '@shared/types'

const asset = (id: string, width: number, height: number): MediaAsset =>
  ({
    id,
    fileName: `${id}.mp4`,
    filePath: `/m/${id}.mp4`,
    hasVideo: true,
    hasAudio: true,
    width,
    height,
    duration: 60,
    fps: 30
  }) as MediaAsset
const clip = (assetId: string, extra: Partial<Clip> = {}): Clip =>
  ({ id: `c-${assetId}`, assetId, inPoint: 0, outPoint: 10, speed: 1, ...extra }) as Clip

/** 素材一覧の「縦横比が違うため、書き出しで黒帯が入ります」は、本編(V1)に使っている素材だけ */
describe('素材一覧の黒帯の警告', () => {
  const game = asset('GAME', 1920, 1080)
  const webcam = asset('WEBCAM', 640, 480)

  it('ワイプにしか使わない 4:3 の顔カメラには出さない', () => {
    expect(hasLetterboxInMain(webcam, { aspectRatio: '16:9', clips: [clip('GAME')] })).toBe(false)
  })

  it('本編に置いた 4:3 の素材には出す(クロップ・ぼかし背景なら出さない)', () => {
    expect(hasLetterboxInMain(webcam, { aspectRatio: '16:9', clips: [clip('WEBCAM')] })).toBe(true)
    expect(
      hasLetterboxInMain(webcam, {
        aspectRatio: '16:9',
        clips: [clip('WEBCAM', { fillCrop: true })]
      })
    ).toBe(false)
    expect(
      hasLetterboxInMain(webcam, {
        aspectRatio: '16:9',
        clips: [clip('WEBCAM', { blurBackground: true })]
      })
    ).toBe(false)
  })

  it('縦横比が同じなら、本編に置いても出さない', () => {
    expect(hasLetterboxInMain(game, { aspectRatio: '16:9', clips: [clip('GAME')] })).toBe(false)
    expect(hasLetterboxInMain(game, { aspectRatio: '9:16', clips: [clip('GAME')] })).toBe(true)
  })
})

/** 素材一覧のファイル名は「…」を付けて省略し、全体はツールチップで見られる */
describe('素材一覧のファイル名', () => {
  it('名前は文字だけの箱に入れて省略記号を付け、title に全体名を持つ', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const tsx = readFileSync(
      resolve(__dirname, '../../src/renderer/src/components/MediaBin.tsx'),
      'utf8'
    )
    const css = readFileSync(resolve(__dirname, '../../src/renderer/src/assets/main.css'), 'utf8')
    // flex の箱の中の裸の文字には text-overflow が効かない(「GAME_0001.ı」と途中で切れていた)
    expect(tsx).toMatch(
      /<span className="media-name-text" title=\{asset\.fileName\}>\s*\{asset\.fileName\}/
    )
    const rule = css.match(/\.media-name-text\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    expect(rule).toMatch(/overflow:\s*hidden/)
    expect(rule).toMatch(/white-space:\s*nowrap/)
    expect(rule).toMatch(/min-width:\s*0/)
  })
})

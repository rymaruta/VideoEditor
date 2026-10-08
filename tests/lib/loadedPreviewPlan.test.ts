import { describe, expect, it } from 'vitest'
import { planLoadedAssetPreview } from '../../src/renderer/src/lib/canPreview'
import type { MediaAsset } from '@shared/types'

const asset = (extra: Partial<MediaAsset> = {}): MediaAsset =>
  ({
    id: 'a1',
    filePath: '/media/a.mp4',
    fileName: 'a.mp4',
    duration: 10,
    hasVideo: true,
    hasAudio: true,
    ...extra
  }) as MediaAsset

/** 再生できるファイルの一覧から、読み込ませてみる判定を作る */
const playable =
  (...paths: string[]) =>
  async (filePath: string): Promise<boolean> =>
    paths.includes(filePath)

const probeOf =
  (meta: { needsPreviewProxy: boolean; previewAudioNeedsFold?: boolean }) => async () =>
    meta

describe('planLoadedAssetPreview — 開いたプロジェクトの素材のプレビュー', () => {
  it('プロキシで再生できれば何もしない', async () => {
    const plan = await planLoadedAssetPreview(
      asset({ proxyPath: '/cache/a.mp4' }),
      playable('/cache/a.mp4'),
      probeOf({ needsPreviewProxy: true, previewAudioNeedsFold: true })
    )
    expect(plan).toEqual({ kind: 'ok' })
  })

  it('元ファイルで再生できてプロキシの実体が無いなら、プロキシの指定を外す', async () => {
    // 外さないと、プレビューは無いプロキシを読みにいって再生できないままだった
    const plan = await planLoadedAssetPreview(
      asset({ proxyPath: '/cache/gone.mp4' }),
      playable('/media/a.mp4'),
      probeOf({ needsPreviewProxy: false })
    )
    expect(plan).toEqual({ kind: 'clearProxy' })
  })

  it('元ファイルで再生できても、4.0 の音声は試聴用の素材を作る(取り込み・差し替えと同じ)', async () => {
    const plan = await planLoadedAssetPreview(
      asset(),
      playable('/media/a.mp4'),
      probeOf({ needsPreviewProxy: false, previewAudioNeedsFold: true })
    )
    expect(plan).toEqual({ kind: 'build', codecSaysUnplayable: false, audioNeedsFold: true })
  })

  it('音の無い素材・ステレオは、再生できれば何もしない(調べられなくても)', async () => {
    expect(
      await planLoadedAssetPreview(
        asset({ hasAudio: false }),
        playable('/media/a.mp4'),
        async () => {
          throw new Error('should not probe')
        }
      )
    ).toEqual({ kind: 'ok' })
    expect(
      await planLoadedAssetPreview(asset(), playable('/media/a.mp4'), async () => {
        throw new Error('gone')
      })
    ).toEqual({ kind: 'ok' })
  })

  it('再生できなければ、調べた結果でプロキシを作る・調べられなければ失敗を伝える', async () => {
    expect(
      await planLoadedAssetPreview(
        asset({ proxyPath: '/cache/gone.mp4' }),
        playable(),
        probeOf({ needsPreviewProxy: true })
      )
    ).toEqual({ kind: 'build', codecSaysUnplayable: true, audioNeedsFold: false })
    expect(
      await planLoadedAssetPreview(asset(), playable(), async () => {
        throw new Error('ENOENT')
      })
    ).toEqual({ kind: 'probeFailed' })
  })
})

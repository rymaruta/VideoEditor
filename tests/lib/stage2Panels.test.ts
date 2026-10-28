import { describe, expect, it } from 'vitest'
import { assetKind, countByKind, filterAssets } from '@renderer/lib/mediaFilter'
import { decisionForClip } from '@renderer/lib/clipDecision'
import {
  assetsNeedingLightProxy,
  lightProxyFor,
  useProgramView,
  zoomFrameWidth
} from '@renderer/lib/programView'
import { previewSourcePath } from '@renderer/lib/previewSource'
import type { MediaAsset } from '@shared/types'
import type { MulticamInfo } from '@shared/sync/multicam'

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  filePath: `/m/${id}`,
  fileName: id,
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true,
  ...extra
})

describe('素材の検索と種類の絞り込み', () => {
  const assets = [
    asset('Cam A 本編.mp4'),
    asset('BGM_夏.mp3', { hasVideo: false }),
    asset('タイトル.png', { hasAudio: false, still: true }),
    asset('logo.PNG', { hasAudio: false }),
    asset('ｃａｍ　Ｂ.mov')
  ]

  it('種類: 静止画・画像は画像、絵があれば動画、無ければ音声', () => {
    expect(assets.map(assetKind)).toEqual(['video', 'audio', 'image', 'image', 'video'])
    expect(countByKind(assets)).toEqual({ all: 5, video: 2, audio: 1, image: 2 })
  })

  it('語は大文字・小文字・全角を区別せず、空白で区切ると全部を含むもの', () => {
    expect(filterAssets(assets, 'cam', 'all').map((a) => a.id)).toEqual([
      'Cam A 本編.mp4',
      'ｃａｍ　Ｂ.mov'
    ])
    expect(filterAssets(assets, 'cam 本編', 'all').map((a) => a.id)).toEqual(['Cam A 本編.mp4'])
    expect(filterAssets(assets, '  ', 'all')).toHaveLength(5)
  })

  it('語と種類を合わせて絞る', () => {
    expect(filterAssets(assets, 'png', 'image')).toHaveLength(2)
    expect(filterAssets(assets, 'png', 'video')).toHaveLength(0)
    expect(filterAssets(assets, '', 'audio').map((a) => a.id)).toEqual(['BGM_夏.mp3'])
  })
})

describe('AI の判断(クリップの判断のまとめ)', () => {
  const info: MulticamInfo = {
    anchorSourceId: 'cam1',
    sources: [
      {
        id: 'cam1',
        name: 'カメラ1',
        kind: 'camera',
        subject: 'Aさん'
      } as MulticamInfo['sources'][0]
    ],
    files: [{ assetId: 'a', sourceId: 'cam1', start: 100, rate: 1, duration: 60 }]
  }
  const scenes = [
    { id: 's1', start: 100, end: 120, lines: [], speech: 10 },
    { id: 's2', start: 120, end: 150, lines: [], speech: 20 },
    { id: 's3', start: 150, end: 160, lines: [], speech: 5 }
  ]
  const judgements = [
    {
      sceneId: 's1',
      score: 82,
      kind: 'highlight' as const,
      title: '最初の山',
      reason: '笑いが2回'
    },
    { sceneId: 's2', score: 40, kind: 'normal' as const, reason: '説明が続く' }
  ]

  it('クリップが映す収録の時刻に重なる場面の判定・カメラ・手の判断を出す', () => {
    // 素材の 5〜25 秒 = 共通の時刻 105〜125(s1 と s2 に重なる)
    const d = decisionForClip(
      { assetId: 'a', inPoint: 5, outPoint: 25 },
      {
        multicam: info,
        cutOverrides: {
          removed: [],
          added: [{ start: 110, end: 112 }],
          angles: [{ start: 100, end: 130, cameraId: 'cam1' }]
        },
        autoEditLocks: [{ id: 'l', start: 0, end: 50 }]
      },
      { scenes, judgements, keep: { s2: true }, judgeSource: 'ai' }
    )
    expect(d?.scenes.map((s) => [s.id, s.kind, s.score, s.keep])).toEqual([
      ['s1', 'highlight', 82, undefined],
      ['s2', 'normal', 40, true]
    ])
    expect(d?.scenes[0].reason).toBe('笑いが2回')
    expect(d?.camera).toEqual({ name: 'カメラ1', subject: 'Aさん' })
    expect(d?.manualAngle).toBe(true)
    expect(d?.manualAdded).toBe(true)
    expect(d?.locked).toBe(false)
    expect(d?.judgeSource).toBe('ai')
  })

  it('同期した収録素材でない企画・クリップには判断が無い', () => {
    expect(
      decisionForClip(
        { assetId: 'a', inPoint: 0, outPoint: 5 },
        {},
        {
          scenes,
          judgements,
          keep: {},
          judgeSource: null
        }
      )
    ).toBeNull()
    expect(
      decisionForClip(
        { assetId: 'other', inPoint: 0, outPoint: 5 },
        { multicam: info },
        {
          scenes,
          judgements,
          keep: {},
          judgeSource: null
        }
      )
    ).toBeNull()
  })
})

describe('プログラムの表示の大きさと画質', () => {
  it('100% は企画の画の実寸(16:9 は幅 1920、9:16 は幅 1080)。全体を表示は枠に収める', () => {
    expect(zoomFrameWidth('fit', '16:9')).toBeNull()
    expect(zoomFrameWidth(1, '16:9')).toBe(1920)
    expect(zoomFrameWidth(0.5, '16:9')).toBe(960)
    expect(zoomFrameWidth(0.25, '9:16')).toBe(270)
  })

  it('軽い版を作るのは動画だけ(静止画・音声だけ・もうあるもの・同じファイルは除く)', () => {
    const list = [
      asset('v1'),
      asset('v1dup', { filePath: '/m/v1' }),
      asset('hevc', { proxyPath: '/p/hevc.mp4' }),
      asset('still', { still: true }),
      asset('mp3', { hasVideo: false }),
      asset('done')
    ]
    expect(assetsNeedingLightProxy(list, { '/m/done': '/p/done.mp4' }).map((a) => a.id)).toEqual([
      'v1'
    ])
  })

  it('画質「軽い」のときだけ、作った軽い版で再生する', () => {
    const a = asset('v1')
    useProgramView.setState({ quality: 'full', lightProxies: { '/m/v1': '/p/v1.mp4' } })
    expect(lightProxyFor('/m/v1')).toBeUndefined()
    expect(previewSourcePath(a)).toBe('/m/v1')
    useProgramView.setState({ quality: 'light' })
    expect(previewSourcePath(a)).toBe('/p/v1.mp4')
    // 静止画は元の画像のまま
    expect(previewSourcePath(asset('v1', { still: true }))).toBe('/m/v1')
    useProgramView.setState({ quality: 'full', lightProxies: {} })
  })
})

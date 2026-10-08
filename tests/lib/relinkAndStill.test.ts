import { afterEach, describe, expect, it, vi } from 'vitest'
import { relinkRefusal } from '@renderer/lib/relinkCheck'
import { stillAssetFrom } from '@renderer/lib/stillAsset'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

const project = {
  clips: [{ id: 'c', assetId: 'main', inPoint: 10, outPoint: 13, speed: 1 }],
  videoOverlayTracks: [
    {
      id: 't',
      clips: [{ id: 'o', assetId: 'pip', startTime: 0, inPoint: 0, outPoint: 3 }]
    }
  ]
} as unknown as Project

describe('relinkRefusal — つなぎ直せない組み合わせ', () => {
  it('本編・ワイプの映像を、音声だけのファイルにはつなぎ直せない', () => {
    expect(relinkRefusal(project, 'main', '/a.mp3', { hasVideo: false })).toMatch('映像')
    expect(relinkRefusal(project, 'pip', '/a.wav', { hasVideo: false })).toMatch('映像')
  })
  it('本編の素材は静止画にはつなぎ直せない(ワイプは静止画でよい)', () => {
    expect(relinkRefusal(project, 'main', '/a.png', { hasVideo: true })).toMatch('静止画')
    expect(relinkRefusal(project, 'pip', '/a.png', { hasVideo: true })).toBeNull()
  })
  it('音だけで使っている素材・映像のあるファイルへはつなぎ直せる', () => {
    expect(relinkRefusal(project, 'bgm', '/a.mp3', { hasVideo: false })).toBeNull()
    expect(relinkRefusal(project, 'main', '/b.mp4', { hasVideo: true })).toBeNull()
  })
  it('同期したカメラは、本編に無くても静止画・音声だけのファイルにはつなぎ直せない', () => {
    const mc = {
      ...project,
      multicam: {
        anchorSourceId: 'A',
        sources: [
          { id: 'A', name: 'A', kind: 'camera' },
          { id: 'B', name: 'B', kind: 'camera' },
          { id: 'M', name: 'M', kind: 'mic' }
        ],
        files: [
          { assetId: 'camB', sourceId: 'B', start: 0, rate: 1, duration: 60 },
          { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 60 }
        ]
      }
    } as unknown as Project
    expect(relinkRefusal(mc, 'camB', '/x/b.png', { hasVideo: true })).toMatch('静止画')
    expect(relinkRefusal(mc, 'camB', '/x/b.wav', { hasVideo: false })).toMatch('映像')
    expect(relinkRefusal(mc, 'micM', '/x/m.wav', { hasVideo: false, hasAudio: true })).toBeNull()
  })
  it('音声トラックで鳴らしている素材は、音の無いファイル・静止画にはつなぎ直せない', () => {
    const withAudio = {
      ...project,
      audioTracks: [
        { id: 'a', clips: [{ id: 'b', assetId: 'bgm', startTime: 0, inPoint: 0, outPoint: 5 }] }
      ]
    } as unknown as Project
    expect(relinkRefusal(withAudio, 'bgm', '/x/a.png', { hasVideo: true })).toMatch('音')
    expect(
      relinkRefusal(withAudio, 'bgm', '/x/v.mp4', { hasVideo: true, hasAudio: false })
    ).toMatch('音')
    expect(
      relinkRefusal(withAudio, 'bgm', '/x/a.mp3', { hasVideo: false, hasAudio: true })
    ).toBeNull()
  })
  it('ストアも、つなぎ直せない組み合わせでは素材を変えない', () => {
    const asset = {
      id: 'main',
      filePath: '/v.mp4',
      fileName: 'v.mp4',
      duration: 60,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    }
    useProjectStore.setState({
      project: {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [asset],
        clips: [{ id: 'c', assetId: 'main', inPoint: 0, outPoint: 3, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      } as unknown as Project,
      past: [],
      future: []
    })
    useProjectStore
      .getState()
      .relinkAsset(
        'main',
        '/a.mp3',
        'a.mp3',
        { duration: 60, width: 0, height: 0, fps: 0, hasAudio: true, hasVideo: false },
        undefined
      )
    expect(useProjectStore.getState().project.assets[0].filePath).toBe('/v.mp4')
    expect(useProjectStore.getState().past).toHaveLength(0)
  })
})

describe('stillAssetFrom — 静止画の取り込み', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stubApi = (probe: unknown): void => {
    vi.stubGlobal('window', {
      api: {
        probeMedia: async () => {
          if (probe instanceof Error) throw probe
          return probe
        },
        generateThumbnail: async () => 'data:'
      }
    })
  }
  it('大きさの測れない画像(動く WebP・壊れた画像)は取り込まない', async () => {
    stubApi({ width: 0, height: 0 })
    await expect(stillAssetFrom('/x/sticker.webp')).rejects.toThrow('静止画として読めません')
    stubApi(new Error('broken'))
    await expect(stillAssetFrom('/x/trunc.png')).rejects.toThrow('静止画として読めません')
  })
  it('読める画像は、測った大きさの静止画になる', async () => {
    stubApi({ width: 640, height: 360 })
    expect(await stillAssetFrom('/x/cg.png')).toMatchObject({
      width: 640,
      height: 360,
      still: true,
      fps: 30
    })
  })
})

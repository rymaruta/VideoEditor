import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import { assetLockReason } from '@renderer/lib/trackLock'
import type { AudioTrack, MediaAsset, Project, VideoOverlayTrack } from '@shared/types'

/**
 * f278005 の再監査(zRefs)を期待値付きで取り込んだもの。「中身だけ元に戻す」守りが、ほかのトラックと
 * ずれる・消えた素材を指す場面:
 * - 固定したトラックで使っている素材は消せない(参照を消す書き込みは丸ごと断る)
 * - 本編に紐づく分離した音声は、固定していても本編と一緒に消える・切れる
 * - 作り直しが入れ替える自動のトラックも、固定の印は残る
 * - 断られた addTextOverlay は null を返す
 */

const asset: MediaAsset = {
  id: 'a',
  filePath: '/x/a.mp4',
  fileName: 'a.mp4',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true
}
const wav: MediaAsset = {
  id: 'b',
  filePath: '/x/b.wav',
  fileName: 'b.wav',
  duration: 10,
  width: 0,
  height: 0,
  fps: 0,
  hasAudio: true,
  hasVideo: false
}

const audioTrack = (id: string, extra: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  name: id,
  muted: false,
  volume: 1,
  duckingEnabled: false,
  clips: [{ id: `${id}-c`, assetId: 'a', startTime: 0, inPoint: 0, outPoint: 4, volume: 1 }],
  ...extra
})

const overlayTrack = (id: string): VideoOverlayTrack =>
  ({
    id,
    name: id,
    hidden: false,
    position: 'bottom-right',
    scale: 0.3,
    clips: [{ id: `${id}-c`, assetId: 'a', startTime: 0, inPoint: 0, outPoint: 4 }]
  }) as VideoOverlayTrack

const project = (extra: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset, wav],
  clips: [
    { id: 'c1', assetId: 'a', inPoint: 0, outPoint: 4, speed: 1 },
    { id: 'c2', assetId: 'a', inPoint: 4, outPoint: 8, speed: 1 }
  ],
  audioTracks: [
    audioTrack('a1', {
      clips: [
        {
          id: 'a1-c',
          assetId: 'a',
          startTime: 4,
          inPoint: 4,
          outPoint: 8,
          volume: 1,
          linkedClipId: 'c2'
        }
      ]
    }),
    audioTrack('a2', {
      clips: [{ id: 'a2-c', assetId: 'b', startTime: 0, inPoint: 0, outPoint: 3, volume: 1 }]
    })
  ],
  videoOverlayTracks: [overlayTrack('v2')],
  textOverlays: [],
  ...extra
})

const s = useProjectStore.getState

beforeEach(() => {
  useProjectStore.setState({ project: project(), past: [], future: [], lockRefusal: null })
})

describe('固定と、ほかのトラックとのつながり', () => {
  it('本編のクリップを消すと、固定した音声トラックの紐づいた音声も一緒に消える', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
    s().removeClip('c2')
    expect(s().project.clips.map((c) => c.id)).toEqual(['c1'])
    expect(s().project.audioTracks[0].clips).toEqual([])
  })

  it('本編のクリップを分割すると、紐づいた音声も一緒に切れる', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
    s().splitClipAtTime('c2', 6)
    expect(s().project.clips).toHaveLength(3)
    expect(s().project.audioTracks[0].clips).toHaveLength(2)
  })

  it('固定したトラックで使っている素材は消せない(知らせる)。固定を外せば消せる', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'a2' })
    expect(assetLockReason(s().project, 'b')).toBe('固定したa2で使っています')
    s().removeAsset('b')
    expect(s().project.assets.map((a) => a.id)).toEqual(['a', 'b'])
    expect(s().project.audioTracks[1].clips.map((c) => c.assetId)).toEqual(['b'])
    expect(s().lockRefusal).toMatchObject({ names: ['a2'], partial: false })
    s().toggleTrackLocked({ kind: 'audio', id: 'a2' })
    expect(assetLockReason(s().project, 'b')).toBeNull()
    s().removeAsset('b')
    expect(s().project.assets.map((a) => a.id)).toEqual(['a'])
  })

  it('本編は固定していなくても、固定したワイプで使っている素材は消せない', () => {
    s().toggleTrackLocked({ kind: 'overlay', id: 'v2' })
    s().removeAsset('a')
    expect(s().project.assets).toHaveLength(2)
    expect(s().project.clips).toHaveLength(2)
    expect(s().project.videoOverlayTracks[0].clips).toHaveLength(1)
  })

  it('紐づいた音声だけに使っている素材は、固定の理由にしない(本編と一緒に消える)', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
    expect(assetLockReason(s().project, 'a')).toBeNull()
  })

  it('断られた addTextOverlay は null を返す', () => {
    s().toggleTrackLocked({ kind: 'telop' })
    expect(s().addTextOverlay({ text: 'x', startTime: 0, endTime: 1, style: {} as never })).toBe(
      null
    )
    s().toggleTrackLocked({ kind: 'telop' })
    expect(s().addTextOverlay({ text: 'x', startTime: 0, endTime: 1, style: {} as never })).toEqual(
      expect.any(String)
    )
  })

  it('作り直しが入れ替える自動の SE・BGM のトラックも、固定の印は残る(中身は変わる)', () => {
    const place = (outPoint: number): void =>
      s().setAutoSounds(
        [
          {
            role: 'bgm',
            clips: [{ path: '/x/b.wav', startTime: 0, inPoint: 0, outPoint, volume: 1 }]
          }
        ] as never,
        []
      )
    place(3)
    const first = s().project.audioTracks.find((t) => t.autoRole === 'bgm')!
    s().toggleTrackLocked({ kind: 'audio', id: first.id })
    place(5)
    const bgm = s().project.audioTracks.filter((t) => t.autoRole === 'bgm')
    expect(bgm).toHaveLength(1)
    expect(bgm[0].clips[0].outPoint).toBe(5)
    expect(bgm[0].locked).toBe(true)
  })
})

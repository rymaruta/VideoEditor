import { beforeEach, describe, expect, it } from 'vitest'
import { freezeLockedTracks, lockedTrackNames, useProjectStore } from '@renderer/store/projectStore'
import { rippleDeleteRange } from '@renderer/lib/editCommands'
import type { AudioTrack, MediaAsset, Project, VideoOverlayTrack } from '@shared/types'

/**
 * 第2段の監査(zLockLoop)を期待値付きで取り込んだもの: トラックの固定は、ストアの 1 か所
 * (`freezeLockedTracks`)で守る。どの経路から来た手の編集も、固定したトラックの中身を変えない。
 * 固定を外せば同じ操作が通る。選ぶ操作・トラックの設定(音量)は止めない
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

const telop = {
  text: 'あ',
  startTime: 0,
  endTime: 2,
  x: 50,
  y: 80,
  fontSize: 40,
  color: '#fff'
} as never

const project = (extra: Partial<Project> = {}): Project => ({
  id: 'p',
  name: 'p',
  aspectRatio: '16:9',
  assets: [asset],
  clips: [
    { id: 'c1', assetId: 'a', inPoint: 0, outPoint: 4, speed: 1 },
    { id: 'c2', assetId: 'a', inPoint: 4, outPoint: 8, speed: 1 }
  ],
  audioTracks: [audioTrack('a1'), audioTrack('a2')],
  videoOverlayTracks: [overlayTrack('v2')],
  textOverlays: [{ id: 't1', ...(telop as object) } as never],
  ...extra
})

const s = useProjectStore.getState

/** 手で行う編集の経路(監査の zLockLoop と同じ並び)。[名前, 操作, 見る所] */
const PATHS: [string, () => void, () => unknown][] = [
  ['updateClipTrim', () => s().updateClipTrim('c1', 1, 4), () => s().project.clips],
  ['updateClipSpeed', () => s().updateClipSpeed('c1', 2), () => s().project.clips],
  ['updateClipsSpeed', () => s().updateClipsSpeed(['c1'], 2), () => s().project.clips],
  [
    'updateClipTransition',
    () => s().updateClipTransition('c2', { type: 'crossfade', duration: 0.5 }),
    () => s().project.clips
  ],
  [
    'updateClipsColorLabel',
    () => s().updateClipsColorLabel(['c1'], 'red' as never),
    () => s().project.clips
  ],
  ['detachClipAudio', () => s().detachClipAudio('c1'), () => s().project.clips],
  [
    'updateClipCrop',
    () => s().updateClipCrop('c1', true, { x: 0.1, y: 0.4 }),
    () => s().project.clips
  ],
  ['moveClip', () => s().moveClip('c1', 'right'), () => s().project.clips],
  ['addClipToTimeline', () => s().addClipToTimeline('a'), () => s().project.clips],
  ['insertClipAtTime', () => s().insertClipAtTime('a', 0, 1, 2), () => s().project.clips],
  ['overwriteClipAtTime', () => s().overwriteClipAtTime('a', 0, 1, 2), () => s().project.clips],
  [
    'replaceClipRange',
    () =>
      s().replaceClipRange('c1', [
        { id: 'z', assetId: 'a', inPoint: 0, outPoint: 1, speed: 1 } as never
      ]),
    () => s().project.clips
  ],
  [
    'updateTextOverlay',
    () => s().updateTextOverlay('t1', { text: 'い' }),
    () => s().project.textOverlays
  ],
  ['addTextOverlay', () => s().addTextOverlay(telop), () => s().project.textOverlays],
  ['addTextOverlays', () => s().addTextOverlays([telop]), () => s().project.textOverlays],
  ['shiftAllTextOverlays', () => s().shiftAllTextOverlays(1), () => s().project.textOverlays],
  ['removeTextOverlay', () => s().removeTextOverlay('t1'), () => s().project.textOverlays],
  [
    'addClipToAudioTrack',
    () => s().addClipToAudioTrack('a1', 'a'),
    () => s().project.audioTracks[0].clips
  ],
  [
    'addAudioClipWithAsset',
    () => s().addAudioClipWithAsset(asset, { trackId: 'a1', trackName: 'a1', startTime: 6 }),
    () => s().project.audioTracks[0].clips
  ],
  [
    'updateAudioClipStart',
    () => s().updateAudioClipStart('a1', 'a1-c', 3),
    () => s().project.audioTracks[0].clips
  ],
  [
    'updateAudioClipVolume',
    () => s().updateAudioClipVolume('a1', 'a1-c', 0.5),
    () => s().project.audioTracks[0].clips
  ],
  [
    'removeAudioTrack',
    () => s().removeAudioTrack('a1'),
    () => s().project.audioTracks.map((t) => t.id)
  ],
  [
    'addClipToVideoOverlayTrack',
    () => s().addClipToVideoOverlayTrack('v2', 'a', 5),
    () => s().project.videoOverlayTracks[0].clips
  ],
  [
    'updateVideoOverlayClipStart',
    () => s().updateVideoOverlayClipStart('v2', 'v2-c', 3),
    () => s().project.videoOverlayTracks[0].clips
  ],
  [
    'removeVideoOverlayTrack',
    () => s().removeVideoOverlayTrack('v2'),
    () => s().project.videoOverlayTracks.map((t) => t.id)
  ]
]

const lockAll = (): void => {
  s().toggleTrackLocked({ kind: 'main' })
  s().toggleTrackLocked({ kind: 'telop' })
  s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
  s().toggleTrackLocked({ kind: 'overlay', id: 'v2' })
}

beforeEach(() => {
  useProjectStore.setState({
    project: project(),
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null
  })
})

describe('トラックの固定はストアの 1 か所で守る', () => {
  it.each(PATHS)('%s: 固定中は変わらず、履歴にも積まない', (_name, run, pick) => {
    lockAll()
    const before = JSON.stringify(pick())
    const past = s().past.length
    run()
    expect(JSON.stringify(pick())).toBe(before)
    expect(s().past.length).toBe(past)
  })

  it.each(PATHS)('%s: 固定を外せば通る', (_name, run, pick) => {
    const before = JSON.stringify(pick())
    run()
    expect(JSON.stringify(pick())).not.toBe(before)
  })

  it('選ぶ操作とトラックの設定(音量)は止めない', () => {
    lockAll()
    s().selectClip('c1')
    s().selectOverlay('t1')
    s().setAudioTrackVolume('a1', 0.5)
    expect(s().selectedOverlayId).toBe('t1')
    expect(s().project.audioTracks[0].volume).toBe(0.5)
  })

  it('本編のリップル: 固定したトラックで本編に紐づかないものは動かない', () => {
    const pr = project({
      textOverlays: [{ id: 't1', ...(telop as object), startTime: 6, endTime: 7 } as never]
    })
    pr.audioTracks[0].clips[0].startTime = 6
    pr.videoOverlayTracks[0].clips[0].startTime = 6
    useProjectStore.setState({ project: pr, past: [], future: [] })
    lockAll()
    s().toggleTrackLocked({ kind: 'main' })
    expect(rippleDeleteRange(1, 3)).toBe(true)
    const p = s().project
    expect(p.textOverlays[0].startTime).toBe(6)
    expect(p.audioTracks[0].clips[0].startTime).toBe(6)
    expect(p.videoOverlayTracks[0].clips[0].startTime).toBe(6)
  })

  it('本編のクリップに紐づくもの(分離した音声・追従テロップ)は、固定していても本編と一緒に動く(口と音・字をずらさない)', () => {
    const pr = project()
    pr.audioTracks = [
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
      })
    ]
    useProjectStore.setState({ project: pr, past: [], future: [] })
    s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
    expect(rippleDeleteRange(0, 2)).toBe(true)
    expect(s().project.audioTracks[0].clips[0].startTime).toBeCloseTo(2, 6)
  })

  it('全体の作り直しの印(__lockBypass)があれば固定を見ない。固定の名前を並べられる', () => {
    lockAll()
    const p = s().project
    const changed = { ...p, clips: p.clips.slice(1) }
    expect(freezeLockedTracks(p, changed)).toBeNull()
    expect(lockedTrackNames(p)).toEqual(['本編', 'テロップ', 'v2', 'a1'])
    useProjectStore.setState((st) => ({
      ...({ __historyPush: true, __lockBypass: true } as object),
      past: [...st.past, st.project],
      project: changed
    }))
    expect(s().project.clips.map((c) => c.id)).toEqual(['c2'])
  })
})

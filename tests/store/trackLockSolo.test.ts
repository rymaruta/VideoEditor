import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeLoadedProject, useProjectStore } from '@renderer/store/projectStore'
import {
  activeSoloIds,
  nonTrackAudioSilencedBySolo,
  trackSilencedInPreview
} from '@renderer/lib/monitorSolo'
import { rippleDeleteRange } from '@renderer/lib/editCommands'
import type { AudioTrack, MediaAsset, Project, VideoOverlayTrack } from '@shared/types'

/** 第2段: トラックの固定(鍵)と、音声トラックのソロ(モニター用) */

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

const overlayTrack = (id: string, extra: Partial<VideoOverlayTrack> = {}): VideoOverlayTrack =>
  ({
    id,
    name: id,
    hidden: false,
    position: 'bottom-right',
    scale: 0.3,
    clips: [{ id: `${id}-c`, assetId: 'a', startTime: 0, inPoint: 0, outPoint: 4 }],
    ...extra
  }) as VideoOverlayTrack

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
  textOverlays: [],
  ...extra
})

const s = useProjectStore.getState

beforeEach(() => {
  useProjectStore.setState({
    project: project(),
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    soloTrackIds: [],
    clipboardClips: []
  })
})

describe('トラックの固定(鍵)', () => {
  it('本編を固定すると選びが外れ、切る・削除・複製・並べ替え・貼り付けが効かない', () => {
    s().selectClip('c1')
    s().toggleTrackLocked({ kind: 'main' })
    expect(s().project.mainTrackLocked).toBe(true)
    expect(s().selectedClipId).toBeNull()
    const clips = s().project.clips
    s().splitClipAtTime('c1', 2)
    s().removeClips(['c1'])
    s().removeClip('c2')
    s().duplicateClips(['c1'])
    s().moveClipToIndex('c2', 0)
    useProjectStore.setState({ clipboardClips: [clips[0]] })
    s().pasteClip()
    expect(rippleDeleteRange(0, 2)).toBe(false)
    expect(s().project.clips).toBe(clips)
  })

  it('固定を外せば元どおり触れる。固定は取り消せる', () => {
    s().toggleTrackLocked({ kind: 'main' })
    s().undo()
    expect(s().project.mainTrackLocked).toBeFalsy()
    s().removeClips(['c1'])
    expect(s().project.clips.map((c) => c.id)).toEqual(['c2'])
  })

  it('音声トラックの固定: 切る・削除・別のトラックへの出し入れが効かない', () => {
    s().toggleTrackLocked({ kind: 'audio', id: 'a1' })
    expect(s().project.audioTracks[0].locked).toBe(true)
    const tracks = s().project.audioTracks
    s().splitAudioClipAtTime('a1', 'a1-c', 2)
    s().removeAudioClip('a1', 'a1-c')
    // 固定したトラックからも、固定したトラックへも動かさない
    s().moveAudioClipToTrack('a1', 'a1-c', 'a2', 0)
    s().moveAudioClipToTrack('a2', 'a2-c', 'a1', 0)
    expect(s().project.audioTracks).toBe(tracks)
    // 固定していないトラックは触れる
    s().removeAudioClip('a2', 'a2-c')
    expect(s().project.audioTracks[1].clips).toEqual([])
  })

  it('重ねる映像のトラックの固定: 切る・削除が効かない', () => {
    s().toggleTrackLocked({ kind: 'overlay', id: 'v2' })
    const tracks = s().project.videoOverlayTracks
    s().splitVideoOverlayClipAtTime('v2', 'v2-c', 2)
    s().removeVideoOverlayClip('v2', 'v2-c')
    expect(s().project.videoOverlayTracks).toBe(tracks)
  })

  it('テロップを固定すると、選んでいたテロップの選びが外れる', () => {
    useProjectStore.setState({ selectedOverlayId: 't1' })
    s().toggleTrackLocked({ kind: 'telop' })
    expect(s().project.telopTrackLocked).toBe(true)
    expect(s().selectedOverlayId).toBeNull()
    const id = s().addTextOverlay({
      text: 'x',
      startTime: 0,
      endTime: 1,
      style: s().project.textOverlays[0]?.style ?? ({} as never)
    })
    // addTextOverlay は固定に関係なく足せる(自動の作り直しの経路)。手で消すのは効かない
    s().removeTextOverlay(id)
    expect(s().project.textOverlays.some((o) => o.id === id)).toBe(true)
  })

  it('保存した固定は読み込みで残り、true 以外は捨てる', () => {
    const loaded = normalizeLoadedProject({
      ...project({ mainTrackLocked: true, telopTrackLocked: 'yes' as unknown as boolean }),
      audioTracks: [audioTrack('a1', { locked: true }), audioTrack('a2', { locked: 1 as never })]
    })
    expect(loaded.mainTrackLocked).toBe(true)
    expect(loaded.telopTrackLocked).toBeUndefined()
    expect(loaded.audioTracks[0].locked).toBe(true)
    expect(loaded.audioTracks[1].locked).toBeUndefined()
  })
})

describe('音声トラックのソロ(モニター用)', () => {
  const tracks = [
    { id: 'a1', muted: false },
    { id: 'a2', muted: false },
    { id: 'a3', muted: true }
  ]

  it('ソロが無ければミュートだけが効く', () => {
    expect(tracks.map((t) => trackSilencedInPreview(t, []))).toEqual([false, false, true])
    expect(nonTrackAudioSilencedBySolo([])).toBe(false)
  })

  it('ソロがあれば、ソロのトラックだけが鳴り、本編・ワイプの音も止める', () => {
    const solo = activeSoloIds(['a2'], tracks)
    expect(tracks.map((t) => trackSilencedInPreview(t, solo))).toEqual([true, false, true])
    expect(nonTrackAudioSilencedBySolo(solo)).toBe(true)
  })

  it('ミュートはソロより強い。消したトラックのソロは数えない', () => {
    expect(trackSilencedInPreview(tracks[2], activeSoloIds(['a3'], tracks))).toBe(true)
    expect(activeSoloIds(['gone'], tracks)).toEqual([])
  })

  it('ストアのソロは切り替えで足し引きし、企画も取り消しも変えない', () => {
    const before = s().project
    s().toggleAudioTrackSolo('a1')
    s().toggleAudioTrackSolo('a2')
    expect(s().soloTrackIds).toEqual(['a1', 'a2'])
    s().toggleAudioTrackSolo('a1')
    expect(s().soloTrackIds).toEqual(['a2'])
    expect(s().past).toEqual([])
    expect(s().project).toBe(before)
  })
})

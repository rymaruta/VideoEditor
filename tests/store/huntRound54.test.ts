import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginHistoryGesture,
  commitAsOwnStep,
  endHistoryGesture,
  useProjectStore
} from '@renderer/store/projectStore'
import { playableOnMain } from '@renderer/lib/relinkCheck'
import { audioClipDuration, buildTimedClips } from '@renderer/lib/timelineMath'
import type { MediaAsset, Project } from '@shared/types'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

function asset(id: string, duration: number, extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id,
    filePath: `/x/${id}`,
    fileName: id,
    duration,
    width: 1280,
    height: 720,
    fps: 30,
    hasAudio: true,
    hasVideo: true,
    ...extra
  }
}

function blank(extra: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    beatGrid: null,
    ...extra
  }
}

const SOURCES = [
  { id: 'A', name: 'カメラA', kind: 'camera' as const },
  { id: 'B', name: 'カメラB', kind: 'camera' as const },
  { id: 'M', name: '出演者A', kind: 'mic' as const }
]
const MULTICAM = {
  anchorSourceId: 'A',
  sources: SOURCES,
  files: [
    { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
    { assetId: 'camB', sourceId: 'B', start: 2, rate: 1, duration: 95 },
    { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
  ]
}

/** 収録(カメラ2台・ピンマイク1本)を、3区間の仮編集まで進めた状態 */
function recording(): void {
  S.setState({
    project: blank({
      assets: [asset('camA', 100), asset('camB', 100), asset('micM', 100, { hasVideo: false })],
      multicam: MULTICAM
    }),
    past: [],
    future: [],
    isDirty: false
  })
  const ranges: [number, number][] = [
    [0, 10],
    [20, 30],
    [40, 50]
  ]
  let t = 0
  const clips = ranges.map(([a, b]) => {
    const c = { assetId: 'micM', startTime: t, inPoint: a, outPoint: b, speed: 1 }
    t += b - a
    return c
  })
  st().applyRoughCut(
    {
      main: ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
      audio: [{ name: '出演者A', sourceId: 'M', volume: 1, clips }],
      duration: t,
      spans: []
    } as never,
    []
  )
}

/** 本編の各クリップの真ん中で、ピンマイクの声が映像と同じ収録の時刻を鳴らしているか */
function voiceOffsets(p: Project): number[] {
  const fileOf = new Map(p.multicam!.files.map((f) => [f.assetId, f]))
  const mic = p.audioTracks.find((t) => t.multicamSourceId === 'M')!
  return buildTimedClips(p).map((tc) => {
    const f = fileOf.get(tc.clip.assetId)!
    const t = tc.start + (tc.clip.outPoint - tc.clip.inPoint) / 2
    const common = f.start + (tc.clip.inPoint + (t - tc.start)) / f.rate
    const c = mic.clips.find(
      (x) => t >= x.startTime - 1e-6 && t <= x.startTime + audioClipDuration(x) + 1e-6
    )
    if (!c) return Number.NaN
    const g = fileOf.get(c.assetId)!
    return g.start + (c.inPoint + (t - c.startTime)) / g.rate - common
  })
}

describe('収録のカメラ素材をメディア一覧から消す', () => {
  it('本編が詰まったぶん、ピンマイクの声も一緒に詰まる(ずれない)', () => {
    recording()
    const second = st().project.clips[1]
    st().switchClipAngle(second.id, 'B')
    expect(st().project.clips[1].assetId).toBe('camB')
    expect(voiceOffsets(st().project).map((d) => Math.abs(d) < 1e-3)).toEqual([true, true, true])

    st().removeAsset('camB')

    const p = st().project
    expect(p.clips.map((c) => c.assetId)).toEqual(['camA', 'camA'])
    // 直す前: 3本目(収録の 40..50 秒)が 20 秒の所へ詰まるのに、声は 30 秒の所に残り 10 秒ずれていた
    expect(voiceOffsets(p).map((d) => Math.abs(d) < 1e-3)).toEqual([true, true])
    expect(p.multicam?.files.map((f) => f.assetId)).toEqual(['camA', 'micM'])
    // 1回の取り消しで消す前に戻る
    st().undo()
    expect(st().project.clips.map((c) => c.assetId)).toEqual(['camA', 'camB', 'camA'])
  })
})

describe('同期をやり直す(同じ収録を新しい素材で並べ直す)', () => {
  it('手置きのワイプに置いた前の収録素材は、同じファイルの新しい素材を指す', () => {
    recording()
    st().addVideoOverlayTrack('手置き')
    const pip = st().project.videoOverlayTracks.find((t) => t.name === '手置き')!
    st().addClipToVideoOverlayTrack(pip.id, 'camB', 1)
    st().detachClipAudio(st().project.clips[0].id)

    st().addMulticamTimeline(
      [
        asset('camA2', 100, { filePath: '/x/camA' }),
        asset('camB2', 100, { filePath: '/x/camB' }),
        asset('micM2', 100, { filePath: '/x/micM', hasVideo: false })
      ],
      {
        anchorSourceId: 'A',
        main: [{ fileId: 'fa', inPoint: 0, outPoint: 100, speed: 1 }],
        cameras: [
          {
            sourceId: 'B',
            name: 'カメラB',
            pieces: [{ fileId: 'fb', startTime: 2, inPoint: 0, outPoint: 95, speed: 1 }]
          }
        ],
        mics: [
          {
            sourceId: 'M',
            name: '出演者A',
            pieces: [{ fileId: 'fm', startTime: 0, inPoint: 0, outPoint: 100, speed: 1 }]
          }
        ],
        audio: [],
        leftOut: [],
        placed: [
          { fileId: 'fa', sourceId: 'A', start: 0, rate: 1, duration: 100 },
          { fileId: 'fb', sourceId: 'B', start: 2, rate: 1, duration: 95 },
          { fileId: 'fm', sourceId: 'M', start: 0, rate: 1, duration: 100 }
        ],
        duration: 100
      } as never,
      { fa: 'camA2', fb: 'camB2', fm: 'micM2' },
      '16:9',
      SOURCES
    )

    const p = st().project
    const ids = new Set(p.assets.map((a) => a.id))
    const orphans = [
      ...p.clips.filter((c) => !ids.has(c.assetId)),
      ...p.audioTracks.flatMap((t) => t.clips.filter((c) => !ids.has(c.assetId))),
      ...p.videoOverlayTracks.flatMap((t) => t.clips.filter((c) => !ids.has(c.assetId)))
    ]
    // 直す前: 手置きのワイプの camB と、分離したカメラA の音が、外した素材を指したまま黙って消えていた
    expect(orphans).toEqual([])
    const kept = p.videoOverlayTracks.find((t) => t.name === '手置き')!
    expect(kept.clips.map((c) => c.assetId)).toEqual(['camB2'])
    // 外した本編クリップに紐づいていた分離音声は、相手が居ないので残さない
    expect(p.audioTracks.every((t) => t.clips.every((c) => !c.linkedClipId))).toBe(true)
  })
})

describe('ドラッグを始めた所へ戻して離す', () => {
  beforeEach(() => {
    S.setState({
      project: blank({
        assets: [asset('A', 10)],
        clips: [{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 }]
      }),
      past: [],
      future: [],
      isDirty: false
    })
  })

  it('履歴を積まず、未保存にもしない', () => {
    const start = st().project
    commitAsOwnStep('clipTrim:c1', () => {
      st().updateClipTrim('c1', 0, 6)
      st().updateClipTrim('c1', 0, 4)
    })
    // 直す前: 中身は始まりと同じなのに `past` が1件・`isDirty` が立ち、取り消しが空振りしていた
    expect(st().past.length).toBe(0)
    expect(st().isDirty).toBe(false)
    expect(st().project).toBe(start)
  })

  it('戻した後にまた動かせば、その1件は積まれて取り消せる', () => {
    commitAsOwnStep('clipTrim:c1', () => {
      st().updateClipTrim('c1', 0, 6)
      st().updateClipTrim('c1', 0, 4)
      st().updateClipTrim('c1', 0, 7)
    })
    expect(st().past.length).toBe(1)
    expect(st().project.clips[0].outPoint).toBe(7)
    st().undo()
    expect(st().project.clips[0].outPoint).toBe(4)
  })

  it('やり直しの履歴も消さない', () => {
    st().updateClipTrim('c1', 0, 5)
    st().undo()
    expect(st().future.length).toBe(1)
    commitAsOwnStep('clipTrim:c1', () => {
      st().updateClipTrim('c1', 0, 6)
      st().updateClipTrim('c1', 0, 4)
    })
    expect(st().future.length).toBe(1)
  })
})

describe('音声だけの素材は、ソースビューアからも本編(V1)に置けない', () => {
  beforeEach(() => {
    st().loadProject(
      blank({
        assets: [
          asset('vid', 10),
          asset('bgm', 60, { hasVideo: false, width: 0, height: 0, fps: 0 })
        ],
        clips: [{ id: 'c1', assetId: 'vid', inPoint: 0, outPoint: 5, speed: 1 }]
      }),
      '/tmp/p.veproj'
    )
  })
  const mainPlayable = (): boolean[] =>
    st().project.clips.map((c) =>
      playableOnMain(st().project.assets.find((a) => a.id === c.assetId))
    )

  it('末尾に追加 (F)・挿入・上書き・本編に追加のどれも断る', () => {
    st().addTrimmedClipToTimeline('bgm', 10, 20)
    st().insertClipAtTime('bgm', 0, 4, 2)
    st().overwriteClipAtTime('bgm', 0, 4, 1)
    st().addClipToTimeline('bgm')
    // 直す前: 映像の無いクリップが本編に入り、標準の書き出しが失敗していた
    expect(mainPlayable()).toEqual([true])
    expect(st().past.length).toBe(0)
  })

  it('映像のある素材はこれまでどおり置ける', () => {
    st().addTrimmedClipToTimeline('vid', 1, 2)
    st().insertClipAtTime('vid', 0, 1, 0)
    expect(st().project.clips.length).toBe(3)
  })
})

describe('ドラッグ・入力のまとまりの途中で保存してから、始めた所へ戻す', () => {
  function savedProject(): void {
    S.setState({
      project: {
        id: 'p',
        name: 'g',
        aspectRatio: '16:9',
        assets: [asset('A', 10)],
        clips: [{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 4, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      } as unknown as Project,
      past: [],
      future: [],
      isDirty: false
    })
    st().markSaved('/x/p.veproj', st().project, st().projectSession)
  }

  it('ドラッグの途中で保存し、始めた所へ戻して離すと、保存したものと違うので未保存になる', () => {
    savedProject()
    beginHistoryGesture('clipTrim:c1')
    st().updateClipTrim('c1', 0, 6)
    // マウスを押したまま保存(ファイルは 0〜6)
    st().markSaved('/x/p.veproj', st().project, st().projectSession)
    st().updateClipTrim('c1', 0, 4)
    endHistoryGesture()
    expect(st().project.clips[0].outPoint).toBe(4)
    expect(st().isDirty).toBe(true)
  })

  it('名前を打つ途中で保存し、元の名前へ戻しても未保存になる', () => {
    savedProject()
    st().setProjectName('gx')
    st().markSaved('/x/p.veproj', st().project, st().projectSession)
    st().setProjectName('g')
    expect(st().isDirty).toBe(true)
  })
})

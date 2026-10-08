import { beforeEach, describe, expect, it } from 'vitest'
import { useProjectStore } from '@renderer/store/projectStore'
import type { Project } from '@shared/types'

const S = useProjectStore
const st = (): ReturnType<typeof S.getState> => S.getState()

const asset = (id: string, duration: number, hasVideo = true): Project['assets'][number] => ({
  id,
  filePath: `/rec/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration,
  width: hasVideo ? 1920 : 0,
  height: hasVideo ? 1080 : 0,
  fps: hasVideo ? 30 : 0,
  hasAudio: true,
  hasVideo
})

const info = {
  anchorSourceId: 'A',
  sources: [
    { id: 'A', name: 'カメラA', kind: 'camera' as const },
    { id: 'M', name: '出演者A', kind: 'mic' as const }
  ],
  files: [
    { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
    { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
  ]
}

/** マルチカムの仮編集(カメラ A・マイク M)に、自動の BGM(0〜30秒)と SE(13秒)を足す */
function setup(ranges: [number, number][]): void {
  S.setState({
    project: {
      id: 'p',
      name: 'r17',
      aspectRatio: '16:9',
      multicam: info,
      assets: [asset('camA', 100), asset('micM', 100, false), asset('bgm', 120, false)],
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      beatGrid: null
    } as unknown as Project,
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    isDirty: false
  })
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
    },
    []
  )
  const p = st().project
  S.setState({
    project: {
      ...p,
      audioTracks: [
        ...p.audioTracks,
        {
          id: 'bgmT',
          name: 'BGM',
          volume: 1,
          muted: false,
          duckingEnabled: true,
          autoRole: 'bgm',
          clips: [{ id: 'bgm1', assetId: 'bgm', startTime: 0, inPoint: 0, outPoint: 30 }]
        },
        {
          id: 'seT',
          name: 'SE',
          volume: 1,
          muted: false,
          duckingEnabled: false,
          autoRole: 'se',
          clips: [{ id: 'se1', assetId: 'bgm', startTime: 13, inPoint: 50, outPoint: 51 }]
        }
      ] as Project['audioTracks']
    }
  })
}

const track = (id: string): Project['audioTracks'][number]['clips'] =>
  st().project.audioTracks.find((t) => t.id === id)!.clips

describe('第17回: 本編の速さを変えたときの自動の BGM・SE', () => {
  beforeEach(() =>
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
  )

  it('速さを変えたクリップの下の SE は消えず、BGM に穴が開かない', () => {
    const clip2 = st().project.clips[1].id
    st().updateClipSpeed(clip2, 1.25)
    const se = track('seT')
    expect(se).toHaveLength(1)
    expect(se[0].startTime).toBeCloseTo(10 + 3 / 1.25, 6)
    expect(se[0].outPoint - se[0].inPoint).toBeCloseTo(1, 6)
    const bgm = track('bgmT')
    expect(bgm).toHaveLength(1)
    expect(bgm[0].startTime).toBeCloseTo(0, 6)
    expect(bgm[0].outPoint - bgm[0].inPoint).toBeCloseTo(28, 6)
  })

  it('速さを戻すと、元の位置に戻る', () => {
    const clip2 = st().project.clips[1].id
    st().updateClipSpeed(clip2, 1.25)
    st().updateClipSpeed(clip2, 1)
    expect(track('seT').map((c) => c.startTime)).toEqual([13])
    const bgm = track('bgmT')
    expect(bgm).toHaveLength(1)
    // 本編の終わりまで流れていた BGM は、本編の終わりまで戻る
    expect(bgm[0].outPoint - bgm[0].inPoint).toBeCloseTo(30, 6)
  })
})

describe('第17回: ファイルが分かれて録られたカメラへのアングルの切り替え', () => {
  it('境目をまたぐクリップは、境目で分けて替える(長さは変えない)', () => {
    setup([[40, 60]])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('b1', 50), asset('b2', 50)],
        multicam: {
          ...info,
          sources: [...info.sources, { id: 'B', name: 'カメラB', kind: 'camera' as const }],
          files: [
            ...info.files,
            { assetId: 'b1', sourceId: 'B', start: 0, rate: 1, duration: 50 },
            { assetId: 'b2', sourceId: 'B', start: 50, rate: 1, duration: 50 }
          ]
        }
      }
    })
    st().switchClipAngle(st().project.clips[0].id, 'B')
    expect(st().project.clips.map((c) => [c.assetId, c.inPoint, c.outPoint])).toEqual([
      ['b1', 40, 50],
      ['b2', 0, 10]
    ])
  })
})

describe('第17回: 仮編集の作り直しで、人がクリップに加えた手直しを残す', () => {
  const rebuild = (): void =>
    st().applyRoughCut(
      {
        main: [{ assetId: 'camA', inPoint: 0, outPoint: 10, speed: 1 }],
        audio: [
          {
            name: '出演者A',
            sourceId: 'M',
            volume: 1,
            clips: [{ assetId: 'micM', startTime: 0, inPoint: 0, outPoint: 10, speed: 1 }]
          }
        ],
        duration: 10,
        spans: []
      },
      []
    )

  it('マイクのトラックに置いたナレーション・クリップの音量・本編の切り抜きは消えない', () => {
    setup([[0, 10]])
    const p = st().project
    const mic = p.audioTracks.find((t) => t.multicamSourceId === 'M')!
    S.setState({
      project: {
        ...p,
        clips: p.clips.map((c) => ({ ...c, fillCrop: true, cropCenter: { x: 0.3, y: 0.5 } })),
        audioTracks: p.audioTracks.map((t) =>
          t.id === mic.id
            ? {
                ...t,
                clips: [
                  ...t.clips.map((c) => ({ ...c, volume: 0.2 })),
                  { id: 'nar', assetId: 'bgm', startTime: 3, inPoint: 0, outPoint: 2 }
                ]
              }
            : t
        )
      }
    })
    rebuild()
    const after = st().project
    const micAfter = after.audioTracks.find((t) => t.multicamSourceId === 'M')!
    // ナレーションは作り直した声と重ならないよう、別のトラックへ移して残す
    expect(
      after.audioTracks.some(
        (t) => !t.multicamSourceId && t.clips.some((c) => c.id === 'nar' && c.startTime === 3)
      )
    ).toBe(true)
    expect(micAfter.clips.find((c) => c.assetId === 'micM')?.volume).toBe(0.2)
    expect(after.clips[0].fillCrop).toBe(true)
    expect(after.clips[0].cropCenter).toEqual({ x: 0.3, y: 0.5 })
  })
})

describe('第17回: 用意している間に別のプロジェクトを開いたときの音', () => {
  it('用意し始めたプロジェクトと違えば置かない', () => {
    setup([[0, 10]])
    const before = st().project
    const nar = { ...asset('nar', 5, false), filePath: '/rec/nar.wav' }
    st().addAudioClipWithAsset(nar, { trackName: 'ナレーション', projectId: 'another' })
    expect(st().project).toBe(before)
    st().addAudioClipWithAsset(nar, { trackName: 'ナレーション', projectId: before.id })
    expect(st().project.audioTracks.some((t) => t.name === 'ナレーション')).toBe(true)
  })
})

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

function base(): Project {
  return {
    id: 'p',
    name: 'r8',
    aspectRatio: '16:9',
    assets: [asset('A', 20), asset('B', 20), asset('M', 30, false)],
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 },
      { id: 'c2', assetId: 'B', inPoint: 0, outPoint: 10, speed: 1 }
    ],
    audioTracks: [
      {
        id: 't0',
        name: 'BGM',
        volume: 1,
        muted: false,
        duckingEnabled: false,
        clips: []
      }
    ],
    videoOverlayTracks: [],
    textOverlays: [],
    beatGrid: null
  } as unknown as Project
}

function reset(): void {
  S.setState({
    project: base(),
    past: [],
    future: [],
    selectedClipId: null,
    multiSelectedClipIds: [],
    selectedOverlayId: null,
    clipboardClips: [],
    missingAssetPaths: [],
    missingAssetIds: [],
    isDirty: false
  })
}

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

/** マルチカムの仮編集(カメラ A・マイク M)を入れる */
function roughCut(ranges: [number, number][]): void {
  S.setState({
    project: {
      ...st().project,
      multicam: info,
      assets: [asset('camA', 100), asset('micM', 100, false)],
      clips: [],
      audioTracks: [],
      textOverlays: []
    }
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
}
const micClips = (): Project['audioTracks'][number]['clips'] =>
  st().project.audioTracks.find((t) => t.multicamSourceId === 'M')!.clips

describe('第8回: 編集モデル', () => {
  beforeEach(reset)

  it('分離した音を別のトラックへ移しても、元のクリップの音は消したまま(二重に鳴らさない)', () => {
    st().detachClipAudio('c1')
    const sep = st().project.audioTracks.find((t) => t.clips.some((c) => c.linkedClipId === 'c1'))!
    const a = sep.clips.find((c) => c.linkedClipId === 'c1')!
    st().moveAudioClipToTrack(sep.id, a.id, 't0', 0.5)
    expect(st().project.audioTracks.find((t) => t.id === 't0')!.clips).toHaveLength(1)
    expect(st().project.clips.find((c) => c.id === 'c1')!.audioDetached).toBe(true)
  })

  it('マルチカムのクリップを複製・貼り付けしても、カメラの音は消したまま(マイクの音が鳴る)', () => {
    roughCut([[0, 10]])
    const id = st().project.clips[0].id
    expect(st().project.clips[0].audioDetached).toBe(true)
    st().duplicateClips([id])
    expect(st().project.clips).toHaveLength(2)
    expect(st().project.clips.every((c) => c.audioDetached)).toBe(true)
    expect(micClips()).toHaveLength(2)
    st().selectClip(id)
    st().copySelectedClip()
    st().pasteClip()
    expect(st().project.clips).toHaveLength(3)
    expect(st().project.clips.every((c) => c.audioDetached)).toBe(true)
  })

  it('分離した音で消していたクリップの複製は、自分の音を鳴らす', () => {
    st().detachClipAudio('c1')
    st().duplicateClips(['c1'])
    const copy = st().project.clips.find((c) => c.id !== 'c1' && c.assetId === 'A')!
    expect(copy.audioDetached).toBe(false)
  })

  it('コピーした後に素材を短いファイルへ差し替えたら、貼るクリップもその尺に収める', () => {
    S.setState({
      project: {
        ...st().project,
        clips: [{ id: 'c1', assetId: 'A', inPoint: 2, outPoint: 18, speed: 1 }]
      }
    })
    st().selectClip('c1')
    st().copySelectedClip()
    st().relinkAsset(
      'A',
      '/rec/a2.mp4',
      'a2.mp4',
      {
        duration: 10,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      } as Parameters<ReturnType<typeof S.getState>['relinkAsset']>[3],
      ''
    )
    st().pasteClip()
    for (const c of st().project.clips) expect(c.outPoint).toBeLessThanOrEqual(10)
  })

  it('自動の SE・BGM・CG を置いたら未保存にする', () => {
    S.setState({ isDirty: false })
    st().setAutoSounds(
      [
        {
          role: 'bgm',
          clips: [{ path: '/rec/M.mp4', startTime: 0, inPoint: 0, outPoint: 5, volume: 1 }]
        }
      ] as Parameters<ReturnType<typeof S.getState>['setAutoSounds']>[0],
      []
    )
    expect(st().isDirty).toBe(true)
    S.setState({ isDirty: false })
    st().setAutoCg(
      [{ path: '/rec/B.mp4', startTime: 0, inPoint: 0, outPoint: 3 }] as Parameters<
        ReturnType<typeof S.getState>['setAutoCg']
      >[0],
      []
    )
    expect(st().isDirty).toBe(true)
  })

  it('追従するテロップは、クリップを速くしても・頭を詰めても同じ中身の上に出る', () => {
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          {
            id: 'o1',
            text: 'あ',
            startTime: 8,
            endTime: 9,
            style: {},
            source: 'manual',
            linkedClipId: 'c1',
            linkOffset: 8
          }
        ]
      } as unknown as Project
    })
    st().updateClipTrim('c1', 3, 10)
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(5, 9)
    st().updateClipSpeed('c1', 2)
    // 素材の 8 秒 = 入点 3 から 5 秒 = 速さ 2 で 2.5 秒
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(2.5, 9)
    // 取り消すと元の位置に戻る
    st().undo()
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(5, 9)
    st().undo()
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(8, 9)
  })

  it('追従するテロップは、ロールで行って戻っても・クリップの外へずらしてあっても追従を外さない', () => {
    S.setState({
      project: {
        ...st().project,
        clips: [
          { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 },
          { id: 'c2', assetId: 'B', inPoint: 3, outPoint: 13, speed: 1 }
        ],
        textOverlays: [
          {
            id: 'o1',
            text: 'あ',
            startTime: 11,
            endTime: 12,
            style: {},
            source: 'manual',
            linkedClipId: 'c2',
            linkOffset: 1
          },
          {
            id: 'o2',
            text: 'い',
            startTime: 9.5,
            endTime: 10,
            style: {},
            source: 'manual',
            linkedClipId: 'c2',
            linkOffset: -0.5
          }
        ]
      } as unknown as Project
    })
    st().rollTrim('c1', 'c2', 2)
    st().rollTrim('c1', 'c2', -2)
    const o1 = st().project.textOverlays.find((o) => o.id === 'o1')!
    expect(o1.linkedClipId).toBe('c2')
    expect(o1.startTime).toBeCloseTo(11, 9)
    st().updateClipSpeed('c2', 1.25)
    expect(st().project.textOverlays.find((o) => o.id === 'o2')!.linkedClipId).toBe('c2')
  })

  it('マルチカムの素材を短いファイルへ差し替えたら、後の編集でマイクの音を素材の先まで作らない', () => {
    roughCut([[0, 10]])
    st().relinkAsset(
      'micM',
      '/rec/m2.m4a',
      'm2.m4a',
      {
        duration: 30,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        hasVideo: false
      } as Parameters<ReturnType<typeof S.getState>['relinkAsset']>[3],
      ''
    )
    const main = st().project.clips[0].id
    st().updateClipTrim(main, 0, 60)
    for (const c of micClips()) expect(c.outPoint).toBeLessThanOrEqual(30 + 1e-9)
  })

  it('クリップの頭より前・終わりより後ろにずらした追従テロップは、分割しても動かない', () => {
    S.setState({
      project: {
        ...st().project,
        clips: [
          { id: 'c1', assetId: 'A', inPoint: 0, outPoint: 10, speed: 1 },
          { id: 'c2', assetId: 'B', inPoint: 0, outPoint: 10, speed: 1 }
        ],
        textOverlays: [
          {
            id: 'o1',
            text: 'あ',
            startTime: 11,
            endTime: 12,
            style: {},
            source: 'manual',
            linkedClipId: 'c2',
            linkOffset: 1
          }
        ]
      } as unknown as Project
    })
    st().updateClipTrim('c2', 3, 10)
    const before = st().project.textOverlays[0].startTime
    expect(before).toBeCloseTo(8, 9)
    st().splitClipAtTime('c2', 13)
    expect(st().project.textOverlays[0].startTime).toBeCloseTo(before, 9)
    expect(st().project.textOverlays[0].linkedClipId).toBeDefined()
  })

  it('差し込みの画を短いファイルへ差し替えても、マイクの音は本編に付いていく', () => {
    roughCut([
      [0, 10],
      [10, 20]
    ])
    S.setState({
      project: {
        ...st().project,
        assets: [...st().project.assets, asset('X', 10)]
      }
    })
    const clips = st().project.clips
    S.setState({
      project: {
        ...st().project,
        clips: [clips[0], { id: 'x', assetId: 'X', inPoint: 0, outPoint: 10, speed: 1 }, clips[1]]
      }
    })
    // 差し込みの分だけ、2本目の声は 20 秒から
    S.setState({
      project: {
        ...st().project,
        audioTracks: st().project.audioTracks.map((t) =>
          t.multicamSourceId === 'M'
            ? { ...t, clips: t.clips.map((c, i) => (i === 1 ? { ...c, startTime: 20 } : c)) }
            : t
        )
      }
    })
    st().relinkAsset(
      'X',
      '/rec/x2.mp4',
      'x2.mp4',
      {
        duration: 4,
        width: 1920,
        height: 1080,
        fps: 30,
        hasAudio: true,
        hasVideo: true
      } as Parameters<ReturnType<typeof S.getState>['relinkAsset']>[3],
      ''
    )
    expect(micClips()[1].startTime).toBeCloseTo(14, 6)
  })

  it('手で音声を分離したマルチカムのクリップの複製は、自分の音を鳴らす(無音にしない)', () => {
    S.setState({
      project: {
        ...st().project,
        multicam: {
          anchorSourceId: 'A',
          sources: [{ id: 'A', name: 'カメラA', kind: 'camera' }],
          files: [{ assetId: 'A', sourceId: 'A', start: 0, rate: 1, duration: 20 }]
        }
      } as unknown as Project
    })
    st().detachClipAudio('c1')
    st().duplicateClips(['c1'])
    const copy = st().project.clips.find((c) => c.id !== 'c1' && c.assetId === 'A')!
    expect(copy.audioDetached).toBe(false)
  })

  it('置き換えで消えたクリップ・テロップを選んだままにしない', () => {
    st().selectClip('c1')
    st().replaceClipRange('c1', [
      { id: 'n1', assetId: 'A', inPoint: 0, outPoint: 3, speed: 1 },
      { id: 'n2', assetId: 'A', inPoint: 5, outPoint: 10, speed: 1 }
    ])
    expect(st().project.clips.map((c) => c.id)).not.toContain('c1')
    expect(st().selectedClipId).toBeNull()
    expect(st().multiSelectedClipIds).toEqual([])
  })

  it('別のテロップへのスタイルの変更は、1回の取り消しにまとめない', () => {
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          { id: 'a', text: 'あ', startTime: 0, endTime: 1, style: {}, source: 'manual' },
          { id: 'b', text: 'い', startTime: 2, endTime: 3, style: {}, source: 'manual' }
        ]
      } as unknown as Project,
      past: []
    })
    st().updateTextOverlaysStyle(['a'], { fontSize: 60 })
    st().updateTextOverlaysStyle(['b'], { color: '#ff0000' })
    expect(st().past).toHaveLength(2)
  })

  it('読み込みで、入れ子の知らない項目も残す', () => {
    const raw = {
      ...base(),
      beatGrid: { bpm: 120, offsetSeconds: 0, enabled: true, sourceLabel: '', futureX: 1 },
      multicam: {
        ...info,
        futureM: 2,
        sources: info.sources.map((s) => ({ ...s, futureS: 3 })),
        files: info.files.map((f) => ({ ...f, futureF: 4 }))
      },
      transcript: [
        {
          id: 'u1',
          assetId: 'A',
          sourceStart: 0,
          sourceEnd: 1,
          text: 'あ',
          words: [{ text: 'あ', start: 0, end: 1, futureW: 5 }],
          futureU: 6
        }
      ],
      cutOverrides: { removed: [{ start: 1, end: 2, futureR: 7 }], added: [], angles: [] },
      editedTelops: { k: { text: 'あ', style: {}, futureE: 8 } }
    } as unknown as Project
    st().loadProject(raw, '/x.veproj')
    const p = st().project as unknown as Record<string, Record<string, unknown>>
    const json = JSON.stringify(p)
    for (const k of [
      'futureX',
      'futureM',
      'futureS',
      'futureF',
      'futureW',
      'futureU',
      'futureR',
      'futureE'
    ])
      expect(json, k).toContain(k)
  })
})

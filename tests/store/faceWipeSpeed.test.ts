import { describe, expect, it } from 'vitest'
import { normalizeLoadedProject, useProjectStore } from '@renderer/store/projectStore'
import { activeVideoOverlayClips } from '@renderer/lib/videoOverlay'
import { overlayClipDuration } from '@shared/overlayClip'
import type { Project, VideoOverlayClip } from '@shared/types'

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

/** ゲーム実況: 画面(A・本編)・顔カメラ(F・ワイプ)・マイク(M) */
const info = {
  anchorSourceId: 'A',
  sources: [
    { id: 'A', name: '画面', kind: 'camera' as const, cameraRole: 'screen' as const },
    { id: 'F', name: '顔', kind: 'camera' as const, cameraRole: 'face' as const },
    { id: 'M', name: '出演者A', kind: 'mic' as const }
  ],
  files: [
    { assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 },
    { assetId: 'camF', sourceId: 'F', start: 0, rate: 1, duration: 100 },
    { assetId: 'micM', sourceId: 'M', start: 0, rate: 1, duration: 100 }
  ]
}

const R: [number, number][] = [
  [0, 10],
  [20, 30],
  [40, 50]
]

/** 仮編集(本編 A・声 M・顔カメラのワイプ F)を入れる */
function setup(ranges: [number, number][] = R): void {
  S.setState({
    project: {
      id: 'p',
      name: 'wipe',
      aspectRatio: '16:9',
      multicam: info,
      assets: [asset('camA', 100), asset('camF', 100), asset('micM', 100, false)],
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
  const pieces = ranges.map(([a, b]) => {
    const c = { startTime: t, inPoint: a, outPoint: b }
    t += b - a
    return c
  })
  st().applyRoughCut(
    {
      main: ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
      audio: [
        {
          name: '出演者A',
          sourceId: 'M',
          volume: 1,
          clips: pieces.map((p) => ({ assetId: 'micM', ...p, speed: 1 }))
        }
      ],
      overlays: [
        { name: '顔', sourceId: 'F', clips: pieces.map((p) => ({ assetId: 'camF', ...p })) }
      ],
      duration: t,
      spans: []
    },
    []
  )
}

const face = (): Project['videoOverlayTracks'][number] =>
  st().project.videoOverlayTracks.find((t) => t.multicamSourceId === 'F')!

/**
 * タイムラインのどの時刻でも、顔カメラのワイプがちょうど1本だけ映り、本編が映している時刻と同じ時刻の
 * 顔を映しているか(ずれていたら、その時刻)。声の `misaligned`(editModelRound17)と同じ調べ方
 */
function wipeMisaligned(): string[] {
  const p = st().project
  const fileOf = new Map(p.multicam!.files.map((f) => [f.assetId, f]))
  const spans: { s: number; e: number; c: Project['clips'][number] }[] = []
  let cur = 0
  for (const c of p.clips) {
    const len = (c.outPoint - c.inPoint) / (c.speed || 1)
    spans.push({ s: cur, e: cur + len, c })
    cur += len
  }
  const cams = face().clips.filter((c) => c.assetId === 'camF')
  const out: string[] = []
  for (let t = 0.01; t < cur - 0.01; t += 0.037) {
    const sp = spans.find((x) => t >= x.s && t < x.e)!
    const f = fileOf.get(sp.c.assetId)!
    const common = f.start + (sp.c.inPoint + (t - sp.s) * (sp.c.speed || 1)) / f.rate
    const vs = cams.filter((v) => t >= v.startTime && t < v.startTime + overlayClipDuration(v))
    if (vs.length !== 1) {
      out.push(`${t.toFixed(3)}: ${vs.length}枚`)
      continue
    }
    const v = vs[0]
    const g = fileOf.get('camF')!
    const vc = g.start + (v.inPoint + (t - v.startTime) * (v.speed || 1)) / g.rate
    if (Math.abs(vc - common) > 1 / 60)
      out.push(`${t.toFixed(3)}: ${(vc - common).toFixed(3)}秒ずれ`)
  }
  return out.slice(0, 5)
}

describe('本編を速くした所の顔カメラのワイプは、声と同じ速さで残る', () => {
  it('2 倍にすると、その区間のワイプも 2 倍で映り、本編と同じ時刻の顔を映す', () => {
    setup()
    expect(wipeMisaligned()).toEqual([])
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 2)
    expect(wipeMisaligned()).toEqual([])
    const mid = face().clips.find((c) => Math.abs(c.inPoint - 20) < 1e-6)!
    expect(mid.speed).toBeCloseTo(2, 9)
    expect(mid.startTime).toBeCloseTo(10, 9)
    expect(overlayClipDuration(mid)).toBeCloseTo(5, 9)
  })

  it('人が消したワイプの所(顔を隠した所)は、速さを変えて戻しても戻さず、残りは同じ速さで付いてくる', () => {
    setup()
    // 素材の 22〜26 秒の顔を消す(映したくない所)
    const p = st().project
    S.setState({
      project: {
        ...p,
        videoOverlayTracks: p.videoOverlayTracks.map((t) =>
          t.multicamSourceId !== 'F'
            ? t
            : {
                ...t,
                clips: t.clips.flatMap((c) =>
                  c.inPoint === 20
                    ? [
                        { ...c, outPoint: 22 },
                        { ...c, id: 'tail', startTime: 16, inPoint: 26 }
                      ]
                    : [c]
                )
              }
        )
      }
    })
    const id = st().project.clips[1].id
    const hidden = (): boolean =>
      face().clips.every((c) => c.outPoint <= 22 + 1e-6 || c.inPoint >= 26 - 1e-6)
    for (const sp of [2, 0.5, 1]) {
      st().updateClipSpeed(id, sp)
      expect(hidden()).toBe(true)
      // 消していない所(素材の 20〜22 秒・26〜30 秒)は、本編と同じ速さで残る
      for (const [a, b] of [
        [20, 22],
        [26, 30]
      ]) {
        const covered = face()
          .clips.filter((c) => c.inPoint < b - 1e-6 && c.outPoint > a + 1e-6)
          .reduce((n, c) => n + Math.min(b, c.outPoint) - Math.max(a, c.inPoint), 0)
        expect(covered).toBeCloseTo(b - a, 6)
      }
      expect(
        face()
          .clips.filter((c) => c.inPoint >= 20 - 1e-6 && c.outPoint <= 30 + 1e-6)
          .every((c) => Math.abs((c.speed ?? 1) - sp) < 1e-9)
      ).toBe(true)
    }
    // 等倍に戻したら、速さの印は残らない
    expect(face().clips.every((c) => c.speed === undefined)).toBe(true)
  })

  it('速くしたクリップを後ろ・前へ伸ばすと、伸ばした所にも同じ速さでワイプが入る', () => {
    setup()
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 2)
    st().updateClipTrim(id, 20, 35)
    expect(wipeMisaligned()).toEqual([])
    st().updateClipTrim(id, 15, 35)
    expect(wipeMisaligned()).toEqual([])
    // 伸ばしたあと速さを戻しても、ずれず・重ならず・欠けない
    st().updateClipSpeed(id, 1)
    expect(wipeMisaligned()).toEqual([])
  })

  it('取り消し・やり直しで、ワイプのトラックがそのまま戻る', () => {
    setup()
    const before = st().project.videoOverlayTracks
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 2)
    const sped = st().project.videoOverlayTracks
    expect(sped).not.toEqual(before)
    st().undo()
    expect(st().project.videoOverlayTracks).toEqual(before)
    st().redo()
    expect(st().project.videoOverlayTracks).toEqual(sped)
    expect(wipeMisaligned()).toEqual([])
  })

  it('ワイプのトラックに人が置いた画は動かさず、速くしたカメラの絵と重なれば別のトラックへ移す', () => {
    setup()
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, { ...asset('logo', 5), filePath: '/rec/logo.png' }],
        videoOverlayTracks: p.videoOverlayTracks.map((t) =>
          t.multicamSourceId !== 'F'
            ? t
            : {
                ...t,
                clips: [
                  ...t.clips,
                  { id: 'logoC', assetId: 'logo', startTime: 12, inPoint: 0, outPoint: 2 }
                ]
              }
        )
      }
    })
    const logo = (): { track: string; clip: VideoOverlayClip } => {
      const t = st().project.videoOverlayTracks.find((x) => x.clips.some((c) => c.id === 'logoC'))!
      return { track: t.name, clip: t.clips.find((c) => c.id === 'logoC')! }
    }
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 2)
    // 置いた時刻のまま。カメラの絵(12秒は速くした区間の中)と重なるので「(手で置いた画)」へ
    expect(logo().clip.startTime).toBe(12)
    expect(logo().track).toBe('顔(手で置いた画)')
    expect(face().clips.every((c) => c.assetId === 'camF')).toBe(true)
    expect(wipeMisaligned()).toEqual([])
  })
})

describe('速さを持つワイプのクリップ', () => {
  const sped: VideoOverlayClip = {
    id: 'w',
    assetId: 'camF',
    startTime: 10,
    inPoint: 20,
    outPoint: 30,
    speed: 2
  }

  it('映る区間はタイムラインの長さ(素材の秒数 ÷ 速さ)', () => {
    expect(activeVideoOverlayClips([sped], 14.9)).toHaveLength(1)
    expect(activeVideoOverlayClips([sped], 15.1)).toHaveLength(0)
  })

  it('分割は押したタイムラインの位置を素材の秒へ直して切る', () => {
    setup()
    const p = st().project
    S.setState({
      project: {
        ...p,
        videoOverlayTracks: [
          {
            id: 'pipT',
            name: 'ワイプ',
            hidden: false,
            position: 'top-right',
            scale: 0.3,
            clips: [sped]
          }
        ]
      }
    })
    st().splitVideoOverlayClipAtTime('pipT', 'w', 12)
    const [a, b] = st().project.videoOverlayTracks[0].clips
    expect([a.startTime, a.inPoint, a.outPoint, a.speed]).toEqual([10, 20, 24, 2])
    expect([b.startTime, b.inPoint, b.outPoint, b.speed]).toEqual([12, 24, 30, 2])
    // 分けた2本はつながっている(前の終わり = 後ろの頭)
    expect(a.startTime + overlayClipDuration(a)).toBeCloseTo(b.startTime, 9)
  })

  it('素材を差し替えると等倍に戻る', () => {
    setup()
    const p = st().project
    S.setState({
      project: {
        ...p,
        videoOverlayTracks: [
          {
            id: 'pipT',
            name: 'ワイプ',
            hidden: false,
            position: 'top-right',
            scale: 0.3,
            clips: [sped]
          }
        ]
      }
    })
    st().swapVideoOverlayClipAsset('pipT', 'w', 'camA', 5)
    const c = st().project.videoOverlayTracks[0].clips[0]
    expect(c).toMatchObject({ assetId: 'camA', inPoint: 0, outPoint: 5 })
    expect(c.speed).toBeUndefined()
  })

  it('読み込みでは正しい速さだけ残し、壊れた値・等倍は印を外す', () => {
    const loaded = normalizeLoadedProject({
      assets: [asset('camF', 100)],
      videoOverlayTracks: [
        {
          id: 't',
          name: '顔',
          clips: [
            { id: 'a', assetId: 'camF', startTime: 0, inPoint: 0, outPoint: 10, speed: 2 },
            { id: 'b', assetId: 'camF', startTime: 10, inPoint: 0, outPoint: 10, speed: -1 },
            { id: 'c', assetId: 'camF', startTime: 20, inPoint: 0, outPoint: 10, speed: 'x' },
            { id: 'd', assetId: 'camF', startTime: 30, inPoint: 0, outPoint: 10, speed: 1 }
          ]
        }
      ]
    } as unknown as Project)
    const speeds = loaded.videoOverlayTracks[0].clips.map((c) => c.speed)
    expect(speeds).toEqual([2, undefined, undefined, undefined])
    expect(loaded.videoOverlayTracks[0].clips.map((c) => 'speed' in c)).toEqual([
      true,
      false,
      false,
      false
    ])
  })
})

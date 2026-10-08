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

describe('第18回: ループする BGM と速さ', () => {
  it('遅くしてもループの間に穴が開かず、速さを戻すと元の並びに戻る', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', 20, false)],
        audioTracks: p.audioTracks.map((t) =>
          t.id === 'bgmT'
            ? {
                ...t,
                clips: [
                  { id: 'b1', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 20 },
                  { id: 'b2', assetId: 'loop', startTime: 18.5, inPoint: 0, outPoint: 11.5 }
                ]
              }
            : t
        )
      }
    })
    const clip2 = st().project.clips[1].id
    st().updateClipSpeed(clip2, 0.5)
    const slow = [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
    // 本編は 40 秒。BGM は頭から終わりまで、つなぎ目は重なったまま
    expect(slow[0].startTime).toBe(0)
    for (let i = 1; i < slow.length; i++) {
      const prevEnd = slow[i - 1].startTime + (slow[i - 1].outPoint - slow[i - 1].inPoint)
      expect(slow[i].startTime).toBeLessThanOrEqual(prevEnd + 1e-9)
    }
    const lastSlow = slow[slow.length - 1]
    expect(lastSlow.startTime + (lastSlow.outPoint - lastSlow.inPoint)).toBeCloseTo(40, 6)
    st().updateClipSpeed(clip2, 1)
    const back = [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
    expect(back.map((c) => [c.startTime, c.inPoint, c.outPoint])).toEqual([
      [0, 0, 20],
      [18.5, 0, 11.5]
    ])
  })
})

describe('第18回: 作り直しで見た目を引き継ぐ', () => {
  const rebuildMain = (ranges: [number, number][]): void =>
    st().applyRoughCut(
      {
        main: ranges.map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
        audio: [
          {
            name: '出演者A',
            sourceId: 'M',
            volume: 1,
            clips: ranges.map(([a, b], i) => ({
              assetId: 'micM',
              startTime: ranges.slice(0, i).reduce((x, [p, q]) => x + q - p, 0),
              inPoint: a,
              outPoint: b,
              speed: 1
            }))
          }
        ],
        duration: ranges.reduce((x, [a, b]) => x + b - a, 0),
        spans: []
      },
      []
    )
  const styleAll = (): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        clips: p.clips.map((c) => ({ ...c, fillCrop: true, colorLabel: 'red' as const }))
      }
    })
  }

  it('1本が分かれても、頭を詰めても、どのクリップにも付く', () => {
    setup([[0, 30]])
    styleAll()
    rebuildMain([
      [0, 10],
      [15, 30]
    ])
    expect(st().project.clips.map((c) => [c.fillCrop, c.colorLabel])).toEqual([
      [true, 'red'],
      [true, 'red']
    ])
    setup([[0, 30]])
    styleAll()
    rebuildMain([[2, 30]])
    expect(st().project.clips[0].fillCrop).toBe(true)
  })
})

describe('第19回: 速さを変えたときの BGM・SE の並べ直しの見直し', () => {
  const setTrack = (id: string, clips: Project['audioTracks'][number]['clips']): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', 20, false), asset('sfx', 1, false)],
        audioTracks: p.audioTracks.map((t) => (t.id === id ? { ...t, clips } : t))
      }
    })
  }
  beforeEach(() =>
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
  )

  it('同じ SE を重ねて置いていても止まらず、増えない', () => {
    setTrack('seT', [
      { id: 's1', assetId: 'sfx', startTime: 13, inPoint: 0, outPoint: 1 },
      { id: 's2', assetId: 'sfx', startTime: 13, inPoint: 0, outPoint: 1 }
    ])
    st().updateClipSpeed(st().project.clips[1].id, 0.5)
    expect(track('seT')).toHaveLength(2)
  })

  it('同じ素材の別の所を続けて置いた SE は、それぞれ長さを保って動く', () => {
    setTrack('seT', [
      { id: 's1', assetId: 'bgm', startTime: 13, inPoint: 50, outPoint: 51 },
      { id: 's2', assetId: 'bgm', startTime: 14, inPoint: 60, outPoint: 61 }
    ])
    st().updateClipSpeed(st().project.clips[1].id, 0.5)
    expect(track('seT').map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])).toEqual([
      ['s1', 16, 50, 51],
      ['s2', 18, 60, 61]
    ])
  })

  it('ループのつなぎ目のクロスフェードは、ほかの所の速さを変えても残る', () => {
    setTrack('bgmT', [
      { id: 'b1', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 20, fadeIn: 2, fadeOut: 2 },
      { id: 'b2', assetId: 'loop', startTime: 18, inPoint: 0, outPoint: 12, fadeIn: 2, fadeOut: 2 }
    ])
    st().updateClipSpeed(st().project.clips[2].id, 1.25)
    const b1 = track('bgmT').find((c) => c.id === 'b1')!
    expect(b1.fadeOut).toBe(2)
  })

  it('1本にまで縮んだ BGM も、速さを戻すと本編の終わりまで戻る', () => {
    setup([[0, 30]])
    setTrack('bgmT', [
      { id: 'b1', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 20 },
      { id: 'b2', assetId: 'loop', startTime: 18, inPoint: 0, outPoint: 12 }
    ])
    const id = st().project.clips[0].id
    st().updateClipSpeed(id, 2)
    expect(track('bgmT')).toHaveLength(1)
    st().updateClipSpeed(id, 1)
    const back = [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
    const last = back[back.length - 1]
    expect(last.startTime + (last.outPoint - last.inPoint)).toBeCloseTo(30, 6)
  })

  it('作り直しで前の2本が1本につながっても、見た目を引き継ぐ', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const p = st().project
    S.setState({
      project: { ...p, clips: p.clips.map((c) => ({ ...c, fillCrop: true })) }
    })
    st().applyRoughCut(
      {
        main: [{ assetId: 'camA', inPoint: 0, outPoint: 30, speed: 1 }],
        audio: [
          {
            name: '出演者A',
            sourceId: 'M',
            volume: 1,
            clips: [{ assetId: 'micM', startTime: 0, inPoint: 0, outPoint: 30, speed: 1 }]
          }
        ],
        duration: 30,
        spans: []
      },
      []
    )
    expect(st().project.clips[0].fillCrop).toBe(true)
  })
})

describe('第19回: テロップの頭を詰めても言葉の時刻はそのまま', () => {
  it('頭を詰めると言葉は動かず、動かすと一緒に動く', () => {
    setup([[0, 10]])
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          {
            id: 'k',
            text: 'えっと 拍手',
            startTime: 2,
            endTime: 5,
            style: {},
            source: 'manual',
            words: [
              { text: 'えっと', start: 2, end: 3 },
              { text: '拍手', start: 3.5, end: 4.5 }
            ]
          }
        ] as unknown as Project['textOverlays']
      }
    })
    st().updateTextOverlay('k', { startTime: 3, endTime: 5 })
    expect(st().project.textOverlays[0].words?.map((w) => w.start)).toEqual([2, 3.5])
    st().updateTextOverlay('k', { startTime: 4, endTime: 6 })
    expect(st().project.textOverlays[0].words?.map((w) => w.start)).toEqual([3, 4.5])
  })
})

describe('第19回: 壊れた過去回も、整えてから番組の傾向を集計する', () => {
  it('壊れた項目のある回が混ざっても落ちない', async () => {
    const { normalizeLoadedProject } = await import('@renderer/store/projectStore')
    const { learnShowStyle } = await import('@shared/style/showStyle')
    const bad = [
      { textOverlays: [{ startTime: 0, endTime: 1 }] },
      { audioTracks: [{ volume: 1 }] },
      { multicam: { anchorSourceId: 'a' } }
    ] as unknown as Project[]
    expect(() => learnShowStyle(bad.map(normalizeLoadedProject))).not.toThrow()
  })
})

describe('第20回: 第19回修正の見直し', () => {
  const setTrack = (
    id: string,
    clips: Project['audioTracks'][number]['clips'],
    song = 20
  ): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', song, false)],
        audioTracks: p.audioTracks.map((t) => (t.id === id ? { ...t, clips } : t))
      }
    })
  }

  it('インスペクタで開始だけを直しても(頭を詰める)、言葉の時刻は動かさない', () => {
    setup([[0, 20]])
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          {
            id: 'o1',
            text: 'あ い',
            startTime: 10,
            endTime: 14,
            style: {},
            source: 'manual',
            words: [
              { text: 'あ', start: 11, end: 12 },
              { text: 'い', start: 12.5, end: 13.5 }
            ]
          }
        ] as unknown as Project['textOverlays']
      }
    })
    st().updateTextOverlay('o1', { startTime: 10.8 })
    expect(st().project.textOverlays[0].words?.[1]).toMatchObject({ start: 12.5, end: 13.5 })
  })

  it('足したループの id は、トラックのほかのクリップと重ならない', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    setTrack(
      'bgmT',
      [
        { id: 'A', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 5 },
        { id: 'B', assetId: 'loop', startTime: 4, inPoint: 0, outPoint: 5 },
        { id: 'A~3', assetId: 'loop', startTime: 12, inPoint: 0, outPoint: 5 }
      ],
      5
    )
    st().updateClipSpeed(st().project.clips[0].id, 0.25)
    const ids = track('bgmT').map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('1本に縮んだループの BGM も、伸ばし直すとつなぎ目の重なり・クロスフェードが戻る', () => {
    setup([[0, 30]])
    setTrack('bgmT', [
      { id: 'b1', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 20, fadeOut: 2 },
      { id: 'b2', assetId: 'loop', startTime: 18, inPoint: 0, outPoint: 12, fadeIn: 2 }
    ])
    const id = st().project.clips[0].id
    st().updateClipSpeed(id, 2)
    st().updateClipSpeed(id, 1)
    const back = [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
    expect(back).toHaveLength(2)
    expect(back[1].startTime).toBeCloseTo(18, 6)
    expect(back[0].fadeOut).toBe(2)
    expect(back[1].fadeIn).toBe(2)
  })
})

describe('第20回: まとめて変えたテロップの見た目', () => {
  it('スタイルの管理で OK を押しても、話者のスタイルへ戻らない', () => {
    setup([[0, 10]])
    const telop = (id: string): Project['textOverlays'][number] =>
      ({
        id,
        text: id,
        startTime: 1,
        endTime: 2,
        speaker: '田中',
        styleId: 'S',
        style: { color: '#00ff00' },
        source: 'manual'
      }) as unknown as Project['textOverlays'][number]
    S.setState({ project: { ...st().project, textOverlays: [telop('a'), telop('b')] } })
    st().updateTextOverlaysStyle(['a', 'b'], { color: '#ff0000' })
    st().restyleTextOverlays([
      { id: 'S', name: '田中', style: { color: '#00ff00' } as never, speakers: ['田中'] }
    ])
    const after = st().project.textOverlays
    expect(after.map((o) => o.style.color)).toEqual(['#ff0000', '#ff0000'])
    expect(after.every((o) => o.styleUnlinked === true)).toBe(true)
  })
})

describe('第21回: 壊れたループのつなぎ目の覚え', () => {
  it('読み込みで壊れた値は捨て、曲とほぼ同じ長さの重なりでもループを積み上げない', async () => {
    const { normalizeLoadedProject } = await import('@renderer/store/projectStore')
    const loaded = normalizeLoadedProject({
      assets: [asset('loop', 20, false)],
      audioTracks: [
        {
          id: 't',
          name: 'BGM',
          clips: [
            {
              id: 'x',
              assetId: 'loop',
              startTime: 0,
              inPoint: 0,
              outPoint: 5,
              loopCross: { overlap: 'x' }
            }
          ]
        }
      ]
    } as unknown as Project)
    expect(loaded.audioTracks[0].clips[0].loopCross).toBeUndefined()

    setup([[0, 30]])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', 20, false)],
        audioTracks: p.audioTracks.map((t) =>
          t.id === 'bgmT'
            ? {
                ...t,
                clips: [
                  {
                    id: 'b1',
                    assetId: 'loop',
                    startTime: 0,
                    inPoint: 0,
                    outPoint: 20,
                    loopCross: { overlap: 19.99 }
                  }
                ]
              }
            : t
        )
      }
    })
    st().updateClipSpeed(st().project.clips[0].id, 0.25)
    expect(track('bgmT').length).toBeLessThan(10)
  })
})

describe('第22回: 速さを変えて戻したときの SE・BGM(乱数の通し調査から)', () => {
  const setTrack = (id: string, clips: Project['audioTracks'][number]['clips'], song = 8): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', song, false), asset('sfx2', 2, false)],
        audioTracks: p.audioTracks.map((t) => (t.id === id ? { ...t, clips } : t))
      }
    })
  }

  it('SE は速さを変えて戻すと、元の位置・長さに戻る', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    setTrack('seT', [{ id: 's', assetId: 'sfx2', startTime: 3, inPoint: 0, outPoint: 1 }])
    const c0 = st().project.clips[0].id
    st().updateClipSpeed(c0, 16)
    st().updateClipSpeed(c0, 1)
    expect(track('seT').map((c) => [c.startTime, c.inPoint, c.outPoint])).toEqual([[3, 0, 1]])
  })

  it('切った BGM も、速さを変えて戻すと穴が開かず元に戻る', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const start: Project['audioTracks'][number]['clips'] = [
      { id: 'b1', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 8 },
      { id: 'b2', assetId: 'loop', startTime: 6.5, inPoint: 0, outPoint: 2.5 },
      { id: 'b3', assetId: 'loop', startTime: 9, inPoint: 3.5, outPoint: 8 },
      { id: 'b4', assetId: 'loop', startTime: 12, inPoint: 0, outPoint: 7 }
    ]
    setTrack('bgmT', start)
    const c0 = st().project.clips[0].id
    const gaps = (): number => {
      const cs = [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
      let gap = 0
      for (let i = 1; i < cs.length; i++)
        gap = Math.max(
          gap,
          cs[i].startTime - (cs[i - 1].startTime + cs[i - 1].outPoint - cs[i - 1].inPoint)
        )
      return gap
    }
    st().updateClipSpeed(c0, 0.5)
    expect(gaps()).toBeLessThanOrEqual(1e-6)
    st().updateClipSpeed(c0, 1)
    expect(gaps()).toBeLessThanOrEqual(1e-6)
    const back = [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
    expect(back.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])).toEqual(
      start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])
    )
  })
})

describe('第23回: 第22回修正の見直し', () => {
  const setBgm = (clips: Project['audioTracks'][number]['clips'], song = 20): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', song, false), asset('long', 120, false)],
        audioTracks: p.audioTracks.map((t) => (t.id === 'bgmT' ? { ...t, clips } : t))
      }
    })
  }
  beforeEach(() =>
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
  )

  it('ずらすだけの BGM は、同じ時刻に終わる2本もフェードも落とさない', () => {
    const start: Project['audioTracks'][number]['clips'] = [
      { id: 'b1', assetId: 'loop', startTime: 10, inPoint: 0, outPoint: 20, fadeOut: 1 },
      { id: 'b2', assetId: 'loop', startTime: 28, inPoint: 0, outPoint: 2, fadeIn: 1 }
    ]
    setBgm(start)
    const c0 = st().project.clips[0].id
    st().updateClipSpeed(c0, 2)
    expect(track('bgmT').map((c) => [c.id, c.startTime, c.fadeIn, c.fadeOut])).toEqual([
      ['b1', 5, undefined, 1],
      ['b2', 23, 1, undefined]
    ])
    st().updateClipSpeed(c0, 1)
    expect(track('bgmT').map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])).toEqual(
      start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])
    )
  })

  it('長い BGM に重ねた短いクリップがあっても、関係の無い所の速さで切らない', () => {
    setBgm([
      { id: 'b1', assetId: 'long', startTime: 0, inPoint: 0, outPoint: 15 },
      { id: 'b2', assetId: 'long', startTime: 5, inPoint: 50, outPoint: 52 }
    ])
    // BGM は 15 秒で終わる。後ろ(20〜30秒)のクリップの速さは関係しない
    st().updateClipSpeed(st().project.clips[2].id, 2)
    expect(track('bgmT').map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])).toEqual([
      ['b1', 0, 0, 15],
      ['b2', 5, 50, 52]
    ])
  })
})

describe('第24回: BGM のつなぎ目と、延ばして戻したときの切れ端', () => {
  type BgmClip = Project['audioTracks'][number]['clips'][number]
  const setBgm = (clips: BgmClip[], song = 8): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', song, false), asset('long', 120, false)],
        audioTracks: p.audioTracks.map((t) => (t.id === 'bgmT' ? { ...t, clips } : t))
      }
    })
  }
  const sorted = (): BgmClip[] => [...track('bgmT')].sort((a, b) => a.startTime - b.startTime)
  beforeEach(() =>
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
  )

  it('延ばして戻しても、足したループの切れ端を残さない', () => {
    const start: BgmClip[] = [
      {
        id: 'A',
        assetId: 'loop',
        startTime: 0,
        inPoint: 0,
        outPoint: 8,
        fadeIn: 1.5,
        fadeOut: 1.5
      },
      {
        id: 'B',
        assetId: 'loop',
        startTime: 6.5,
        inPoint: 0,
        outPoint: 8,
        fadeIn: 1.5,
        fadeOut: 1.5
      }
    ]
    setBgm(start)
    const c0 = st().project.clips[0].id
    st().updateClipSpeed(c0, 0.5)
    st().updateClipSpeed(c0, 1)
    expect(sorted().map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])).toEqual(
      start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])
    )
  })

  it('重ねた短いクリップとの重なりを、ループのつなぎ目とみなさない', () => {
    setBgm(
      [
        { id: 'A', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 20 },
        { id: 'N', assetId: 'loop', startTime: 5, inPoint: 10, outPoint: 12, volume: 0.2 }
      ],
      20
    )
    st().updateClipSpeed(st().project.clips[0].id, 0.5)
    const added = sorted().filter((c) => c.id.includes('~'))
    expect(added[0].startTime).toBeCloseTo(20, 6)
  })

  it('ループのつなぎ目は、曲の頭から始め直すクリップとその手前の組から取る', () => {
    setBgm([
      { id: 'A', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 8 },
      { id: 'L', assetId: 'loop', startTime: 7, inPoint: 0, outPoint: 8 },
      { id: 'N', assetId: 'loop', startTime: 9, inPoint: 5, outPoint: 6 }
    ])
    st().updateClipSpeed(st().project.clips[0].id, 0.5)
    const cs = sorted().filter((c) => c.id === 'L' || c.id.includes('~'))
    for (let i = 1; i < cs.length; i++) {
      const prevEnd = cs[i - 1].startTime + cs[i - 1].outPoint - cs[i - 1].inPoint
      expect(prevEnd - cs[i].startTime).toBeCloseTo(1, 6)
    }
  })

  it('縮めても、終わりをまたぐ人が置いたクリップは詰めて残す', () => {
    setBgm([
      { id: 'A', assetId: 'long', startTime: 0, inPoint: 0, outPoint: 30, fadeOut: 2 },
      { id: 'N', assetId: 'long', startTime: 22, inPoint: 60, outPoint: 66, volume: 0.2 }
    ])
    st().updateClipSpeed(st().project.clips[2].id, 2)
    const n = track('bgmT').find((c) => c.id === 'N')
    expect(n).toBeDefined()
    expect(n!.startTime + n!.outPoint - n!.inPoint).toBeCloseTo(25, 6)
  })

  it('曲の長さが 0(分からない)でも、本編の終わりまで延ばす', () => {
    setBgm([{ id: 'A', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 30 }], 0)
    st().updateClipSpeed(st().project.clips[0].id, 0.5)
    const last = sorted()[sorted().length - 1]
    expect(last.startTime + last.outPoint - last.inPoint).toBeCloseTo(40, 6)
  })
})

describe('第25回: 待つ間に素材を差し替えたときの裏の結果', () => {
  it('前のファイルから作ったプロキシ・ノイズ除去の結果は当てない', () => {
    setup([[0, 10]])
    const p = st().project
    S.setState({
      project: { ...p, assets: [...p.assets, { ...asset('X', 10), filePath: '/rec/Y.mp4' }] }
    })
    st().setAssetProxyPath('X', '/proxies/old.mp4', '/rec/X.mp4')
    expect(st().project.assets.find((a) => a.id === 'X')!.proxyPath).toBeUndefined()
    st().setAssetsDenoised({ X: '/clean/old.flac' }, { expectFilePath: { X: '/rec/X.mp4' } })
    expect(st().project.assets.find((a) => a.id === 'X')!.filePath).toBe('/rec/Y.mp4')
  })
})

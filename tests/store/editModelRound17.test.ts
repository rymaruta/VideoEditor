import { beforeEach, describe, expect, it } from 'vitest'
import { commitAsOwnStep, useProjectStore } from '@renderer/store/projectStore'
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
    const session = st().projectSession
    const nar = { ...asset('nar', 5, false), filePath: '/rec/nar.wav' }
    st().addAudioClipWithAsset(nar, { trackName: 'ナレーション', session: session - 1 })
    expect(st().project).toBe(before)
    st().addAudioClipWithAsset(nar, { trackName: 'ナレーション', session })
    expect(st().project.audioTracks.some((t) => t.name === 'ナレーション')).toBe(true)
  })

  it('同じ id の企画(写し・開き直した同じファイル)に替わっていても置かない', () => {
    setup([[0, 10]])
    const session = st().projectSession
    const p = st().project
    // 「名前を付けて保存」した写しを開く(id は同じ)
    st().loadProject({ ...p, name: '写し' }, '/p/ep12.veproj')
    const nar = { ...asset('nar', 5, false), filePath: '/rec/nar.wav' }
    st().addAudioClipWithAsset(nar, { trackName: 'ナレーション', session })
    expect(st().project.audioTracks.some((t) => t.name === 'ナレーション')).toBe(false)
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

describe('第25回: ループの始め直しの扱い', () => {
  type BgmClip = Project['audioTracks'][number]['clips'][number]
  const setBgm = (clips: BgmClip[], song = 8): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', song, false)],
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

  it('延ばしたときに足したループは、手前のクリップが終わりまで届かなければ戻しても残る(穴を開けない)', () => {
    setBgm([
      { id: 'A', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 8 },
      { id: 'B', assetId: 'loop', startTime: 7, inPoint: 0, outPoint: 8 },
      { id: 'C', assetId: 'loop', startTime: 14, inPoint: 0, outPoint: 8 },
      { id: 'D', assetId: 'loop', startTime: 21, inPoint: 0, outPoint: 8 },
      { id: 'E', assetId: 'loop', startTime: 28, inPoint: 0, outPoint: 2 }
    ])
    st().updateClipSpeed(st().project.clips[0].id, 0.5)
    const grown = track('bgmT')
    S.setState({
      project: {
        ...st().project,
        audioTracks: st().project.audioTracks.map((t) =>
          t.id === 'bgmT'
            ? {
                ...t,
                clips: [
                  ...grown,
                  { id: 'N', assetId: 'loop', startTime: 34, inPoint: 2, outPoint: 7, volume: 0.2 }
                ]
              }
            : t
        )
      }
    })
    st().updateClipSpeed(st().project.clips[2].id, 1.25)
    // 本編は 38 秒。曲の本筋(音量そのまま)が終わりまで鳴る
    const main = sorted().filter((c) => c.id !== 'N')
    const last = main.reduce((a, c) =>
      c.startTime + c.outPoint - c.inPoint > a.startTime + a.outPoint - a.inPoint ? c : a
    )
    expect(last.startTime + last.outPoint - last.inPoint).toBeCloseTo(38, 6)
  })

  it('手前のクリップの中で終わる、曲の頭から取った短いクリップをつなぎ目とみなさない', () => {
    setBgm(
      [
        { id: 'A', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 20 },
        { id: 'N', assetId: 'loop', startTime: 5, inPoint: 0, outPoint: 2, volume: 0.2 }
      ],
      20
    )
    st().updateClipSpeed(st().project.clips[0].id, 0.5)
    const added = sorted().filter((c) => c.id.includes('~'))
    expect(added[0].startTime).toBeCloseTo(20, 6)
    expect(track('bgmT').find((c) => c.id === 'A')!.loopCross).toBeUndefined()
  })
})

describe('第26回: 足したループの手前', () => {
  it('手前が重なりより短く、同じ時刻に始まったループも、戻したときに落とす', () => {
    setup([
      [0, 10],
      [20, 24.5]
    ])
    const p = st().project
    const start: Project['audioTracks'][number]['clips'] = [
      {
        id: 'b0',
        assetId: 'loop',
        startTime: 0,
        inPoint: 0,
        outPoint: 8,
        loopCross: { overlap: 2 }
      },
      { id: 'b0~1', assetId: 'loop', startTime: 6, inPoint: 0, outPoint: 8 },
      { id: 'b0~2', assetId: 'loop', startTime: 12, inPoint: 0, outPoint: 2.5 },
      { id: 'u1', assetId: 'loop', startTime: 12.893, inPoint: 6.039, outPoint: 7.646 }
    ]
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', 8, false)],
        audioTracks: p.audioTracks.map((t) => (t.id === 'bgmT' ? { ...t, clips: start } : t))
      }
    })
    const c1 = st().project.clips[1].id
    st().updateClipSpeed(c1, 0.75)
    st().updateClipSpeed(c1, 1)
    const back = [...track('bgmT')].sort(
      (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id)
    )
    expect(
      back.map((c) => [
        c.id,
        +c.startTime.toFixed(6),
        +c.inPoint.toFixed(6),
        +c.outPoint.toFixed(6)
      ])
    ).toEqual(
      [...start]
        .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id))
        .map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])
    )
  })
})

describe('第27回: BGM のループを足すとき', () => {
  it('その位置に人が短くした曲の頭のクリップがあれば、新しく足さずにそこから続ける', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', 8, false)],
        audioTracks: p.audioTracks.map((t) =>
          t.id === 'bgmT'
            ? {
                ...t,
                clips: [
                  {
                    id: 'A',
                    assetId: 'loop',
                    startTime: 14,
                    inPoint: 0,
                    outPoint: 8,
                    loopCross: { overlap: 1.5 }
                  },
                  { id: 'B', assetId: 'loop', startTime: 20.5, inPoint: 0, outPoint: 0.9 }
                ]
              }
            : t
        )
      }
    })
    st().updateClipSpeed(st().project.clips[2].id, 0.8)
    const heads = track('bgmT').filter(
      (c) => c.inPoint === 0 && Math.abs(c.startTime - 20.5) < 1e-6
    )
    expect(heads).toHaveLength(1)
  })

  it('足すループの id は、別のトラックへ移したクリップとも重ならない', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop', 8, false)],
        audioTracks: p.audioTracks.map((t) =>
          t.id === 'bgmT'
            ? { ...t, clips: [{ id: 'X', assetId: 'loop', startTime: 0, inPoint: 0, outPoint: 8 }] }
            : t.id === 'seT'
              ? {
                  ...t,
                  clips: [{ id: 'X~1', assetId: 'loop', startTime: 40, inPoint: 0, outPoint: 1 }]
                }
              : t
        )
      }
    })
    st().updateClipSpeed(st().project.clips[0].id, 0.25)
    const ids = st().project.audioTracks.flatMap((t) => t.clips.map((c) => c.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('第28回: BGM のループの続き', () => {
  type BgmClip = Project['audioTracks'][number]['clips'][number]
  const setBgm = (clips: BgmClip[]): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop10', 10, false)],
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

  it('速さの違うクリップが混ざっていても止まらず、曲の頭を重ねない', () => {
    setBgm([
      {
        id: 'F',
        assetId: 'loop10',
        startTime: 0,
        inPoint: 0,
        outPoint: 10,
        loopCross: { overlap: 5 }
      },
      { id: 'G', assetId: 'loop10', startTime: 5, inPoint: 0, outPoint: 10, speed: 2 }
    ])
    st().updateClipSpeed(st().project.clips[0].id, 0.5)
    const cs = track('bgmT')
    expect(cs.length).toBeLessThan(50)
    const heads = cs.filter((c) => c.inPoint === 0).map((c) => c.startTime.toFixed(6))
    expect(new Set(heads).size).toBe(heads.length)
  })

  it('人が短くしたループは、延ばして戻すと元の長さに戻る', () => {
    const start: BgmClip[] = [
      { id: 'A', assetId: 'loop10', startTime: 0, inPoint: 0, outPoint: 10 },
      { id: 'B', assetId: 'loop10', startTime: 8, inPoint: 0, outPoint: 10 },
      { id: 'C', assetId: 'loop10', startTime: 16, inPoint: 0, outPoint: 0.1 }
    ]
    setBgm(start)
    const c1 = st().project.clips[1].id
    st().updateClipSpeed(c1, 0.5)
    st().updateClipSpeed(c1, 1)
    expect(
      [...track('bgmT')]
        .sort((a, b) => a.startTime - b.startTime)
        .map((c) => [c.id, +c.startTime.toFixed(6), +c.inPoint.toFixed(6), +c.outPoint.toFixed(6)])
    ).toEqual(start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint]))
  })
})

describe('第29回: BGM のループの続きの見直し', () => {
  type BgmClip = Project['audioTracks'][number]['clips'][number]
  const setBgm = (clips: BgmClip[]): void => {
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, asset('loop10', 10, false)],
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

  it('最後のループを人が分けていても、人が短くした曲の頭のクリップを見つけて二重に鳴らさない', () => {
    setBgm([
      {
        id: 'A',
        assetId: 'loop10',
        startTime: 0,
        inPoint: 0,
        outPoint: 10,
        loopCross: { overlap: 2 }
      },
      { id: 'A~1', assetId: 'loop10', startTime: 8, inPoint: 0, outPoint: 7 },
      { id: 'x', assetId: 'loop10', startTime: 15, inPoint: 7, outPoint: 10 },
      { id: 'C', assetId: 'loop10', startTime: 16, inPoint: 0, outPoint: 0.1 }
    ])
    st().updateClipSpeed(st().project.clips[1].id, 0.5)
    expect(
      track('bgmT').some((c) => c.inPoint === 0 && c.startTime > 16 + 1e-6 && c.startTime < 17)
    ).toBe(false)
  })

  it('速さの違うクリップの続きは、元の終わりの手前で終わっても、戻すと消える', () => {
    const start: BgmClip[] = [
      {
        id: 'A',
        assetId: 'loop10',
        startTime: 0,
        inPoint: 0,
        outPoint: 10,
        loopCross: { overlap: 5 }
      },
      { id: 'B', assetId: 'loop10', startTime: 5, inPoint: 0, outPoint: 3, speed: 2 }
    ]
    setBgm(start)
    const c0 = st().project.clips[0].id
    st().updateClipSpeed(c0, 0.1)
    st().updateClipSpeed(c0, 1)
    expect(
      [...track('bgmT')]
        .sort((a, b) => a.startTime - b.startTime)
        .map((c) => [c.id, +c.startTime.toFixed(6), +c.inPoint.toFixed(6), +c.outPoint.toFixed(6)])
    ).toEqual(start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint]))
  })
})

describe('第30回: BGM のループの続きの見直し', () => {
  type BgmClip = Project['audioTracks'][number]['clips'][number]
  /** 本編 m1(0〜10)・m2(10〜progEnd)と、BGM の並び */
  const setupBgm = (clips: BgmClip[], progEnd: number): void => {
    S.setState({
      project: {
        id: 'p',
        name: 'x',
        aspectRatio: '16:9',
        multicam: {
          anchorSourceId: 'A',
          sources: [{ id: 'A', name: 'A', kind: 'camera' }],
          files: [{ assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 }]
        },
        assets: [asset('camA', 100), asset('loop10', 10, false)],
        clips: [
          { id: 'm1', assetId: 'camA', inPoint: 0, outPoint: 10, speed: 1 },
          { id: 'm2', assetId: 'camA', inPoint: 20, outPoint: 20 + progEnd - 10, speed: 1 }
        ],
        audioTracks: [
          {
            id: 'bgmT',
            name: 'BGM',
            volume: 1,
            muted: false,
            duckingEnabled: true,
            autoRole: 'bgm',
            clips
          }
        ],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      } as unknown as Project,
      past: [],
      future: []
    })
  }
  const shape = (): (string | number)[][] =>
    [...st().project.audioTracks[0].clips]
      .sort((a, b) => a.startTime - b.startTime)
      .map((c) => [c.id, +c.startTime.toFixed(6), +c.inPoint.toFixed(6), +c.outPoint.toFixed(6)])

  it('人が分けた所が、短くした曲の頭のクリップより後ろでも、延ばして戻すと元に戻る', () => {
    const start: BgmClip[] = [
      {
        id: 'A',
        assetId: 'loop10',
        startTime: 0,
        inPoint: 0,
        outPoint: 10,
        loopCross: { overlap: 2 }
      },
      { id: 'A~1', assetId: 'loop10', startTime: 8, inPoint: 0, outPoint: 9 },
      { id: 'C', assetId: 'loop10', startTime: 16, inPoint: 0, outPoint: 0.5 },
      { id: 'x', assetId: 'loop10', startTime: 17, inPoint: 9, outPoint: 10 }
    ]
    setupBgm(start, 18)
    st().updateClipSpeed('m2', 0.5)
    st().updateClipSpeed('m2', 1)
    expect(shape()).toEqual(start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint]))
  })

  it('人が分けた倍速のループの手前の半分から、続きを足し直して同じ音を二重に鳴らさない', () => {
    setupBgm(
      [
        {
          id: 'A',
          assetId: 'loop10',
          startTime: 0,
          inPoint: 0,
          outPoint: 10,
          loopCross: { overlap: 5 }
        },
        { id: 'R', assetId: 'loop10', startTime: 8, inPoint: 0, outPoint: 4, speed: 2 },
        { id: 'x', assetId: 'loop10', startTime: 10, inPoint: 4, outPoint: 10, speed: 2 }
      ],
      13
    )
    st().updateClipSpeed('m2', 0.5)
    const clips = st().project.audioTracks[0].clips
    for (const c of clips) {
      const twins = clips.filter(
        (o) =>
          o !== c &&
          Math.abs(o.startTime - c.startTime) < 1e-6 &&
          Math.abs(o.inPoint - c.inPoint) < 1e-6 &&
          Math.abs(o.outPoint - c.outPoint) < 1e-6
      )
      expect(twins, `${c.id}`).toEqual([])
    }
    // 終わり(16)まで鳴っている
    expect(
      Math.max(...clips.map((c) => c.startTime + (c.outPoint - c.inPoint) / (c.speed || 1)))
    ).toBeCloseTo(16, 6)
  })

  it('人が短くした手前に続く頭からのループは、速くして戻しても手前を延ばさず元に戻る', () => {
    const cases: BgmClip[][] = [
      [
        { id: 'A', assetId: 'loop10', startTime: 0, inPoint: 0, outPoint: 6 },
        { id: 'A~1', assetId: 'loop10', startTime: 6, inPoint: 0, outPoint: 10 }
      ],
      [
        {
          id: 'A',
          assetId: 'loop10',
          startTime: 0,
          inPoint: 0,
          outPoint: 7,
          loopCross: { overlap: 2 }
        },
        { id: 'A~1', assetId: 'loop10', startTime: 5, inPoint: 0, outPoint: 10 }
      ]
    ]
    for (const start of cases) {
      const progEnd = start[1].startTime + 10
      for (const speed of [2, 4]) {
        setupBgm(start, progEnd)
        st().updateClipSpeed('m2', speed)
        expect(st().project.audioTracks[0].clips.find((c) => c.id === 'A')?.outPoint).toBe(
          start[0].outPoint
        )
        st().updateClipSpeed('m2', 1)
        expect(shape(), `x${speed}`).toEqual(
          start.map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])
        )
      }
    }
  })
})

describe('第32回: BGM は元の並びから作り直す', () => {
  type BgmClip = Project['audioTracks'][number]['clips'][number]
  /** 本編 m1(0〜10)・m2(10〜progEnd)と、BGM の並び */
  const setupBgm = (clips: BgmClip[], progEnd: number): void => {
    S.setState({
      project: {
        id: 'p',
        name: 'x',
        aspectRatio: '16:9',
        multicam: {
          anchorSourceId: 'A',
          sources: [{ id: 'A', name: 'A', kind: 'camera' }],
          files: [{ assetId: 'camA', sourceId: 'A', start: 0, rate: 1, duration: 100 }]
        },
        assets: [asset('camA', 100), asset('loop10', 10, false)],
        clips: [
          { id: 'm1', assetId: 'camA', inPoint: 0, outPoint: 10, speed: 1 },
          { id: 'm2', assetId: 'camA', inPoint: 20, outPoint: 20 + progEnd - 10, speed: 1 }
        ],
        audioTracks: [
          {
            id: 'bgmT',
            name: 'BGM',
            volume: 1,
            muted: false,
            duckingEnabled: true,
            autoRole: 'bgm',
            clips
          }
        ],
        videoOverlayTracks: [],
        textOverlays: [],
        beatGrid: null
      } as unknown as Project,
      past: [],
      future: []
    })
  }
  const shape = (): (string | number)[][] =>
    [...st().project.audioTracks[0].clips]
      .sort((a, b) => a.startTime - b.startTime)
      .map((c) => [c.id, +c.startTime.toFixed(6), +c.inPoint.toFixed(6), +c.outPoint.toFixed(6)])

  const start = (): BgmClip[] => [
    {
      id: 'A',
      assetId: 'loop10',
      startTime: 0,
      inPoint: 0,
      outPoint: 10,
      loopCross: { overlap: 2, fadeIn: 1, fadeOut: 1 }
    },
    { id: 'A~1', assetId: 'loop10', startTime: 8, inPoint: 0, outPoint: 10, fadeIn: 1, fadeOut: 1 },
    { id: 'A~2', assetId: 'loop10', startTime: 16, inPoint: 0, outPoint: 2, fadeIn: 1, fadeOut: 2 }
  ]
  const asStart = (): (string | number)[][] =>
    start().map((c) => [c.id, c.startTime, c.inPoint, c.outPoint])

  it('縮めて外れたクリップの id を、延ばしたときに作るループに使わない', () => {
    setupBgm(start(), 18)
    st().updateClipSpeed('m1', 4)
    st().updateClipSpeed('m1', 0.25)
    const ids = st().project.audioTracks[0].clips.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('どんな速さを何回変えても、元の速さに戻せば元の並びそのものに戻る', () => {
    for (const steps of [
      [
        ['m1', 4],
        ['m2', 0.3],
        ['m1', 1],
        ['m2', 1]
      ],
      [
        ['m2', 0.5],
        ['m2', 2],
        ['m2', 1]
      ],
      [
        ['m1', 0.25],
        ['m2', 3],
        ['m2', 1],
        ['m1', 1]
      ],
      [
        ['m2', 1.5],
        ['m1', 0.8],
        ['m2', 0.4],
        ['m1', 1],
        ['m2', 1]
      ]
    ] as [string, number][][]) {
      setupBgm(start(), 18)
      for (const [id, sp] of steps) st().updateClipSpeed(id, sp)
      expect(shape(), JSON.stringify(steps)).toEqual(asStart())
      expect(st().project.audioTracks[0].speedBase).toBeUndefined()
    }
  })

  it('速さを変えた途中でも、曲が二重に鳴らず、終わりまで隙間なく鳴る', () => {
    for (const sp of [0.2, 0.5, 0.8, 1.25, 2, 4]) {
      setupBgm(start(), 18)
      st().updateClipSpeed('m2', sp)
      const clips = [...st().project.audioTracks[0].clips].sort((a, b) => a.startTime - b.startTime)
      const end = 10 + 8 / sp
      const ends = clips.map((c) => c.startTime + (c.outPoint - c.inPoint) / (c.speed || 1))
      expect(Math.max(...ends), `x${sp}`).toBeCloseTo(end, 6)
      // 隙間なし
      let cur = 0
      for (let k = 0; k < clips.length; k++) {
        expect(clips[k].startTime, `x${sp} gap`).toBeLessThanOrEqual(cur + 1e-6)
        cur = Math.max(cur, ends[k])
      }
      // 同じ時刻に曲の同じ所を2本で鳴らさない
      for (let a = 0; a < clips.length; a++)
        for (let b = a + 1; b < clips.length; b++) {
          const ov = Math.min(ends[a], ends[b]) - Math.max(clips[a].startTime, clips[b].startTime)
          if (ov <= 1e-6) continue
          const srcA = clips[a].inPoint - clips[a].startTime
          const srcB = clips[b].inPoint - clips[b].startTime
          expect(Math.abs(srcA - srcB), `x${sp} twice`).toBeGreaterThan(1e-6)
        }
    }
  })

  it('人が BGM を直したら、その並びを新しい元にする(直したものを戻さない)', () => {
    setupBgm(start(), 18)
    st().updateClipSpeed('m2', 0.5)
    const clips = st().project.audioTracks[0].clips
    st().updateAudioClipTrim('bgmT', clips[0].id, 0, 6)
    const edited = st().project.audioTracks[0].clips.find((c) => c.id === clips[0].id)!
    expect(edited.outPoint).toBe(6)
    st().updateClipSpeed('m2', 1)
    expect(st().project.audioTracks[0].clips.find((c) => c.id === 'A')?.outPoint).toBe(6)
  })

  it('保存して読み直しても、速さを戻せば元の並びに戻る', async () => {
    setupBgm(start(), 18)
    st().updateClipSpeed('m2', 0.5)
    const { normalizeLoadedProject } = await import('@renderer/store/projectStore')
    const loaded = normalizeLoadedProject(JSON.parse(JSON.stringify(st().project)))
    S.setState({ project: loaded })
    st().updateClipSpeed('m2', 1)
    expect(shape()).toEqual(asStart())
  })
})

describe('第32回: 履歴とアングル', () => {
  const track = (id: string): Project['audioTracks'][number]['clips'] =>
    st().project.audioTracks.find((t) => t.id === id)?.clips ?? []
  const micClips = (): number[][] =>
    st()
      .project.audioTracks.filter((t) => t.multicamSourceId === 'M')
      .flatMap((t) => t.clips.map((c) => [c.startTime, c.inPoint, c.outPoint]))

  it('ロールのドラッグを行って戻しても、自動の SE とマイクの声は元のまま', async () => {
    const { beginHistoryGesture, endHistoryGesture } = await import('@renderer/store/projectStore')
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const mic = micClips()
    const [l, r] = st().project.clips
    beginHistoryGesture(`roll:${l.id}:${r.id}`)
    st().rollTrim(l.id, r.id, 4)
    st().rollTrim(l.id, r.id, -4)
    endHistoryGesture()
    expect(track('seT').map((c) => c.startTime)).toEqual([13])
    expect(micClips()).toEqual(mic)
  })

  it('ロールで途中まで行って少し戻した結果は、1回で同じ所まで動かしたのと同じ', async () => {
    const { beginHistoryGesture, endHistoryGesture } = await import('@renderer/store/projectStore')
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const [l, r] = st().project.clips
    st().rollTrim(l.id, r.id, 1)
    const once = { se: track('seT').map((c) => c.startTime), mic: micClips() }
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const [l2, r2] = st().project.clips
    beginHistoryGesture(`roll:${l2.id}:${r2.id}`)
    st().rollTrim(l2.id, r2.id, 4)
    st().rollTrim(l2.id, r2.id, -3)
    endHistoryGesture()
    expect({ se: track('seT').map((c) => c.startTime), mic: micClips() }).toEqual(once)
  })

  it('速さを変えたクリップのアングルを替えても、自動の BGM・SE は動かない', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        multicam: {
          ...p.multicam!,
          sources: [...p.multicam!.sources, { id: 'B', name: 'カメラB', kind: 'camera' }],
          files: [
            ...p.multicam!.files,
            { assetId: 'camB', sourceId: 'B', start: 2, rate: 1, duration: 100 }
          ]
        },
        assets: [...p.assets, asset('camB', 100)]
      }
    })
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 1.25)
    const before = st().project.audioTracks.filter((t) => t.autoRole)
    st().switchClipAngle(id, 'B')
    expect(st().project.clips[1].assetId).toBe('camB')
    expect(st().project.audioTracks.filter((t) => t.autoRole)).toEqual(before)
  })
})

describe('第32回: 裏で置いた自動の音と取り消し', () => {
  it('置くまでの間に別の所を直していても、その直しを取り消して置いた BGM は消えない', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    // setup が足した自動のトラックは外し、仮編集を入れた直後の状態から始める
    S.setState({
      project: {
        ...st().project,
        audioTracks: st().project.audioTracks.filter((t) => !t.autoRole)
      }
    })
    const afterCut = st().project.clips
    st().setAspectRatio('9:16')
    st().setAutoSounds(
      [
        {
          role: 'bgm',
          clips: [{ path: '/kit/bgm.mp3', startTime: 0, inPoint: 0, outPoint: 20, volume: 0.3 }]
        }
      ] as never,
      [{ ...asset('bgmA', 60, false), filePath: '/kit/bgm.mp3' }],
      afterCut
    )
    st().undo()
    expect(st().project.aspectRatio).toBe('16:9')
    expect(st().project.audioTracks.some((t) => t.autoRole === 'bgm')).toBe(true)
    expect(st().project.assets.some((a) => a.filePath === '/kit/bgm.mp3')).toBe(true)
    st().redo()
    expect(st().project.aspectRatio).toBe('9:16')
    expect(st().project.audioTracks.filter((t) => t.autoRole === 'bgm')).toHaveLength(1)
  })
})

describe('第33回: 第32回修正の見直し', () => {
  it('トリムをまとめて書き込んでも、テロップの並び順(重なりの上下)は変わらない', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const [c0, c1] = st().project.clips
    const base = { style: st().project.textOverlays[0]?.style } as Record<string, unknown>
    S.setState({
      project: {
        ...st().project,
        textOverlays: [
          {
            ...base,
            id: 'linkedT',
            text: 'a',
            startTime: 12,
            endTime: 13,
            linkedClipId: c1.id,
            linkOffset: 2
          },
          { ...base, id: 'manualT', text: 'b', startTime: 12, endTime: 13 }
        ] as never
      }
    })
    st().updateClipTrim(c0.id, 0, 9)
    const first = st().project.textOverlays.map((o) => o.id)
    st().updateClipTrim(c0.id, 0, 8)
    expect([first, st().project.textOverlays.map((o) => o.id)]).toEqual([
      ['linkedT', 'manualT'],
      ['linkedT', 'manualT']
    ])
  })

  it('用意している間に同じ曲を人が読み込んでいても、取り消した後の BGM は一覧にある素材を指す', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    S.setState({
      project: {
        ...st().project,
        audioTracks: st().project.audioTracks.filter((t) => !t.autoRole)
      }
    })
    const afterCut = st().project.clips
    st().addAsset({ ...asset('userBgm', 60, false), filePath: '/kit/bgm.mp3' })
    st().setAutoSounds(
      [
        {
          role: 'bgm',
          clips: [{ path: '/kit/bgm.mp3', startTime: 0, inPoint: 0, outPoint: 20, volume: 0.3 }]
        }
      ] as never,
      [{ ...asset('pipelineBgm', 60, false), filePath: '/kit/bgm.mp3' }],
      afterCut
    )
    const dangling = (): string[] => {
      const ids = new Set(st().project.assets.map((a) => a.id))
      return st()
        .project.audioTracks.flatMap((t) => t.clips.map((c) => c.assetId))
        .filter((id) => !ids.has(id))
    }
    expect(dangling()).toEqual([])
    st().undo()
    expect(st().project.audioTracks.some((t) => t.autoRole === 'bgm')).toBe(true)
    expect(dangling()).toEqual([])
    // 同じ曲を一覧に2つ並べない
    expect(
      st()
        .project.assets.filter((a) => a.filePath === '/kit/bgm.mp3')
        .map((a) => a.id)
    ).toEqual(['userBgm'])
  })

  it('用意している間につなぎ直していても、取り消した後の BGM はつなぎ直した先のファイルを指す', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    S.setState({
      project: {
        ...st().project,
        assets: [...st().project.assets, { ...asset('U', 60, false), filePath: '/old/bgm.mp3' }],
        audioTracks: st().project.audioTracks.filter((t) => !t.autoRole)
      }
    })
    const afterCut = st().project.clips
    st().relinkAsset(
      'U',
      '/kit/bgm.mp3',
      'bgm.mp3',
      { duration: 60, width: 0, height: 0, fps: 0, hasAudio: true, hasVideo: false },
      undefined
    )
    st().setAutoSounds(
      [
        {
          role: 'bgm',
          clips: [{ path: '/kit/bgm.mp3', startTime: 0, inPoint: 0, outPoint: 20, volume: 0.3 }]
        }
      ] as never,
      [{ ...asset('pipelineBgm', 60, false), filePath: '/kit/bgm.mp3' }],
      afterCut
    )
    st().undo()
    const p = st().project
    const bgm = p.audioTracks.find((t) => t.autoRole === 'bgm')!
    expect(bgm.clips.map((c) => p.assets.find((a) => a.id === c.assetId)?.filePath)).toEqual([
      '/kit/bgm.mp3'
    ])
    // id は重ならない
    const ids = p.assets.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('第35回: アングルを替える先', () => {
  it('静止画・映像の無い素材になったカメラへは、アングルを替えない', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        multicam: {
          ...p.multicam!,
          sources: [...p.multicam!.sources, { id: 'B', name: 'カメラB', kind: 'camera' }],
          files: [
            ...p.multicam!.files,
            { assetId: 'camB', sourceId: 'B', start: 0, rate: 1, duration: 100 }
          ]
        },
        assets: [...p.assets, { ...asset('camB', 3600), still: true }]
      }
    })
    const id = st().project.clips[0].id
    st().switchClipAngle(id, 'B')
    expect(st().project.clips[0].assetId).toBe('camA')
  })
})

describe('第43回: 収録の音のトラックに人が置いた音', () => {
  it('下のクリップの速さを変えて戻しても、マイクのトラックに置いたナレーションは消えない', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const p = st().project
    const mic = p.audioTracks.find((t) => t.multicamSourceId === 'M')!
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, { ...asset('nar', 5, false), filePath: '/rec/nar.wav' }],
        audioTracks: p.audioTracks.map((t) =>
          t.id === mic.id
            ? {
                ...t,
                clips: [
                  ...t.clips,
                  { id: 'narC', assetId: 'nar', startTime: 12, inPoint: 0, outPoint: 2 }
                ]
              }
            : t
        )
      }
    })
    const id = st().project.clips[1].id
    const narOn = (): boolean =>
      st().project.audioTracks.some((t) => t.clips.some((c) => c.id === 'narC'))
    st().updateClipSpeed(id, 1.5)
    expect(narOn()).toBe(true)
    st().updateClipSpeed(id, 1)
    expect(narOn()).toBe(true)
  })
})

describe('第44回: 収録のカメラのワイプに人が置いた画', () => {
  const withLogo = (): void => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, { ...asset('logo', 5), filePath: '/rec/logo.png' }],
        videoOverlayTracks: [
          {
            id: 'faceT',
            name: '顔',
            multicamSourceId: 'A',
            hidden: false,
            position: 'top-right',
            scale: 0.3,
            clips: [
              { id: 'f1', assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 },
              { id: 'f2', assetId: 'camA', startTime: 10, inPoint: 20, outPoint: 30 },
              { id: 'f3', assetId: 'camA', startTime: 20, inPoint: 40, outPoint: 50 },
              { id: 'logoC', assetId: 'logo', startTime: 12, inPoint: 0, outPoint: 2 }
            ]
          }
        ]
      } as unknown as Project
    })
  }
  const logoOn = (): boolean =>
    st().project.videoOverlayTracks.some((t) => t.clips.some((c) => c.assetId === 'logo'))

  it('速さを変えて戻しても、仮編集を作り直しても消えない', () => {
    withLogo()
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 1.5)
    expect(logoOn()).toBe(true)
    st().updateClipSpeed(id, 1)
    expect(logoOn()).toBe(true)
    st().applyRoughCut(
      {
        main: [
          [0, 10],
          [20, 30]
        ].map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
        audio: [
          {
            name: '出演者A',
            sourceId: 'M',
            volume: 1,
            clips: [{ assetId: 'micM', startTime: 0, inPoint: 0, outPoint: 10, speed: 1 }]
          }
        ],
        overlays: [
          {
            name: '顔',
            sourceId: 'A',
            clips: [{ assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 }]
          }
        ],
        duration: 20,
        spans: []
      } as never,
      []
    )
    expect(logoOn()).toBe(true)
  })

  it('移した画のトラックは、編集のたびに増えずに同じ名前の1本にまとまる', () => {
    withLogo()
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 1.5)
    st().updateClipSpeed(id, 1)
    st().updateClipSpeed(id, 2)
    const names = st().project.videoOverlayTracks.map((t) => t.name)
    expect(names.filter((n) => n === '顔(手で置いた画)').length).toBeLessThanOrEqual(1)
  })
})

describe('第45回: 移した画はカメラの上に重ねる', () => {
  const rough = (
    overlayClips: { assetId: string; startTime: number; inPoint: number; outPoint: number }[]
  ): void =>
    st().applyRoughCut(
      {
        main: [
          [0, 10],
          [20, 30]
        ].map(([a, b]) => ({ assetId: 'camA', inPoint: a, outPoint: b, speed: 1 })),
        audio: [
          {
            name: '出演者A',
            sourceId: 'M',
            volume: 1,
            clips: [{ assetId: 'micM', startTime: 0, inPoint: 0, outPoint: 10, speed: 1 }]
          }
        ],
        overlays: [{ name: '顔', sourceId: 'A', clips: overlayClips }],
        duration: 20,
        spans: []
      } as never,
      []
    )
  const cams = [
    { assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 },
    { assetId: 'camA', startTime: 10, inPoint: 20, outPoint: 30 }
  ]
  const order = (assetId: string): { cam: number; hand: number } => {
    const ts = st().project.videoOverlayTracks
    return {
      cam: ts.findIndex((t) => t.multicamSourceId === 'A'),
      hand: ts.findIndex((t) => !t.multicamSourceId && t.clips.some((c) => c.assetId === assetId))
    }
  }

  it('仮編集を作り直しても、ワイプに置いた画はカメラの上(後ろの段)', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, { ...asset('logo', 5), filePath: '/rec/logo.png' }],
        videoOverlayTracks: [
          {
            id: 'faceT',
            name: '顔',
            multicamSourceId: 'A',
            hidden: false,
            position: 'top-right',
            scale: 0.3,
            clips: [
              { id: 'f1', assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 },
              { id: 'f2', assetId: 'camA', startTime: 10, inPoint: 20, outPoint: 30 },
              { id: 'logoC', assetId: 'logo', startTime: 12, inPoint: 0, outPoint: 2 }
            ]
          }
        ]
      } as unknown as Project
    })
    rough(cams)
    const o = order('logo')
    expect(o.hand).toBeGreaterThan(o.cam)
    // 作り直した後にまた置いた画も、まとめた先がカメラの上
    const q = st().project
    S.setState({
      project: {
        ...q,
        assets: [...q.assets, { ...asset('logo2', 5), filePath: '/rec/logo2.png' }],
        videoOverlayTracks: q.videoOverlayTracks.map((t) =>
          t.multicamSourceId === 'A'
            ? {
                ...t,
                clips: [
                  ...t.clips,
                  { id: 'logo2C', assetId: 'logo2', startTime: 15, inPoint: 0, outPoint: 2 }
                ]
              }
            : t
        )
      }
    })
    commitAsOwnStep('t', () => st().updateClipTrim(st().project.clips[0].id, 0, 7))
    const o2 = order('logo2')
    expect(o2.hand).toBeGreaterThan(o2.cam)
  })
})

describe('第44回: 収録の音のトラックから移した音のトラック', () => {
  it('2回目に移した音も同じ「(手で置いた音)」の1本にまとまり、声の基準の印も引き継ぐ', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const addNarration = (id: string, at: number): void => {
      const p = st().project
      const mic = p.audioTracks.find((t) => t.multicamSourceId === 'M')!
      S.setState({
        project: {
          ...p,
          assets: p.assets.some((a) => a.id === 'nar')
            ? p.assets
            : [...p.assets, { ...asset('nar', 5, false), filePath: '/rec/nar.wav' }],
          audioTracks: p.audioTracks.map((t) =>
            t.id === mic.id
              ? {
                  ...t,
                  voice: true,
                  clips: [
                    ...t.clips,
                    { id, assetId: 'nar', startTime: at, inPoint: 0, outPoint: 2 }
                  ]
                }
              : t
          )
        }
      })
    }
    // 1回ずつの操作として書く(ナレーションを置くのは履歴を区切る操作なので、続けてのトリムとまとめない)
    const trimTo = (out: number): void => {
      const c = st().project.clips[0].id
      commitAsOwnStep(`t:${out}`, () => st().updateClipTrim(c, 0, out))
    }
    addNarration('n1', 3)
    trimTo(8)
    addNarration('n2', 5)
    trimTo(6)
    const hand = st().project.audioTracks.filter((t) => t.name.endsWith('(手で置いた音)'))
    expect(hand).toHaveLength(1)
    expect(hand[0].voice).toBe(true)
    expect(hand[0].clips.map((c) => c.id).sort()).toEqual(['n1', 'n2'])
  })
})

describe('第46回: 重なりの順の小さな2件', () => {
  it('前の版でカメラより下に置かれた「(手で置いた画)」は、作り直すとカメラのすぐ上へ戻る', () => {
    setup([
      [0, 10],
      [20, 30]
    ])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, { ...asset('logo', 5), filePath: '/rec/logo.png' }],
        videoOverlayTracks: [
          {
            id: 'handT',
            name: '顔(手で置いた画)',
            hidden: false,
            position: 'top-right',
            scale: 0.3,
            clips: [{ id: 'logoC', assetId: 'logo', startTime: 12, inPoint: 0, outPoint: 2 }]
          },
          {
            id: 'faceT',
            name: '顔',
            multicamSourceId: 'A',
            hidden: false,
            position: 'top-right',
            scale: 0.3,
            clips: [{ id: 'f1', assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 }]
          }
        ]
      } as unknown as Project
    })
    st().applyRoughCut(
      {
        main: [{ assetId: 'camA', inPoint: 0, outPoint: 10, speed: 1 }],
        audio: [],
        overlays: [
          {
            name: '顔',
            sourceId: 'A',
            clips: [{ assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 }]
          }
        ],
        duration: 10,
        spans: []
      } as never,
      []
    )
    const names = st().project.videoOverlayTracks.map((t) => t.name)
    expect(names.indexOf('顔(手で置いた画)')).toBeGreaterThan(names.indexOf('顔'))
  })

  it('自動の CG を置き直しても、後から足したトラックとの重なりの順は元のまま', () => {
    setup([[0, 10]])
    const cg = (t: number): never =>
      [{ path: '/kit/cg.png', startTime: t, inPoint: 0, outPoint: 2 }] as never
    const cgAsset = { ...asset('cg', 3600), filePath: '/kit/cg.png', still: true }
    st().setAutoCg(cg(1), [cgAsset])
    const p = st().project
    S.setState({
      project: {
        ...p,
        videoOverlayTracks: [
          ...p.videoOverlayTracks,
          { id: 'logoT', name: 'ロゴ', hidden: false, position: 'top-left', scale: 0.2, clips: [] }
        ]
      } as unknown as Project
    })
    st().setAutoCg(cg(3), [cgAsset])
    expect(st().project.videoOverlayTracks.map((t) => t.name)).toEqual(['CG(自動)', 'ロゴ'])
  })
})

describe('第47回: 古い企画の「(手で置いた画)」の並び', () => {
  const run = (tracks: unknown[]): string[] => {
    setup([[0, 10]])
    const p = st().project
    S.setState({
      project: {
        ...p,
        assets: [...p.assets, { ...asset('logo', 5), filePath: '/rec/logo.png' }],
        videoOverlayTracks: tracks
      } as unknown as Project
    })
    st().applyRoughCut(
      {
        main: [{ assetId: 'camA', inPoint: 0, outPoint: 10, speed: 1 }],
        audio: [],
        overlays: [
          {
            name: '顔',
            sourceId: 'A',
            clips: [{ assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 }]
          }
        ],
        duration: 10,
        spans: []
      } as never,
      []
    )
    return st().project.videoOverlayTracks.map((t) => t.name)
  }
  const hand = (id: string, name: string): unknown => ({
    id,
    name,
    hidden: false,
    position: 'top-right',
    scale: 0.3,
    clips: [{ id: `${id}c`, assetId: 'logo', startTime: 2, inPoint: 0, outPoint: 2 }]
  })
  const cam = (name: string): unknown => ({
    id: 'camT',
    name,
    multicamSourceId: 'A',
    hidden: false,
    position: 'top-right',
    scale: 0.3,
    clips: [{ id: 'f1', assetId: 'camA', startTime: 0, inPoint: 0, outPoint: 10 }]
  })

  it('カメラの名前を変えていた企画でも、カメラのすぐ上へ戻す', () => {
    expect(run([hand('h1', 'Face(手で置いた画)'), cam('Face')])).toEqual([
      '顔',
      'Face(手で置いた画)'
    ])
  })

  it('同じ名前のトラックが2本下にあっても、どちらもカメラの上へ戻す', () => {
    const names = run([hand('h1', '顔(手で置いた画)'), hand('h2', '顔(手で置いた画)'), cam('顔')])
    expect(names[0]).toBe('顔')
  })
})

describe('速さを変えた区間の声は、同じ速さで鳴らして残す', () => {
  const voice = (): { start: number; end: number; src: [number, number] }[] =>
    st()
      .project.audioTracks.filter((t) => t.multicamSourceId === 'M')
      .flatMap((t) => t.clips)
      .filter((c) => c.assetId === 'micM')
      .map((c) => ({
        start: +c.startTime.toFixed(6),
        end: +(c.startTime + (c.outPoint - c.inPoint) / (c.speed || 1)).toFixed(6),
        src: [+c.inPoint.toFixed(6), +c.outPoint.toFixed(6)] as [number, number]
      }))
      .sort((a, b) => a.start - b.start)

  it('1.5 倍にすると、その区間の声は 1.5 倍で鳴り、本編の長さと合う', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    st().updateClipSpeed(st().project.clips[1].id, 1.5)
    const v = voice()
    const mid = v.find((x) => x.src[0] === 20)!
    expect(mid.start).toBeCloseTo(10, 6)
    expect(mid.end).toBeCloseTo(10 + 10 / 1.5, 6)
    // 隙間なく続く
    expect(v[v.length - 1].end).toBeCloseTo(10 + 10 / 1.5 + 10, 6)
  })

  it('速さを戻すと、元の声の並び(位置・素材の範囲)に戻る', () => {
    setup([
      [0, 10],
      [20, 30],
      [40, 50]
    ])
    const before = voice()
    const id = st().project.clips[1].id
    st().updateClipSpeed(id, 1.5)
    st().updateClipSpeed(id, 1)
    const after = voice()
    // 切れ端に分かれていても、鳴る所と素材の範囲は同じ
    const cover = (xs: typeof before): string =>
      xs.map((x) => `${x.start}-${x.end}:${x.src[0]}-${x.src[1]}`).join(',')
    const merge = (xs: typeof before): typeof before =>
      xs.reduce<typeof before>((acc, x) => {
        const last = acc[acc.length - 1]
        if (last && Math.abs(last.end - x.start) < 1e-6 && Math.abs(last.src[1] - x.src[0]) < 1e-6)
          acc[acc.length - 1] = { start: last.start, end: x.end, src: [last.src[0], x.src[1]] }
        else acc.push({ ...x })
        return acc
      }, [])
    expect(cover(merge(after))).toBe(cover(merge(before)))
  })
})

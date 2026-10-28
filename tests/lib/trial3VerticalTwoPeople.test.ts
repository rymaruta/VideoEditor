import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import {
  applyVerticalFill,
  assignSpeakers,
  decideFraming,
  mouthActivity,
  prepareVerticalFill,
  speakerShots,
  stackFacesOnCanvas,
  verticalSamples,
  windowFraction,
  type FaceSample
} from '@renderer/lib/verticalFraming'
import { useSettingsStore } from '@renderer/store/settingsStore'
import { useProjectStore } from '@renderer/store/projectStore'
import { coversFace, telopRect, type FaceBox } from '@shared/telop/avoidFaces'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { scaleToFrameFilter, stackTopHeight } from '@shared/videoFrame'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project, TextOverlay } from '@shared/types'
import type { TranscriptUtterance } from '@shared/transcript'

/**
 * 試し編集 第3回の N1: 車座の対話(マイク1本・2〜5人)のショートを人物に寄せて切り出すと、範囲の間ずっと
 * よく映る1人だけを映し、右の人が質問している所でも聞いている左の人しか映らなかった。
 * 縦のショートの定番に合わせ、(a) 2人が縦の枠に収まらなければ上下に積む(マイク1本の既定)、
 * (b) 話者が分かれている回は、話している人の顔へ発話ごとに切り替える
 */
const face = (x: number, w = 0.08, y = 0.3, score = 0.9): FaceBox => ({
  x,
  y,
  w,
  h: w * 1.6,
  score
})
const SRC = { width: 640, height: 360 }
const ASPECT = 9 / 16
const CANVAS = { w: 1080, h: 1920 }

describe('2人が離れて映るときの切り出し方', () => {
  const two = [
    [face(0.15), face(0.75)],
    [face(0.16), face(0.74)],
    [face(0.15), face(0.75)]
  ]

  it('2人が縦の枠に収まらなければ、上下に積む(上に左の人・下に右の人。それぞれ顔に寄せる)', () => {
    expect(windowFraction(SRC, ASPECT)).toBeLessThan(0.75 + 0.08 - 0.15)
    const f = decideFraming(two, SRC, ASPECT)!
    expect(f.kind).toBe('stack')
    if (f.kind !== 'stack') return
    const { top, bottom } = f.split
    // それぞれの窓に、その人の顔がまるごと入る
    const inside = (win: typeof top, b: FaceBox): boolean =>
      b.x >= win.x && b.x + b.w <= win.x + win.w && b.y >= win.y && b.y + b.h <= win.y + win.h
    expect(inside(top, face(0.15))).toBe(true)
    expect(inside(bottom, face(0.75))).toBe(true)
    expect(inside(top, face(0.75))).toBe(false)
    // 窓の縦横比は出力の半分(1080x960 = 9:8)
    for (const win of [top, bottom])
      expect((win.w * SRC.width) / (win.h * SRC.height)).toBeCloseTo(1080 / 960, 6)
    // 顔に寄せる: 窓の幅は顔の数倍(素材の 2 割〜)で、2人の両方が入るほど広くない
    expect(top.w).toBeLessThan(0.6)
  })

  it('1人だけ・2人が収まる・「1人に寄せる」設定は、今までどおりの1枚', () => {
    expect(decideFraming([[face(0.6)]], SRC, ASPECT)?.kind).toBe('single')
    expect(decideFraming([[face(0.4), face(0.56)]], SRC, ASPECT)?.kind).toBe('single')
    const one = decideFraming(two, SRC, ASPECT, false)
    expect(one?.kind).toBe('single')
    // 背景の小さな顔(2人目にならない)は数えない
    expect(decideFraming([[face(0.15, 0.1), face(0.8, 0.02)]], SRC, ASPECT)?.kind).toBe('single')
  })
})

const asset = {
  id: 'A',
  filePath: '/r/A001.mp4',
  fileName: 'A001.mp4',
  duration: 660,
  width: 640,
  height: 360,
  fps: 30,
  hasAudio: true,
  hasVideo: true
}
const telop = (id: string, startTime: number, endTime: number): TextOverlay => ({
  id,
  text: 'お伺いしておりますけれども\nそのあたり',
  startTime,
  endTime,
  style: defaultTextStyle(),
  source: 'auto',
  utteranceId: `u-${id}`,
  utteranceChunk: 0
})
const base = (extra: Partial<Project> = {}): Project =>
  ({
    id: 'p',
    name: '車座',
    aspectRatio: '9:16',
    assets: [asset],
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 276, outPoint: 326, speed: 1 },
      // 人が切り取り位置を決めたクリップ
      {
        id: 'c2',
        assetId: 'A',
        inPoint: 400,
        outPoint: 410,
        speed: 1,
        fillCrop: true,
        cropCenter: { x: 0.2, y: 0.5 }
      }
    ],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [telop('t1', 5, 8), telop('t2', 30, 33)],
    ...extra
  }) as unknown as Project
const samplesFor = (faces: FaceBox[]): FaceSample[] =>
  [280, 300, 320].map((time) => ({ time, faces }))

describe('(a) 上下に積む: 書き出し用の写し', () => {
  it('2人が収まらないクリップを上下に積む(企画と人が決めたクリップはそのまま)', () => {
    const p = base()
    const before = JSON.stringify(p)
    const r = applyVerticalFill(p, new Map([['c1', samplesFor([face(0.15), face(0.75)])]]))
    expect(JSON.stringify(p)).toBe(before)
    const [c1, c2] = r.project.clips
    expect(c1.splitStack).toBeDefined()
    expect(c1.fillCrop).toBe(true)
    expect(r.stacked).toBe(1)
    expect(c2).toEqual({ ...p.clips[1] })
    // 書き出しの形(区間ごとの書き出し)にも上下の積み方が渡る
    const seq = projectV1ToV2(r.project)
    const item = seq.sequence.videoTracks[0].items.find((i) => i.id === 'c1')!
    expect(
      item.kind === 'media' && item.placement.kind === 'frame' && item.placement.splitStack
    ).toEqual(c1.splitStack)
  })

  it('発言テロップは、上下の継ぎ目に置き、どちらの人の顔にも掛けない(第4回 N2 で継ぎ目に置く形に変えた)', () => {
    // ふだんは下の人の顔の下(胸の高さ)に入る
    const normal = applyVerticalFill(
      base(),
      new Map([['c1', samplesFor([face(0.15), face(0.75)])]])
    )
    expect(normal.movedTelops).toBe(0)
    // 2人が絵の下の方に映る(窓が素材の下端に寄り、上げた高さのテロップが下の人の顔に掛かる)
    const low: FaceBox[] = [face(0.12, 0.12, 0.62), face(0.72, 0.12, 0.62)]
    for (const faces of [[face(0.15), face(0.75)], low]) {
      const r = applyVerticalFill(base(), new Map([['c1', samplesFor(faces)]]))
      const onCanvas = stackFacesOnCanvas(faces, r.project.clips[0].splitStack!, CANVAS.h)
      const seam = stackTopHeight(CANVAS.h) / CANVAS.h
      for (const o of r.project.textOverlays) {
        const pos = o.style.customPosition
        const b = telopRect(o, CANVAS, 'bottom')
        const rect = pos
          ? { ...b, y: pos.y - b.h / 2 }
          : telopRect(o, CANVAS, o.style.position === 'top' ? 'top' : 'bottom')
        // 継ぎ目の帯の中(上の段・下の段へ離れない)
        expect(rect.y).toBeLessThan(seam + 0.2)
        expect(rect.y + rect.h).toBeGreaterThan(seam - 0.12)
        // 顔に掛からない
        expect(coversFace(rect, onCanvas)).toBe(false)
        // Shorts の下の帯に隠れない
        expect(rect.y + rect.h).toBeLessThanOrEqual(0.84)
      }
    }
  })
})

describe('人の修正を上書きしない', () => {
  it('上下に積んだクリップ(自動のショートの企画)でも、人が切り抜きを決めたら書き出しも人の決めた形', () => {
    const r = applyVerticalFill(base(), new Map([['c1', samplesFor([face(0.15), face(0.75)])]]))
    useProjectStore.setState({ project: r.project })
    expect(useProjectStore.getState().project.clips[0].splitStack).toBeDefined()
    useProjectStore.getState().updateClipCrop('c1', true, { x: 0.8, y: 0.5 })
    const c1 = useProjectStore.getState().project.clips[0]
    expect(c1.splitStack).toBeUndefined()
    expect(c1.cropCenter).toEqual({ x: 0.8, y: 0.5 })
    // 人が決めたクリップは、次の縦の書き出しでも触らない
    const again = applyVerticalFill(
      useProjectStore.getState().project,
      new Map([['c1', samplesFor([face(0.15), face(0.75)])]])
    )
    expect(again.project.clips[0]).toEqual(c1)
  })
})

describe('(b) 話している人へ切り替える', () => {
  const lines = [
    // 右の人(質問者)→ 左の人(答える人)。左の人の 0.6 秒の相づちでは切り替えない
    { speaker: '佐藤', start: 0, end: 6 },
    { speaker: '山田', start: 3.0, end: 3.6 },
    { speaker: '佐藤', start: 3.7, end: 9.5 },
    { speaker: '山田', start: 10, end: 30 },
    { speaker: '佐藤', start: 30.5, end: 31.2 },
    { speaker: '山田', start: 31.4, end: 50 }
  ]
  const keyOf = (s: string): number | null => (s === '山田' ? 0 : s === '佐藤' ? 1 : null)

  it('切り替えは発話の頭だけ・短すぎる切り替えはしない', () => {
    const shots = speakerShots(lines, 0, 50, keyOf)
    expect(shots.map((s) => [s.start, s.key])).toEqual([
      [0, 1],
      [10, 0]
    ])
    expect(shots[shots.length - 1].end).toBe(50)
    // 顔の分からない話者では切り替えない
    expect(speakerShots([{ speaker: '?', start: 0, end: 5 }], 0, 50, keyOf)).toEqual([])
  })

  it('話者と顔の対応があれば、クリップを発話の境で分けて、話している人の顔に寄せる', () => {
    const r = applyVerticalFill(base(), new Map([['c1', samplesFor([face(0.15), face(0.75)])]]), {
      speakers: {
        faces: new Map([
          [
            'A',
            new Map([
              ['山田', 0.19],
              ['佐藤', 0.79]
            ])
          ]
        ]),
        lines
      }
    })
    const pieces = r.project.clips.filter((c) => c.id.startsWith('c1'))
    expect(pieces).toHaveLength(2)
    expect(r.switched).toBe(1)
    expect(r.stacked).toBe(0)
    // 最初は質問している右の人、10 秒から答える左の人
    expect(pieces[0].cropCenter!.x).toBeGreaterThan(0.7)
    expect(pieces[1].cropCenter!.x).toBeLessThan(0.3)
    expect(pieces[0].outPoint).toBeCloseTo(286, 6)
    expect(pieces[1].inPoint).toBeCloseTo(286, 6)
    expect(pieces[1].outPoint).toBe(326)
    expect(pieces.every((c) => !c.splitStack)).toBe(true)
  })
})

describe('話者と顔の対応(口の動き)', () => {
  const people = [
    { cx: 0.19, cy: 0.364, w: 0.08, h: 0.128 },
    { cx: 0.79, cy: 0.364, w: 0.08, h: 0.128 }
  ]
  const size = { w: 320, h: 180 }
  /** 話している人の口のあたりだけ、画ごとに明るさが変わる絵 */
  const frame = (talking: number | null, t: number): Uint8Array => {
    const f = new Uint8Array(size.w * size.h * 3).fill(100)
    if (talking === null) return f
    const p = people[talking]
    const v = 100 + Math.round(60 * Math.sin(t * 37))
    for (let y = Math.floor((p.cy + p.h * 0.1) * size.h); y < (p.cy + p.h * 0.6) * size.h; y++)
      for (let x = Math.floor((p.cx - p.w * 0.35) * size.w); x < (p.cx + p.w * 0.35) * size.w; x++)
        f.fill(v, (y * size.w + x) * 3, (y * size.w + x) * 3 + 3)
    return f
  }

  it('話している人の口のあたりが動く', () => {
    const act = mouthActivity(
      [0, 0.13, 0.27].map((t) => frame(1, t)),
      size,
      people
    )!
    expect(act[1]).toBeGreaterThan(10)
    expect(act[0]).toBe(0)
    expect(mouthActivity([frame(1, 0), null], size, people)).toBeNull()
  })

  it('一番動く顔がはっきりしているときだけ対応づける(2人に分かれなければ切り替えない)', () => {
    expect(
      assignSpeakers(
        new Map([
          ['山田', [0.8, 0.2]],
          ['佐藤', [0.3, 0.7]]
        ])
      )
    ).toEqual(
      new Map([
        ['山田', 0],
        ['佐藤', 1]
      ])
    )
    // はっきりしない
    expect(
      assignSpeakers(
        new Map([
          ['山田', [0.52, 0.48]],
          ['佐藤', [0.3, 0.7]]
        ])
      )
    ).toBeNull()
    // 2人とも同じ顔
    expect(
      assignSpeakers(
        new Map([
          ['山田', [0.8, 0.2]],
          ['佐藤', [0.7, 0.3]]
        ])
      )
    ).toBeNull()
  })

  /** 素材の時刻 → 話している人(山田 = 左 0、佐藤 = 右 1) */
  const utterances = (speakers: [string, string]): TranscriptUtterance[] => [
    {
      id: 'u1',
      assetId: 'A',
      speaker: speakers[1],
      sourceStart: 276,
      sourceEnd: 286,
      text: 'お伺いしておりますけれどもそのあたり',
      words: [],
      overlap: false
    },
    {
      id: 'u2',
      assetId: 'A',
      speaker: speakers[0],
      sourceStart: 286.5,
      sourceEnd: 305,
      text: '直営の店の方では',
      words: [],
      overlap: false
    },
    {
      id: 'u3',
      assetId: 'A',
      speaker: speakers[1],
      sourceStart: 305.5,
      sourceEnd: 312,
      text: 'ありがとうございます',
      words: [],
      overlap: false
    },
    {
      id: 'u4',
      assetId: 'A',
      speaker: speakers[0],
      sourceStart: 312.5,
      sourceEnd: 326,
      text: 'これをぜひ継続を',
      words: [],
      overlap: false
    }
  ]
  const stubApi = (speakers: [string, string]): void => {
    const us = utterances(speakers)
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        faceDetect: async (req: unknown[]) => req.map(() => [face(0.15), face(0.75)]),
        framesRgb: async (req: { time: number }[]) =>
          req.map((q) => {
            const u = us.find((x) => q.time >= x.sourceStart && q.time < x.sourceEnd)
            const talking = !u ? null : u.speaker === speakers[0] ? 0 : 1
            return frame(speakers[0] === speakers[1] ? null : talking, q.time)
          })
      }
    }
  }

  it('話者が分かれている回(ピンマイク2本)は、話している人へ切り替える', async () => {
    stubApi(['山田', '佐藤'])
    const r = await prepareVerticalFill(base({ transcript: utterances(['山田', '佐藤']) }))
    expect(r.switched).toBe(1)
    const pieces = r.project.clips.filter((c) => c.id.startsWith('c1'))
    expect(pieces.length).toBeGreaterThanOrEqual(3)
    // 質問している右の人 → 答える左の人 → …
    expect(pieces[0].cropCenter!.x).toBeGreaterThan(0.7)
    expect(pieces[1].cropCenter!.x).toBeLessThan(0.3)
    // 切り替えは発話の頭(コマにそろえる)
    expect(pieces[1].inPoint).toBeCloseTo(286.5, 1)
  })

  it('マイク1本(話者が1人)の回は、上下に積む(第3回の既定)', async () => {
    stubApi(['マイク1', 'マイク1'])
    const r = await prepareVerticalFill(base({ transcript: utterances(['マイク1', 'マイク1']) }))
    expect(r.switched).toBe(0)
    expect(r.stacked).toBe(1)
    expect(r.project.clips[0].splitStack).toBeDefined()
  })

  it('書き出し画面の見本も、書き出しと同じ上下に積んだ形', async () => {
    stubApi(['マイク1', 'マイク1'])
    const list = await verticalSamples(base(), [1, 25, 45], true)
    expect(list).toHaveLength(3)
    for (const x of list) expect(x.stack).toBeDefined()
    // 「1人に寄せる」設定なら1枚
    const one = await verticalSamples(base(), [1], true, true, undefined, false)
    expect(one[0].stack).toBeUndefined()
    expect(one[0].fill).toBe(true)
  })
})

describe('書き出しの選択肢と ffmpeg の filter', () => {
  it('縦の画は「人物に寄せる(2人は上下・話す人)」「1人に寄せる」「黒帯」から選べる', () => {
    useSettingsStore.getState().setVerticalFraming('single')
    expect(useSettingsStore.getState().verticalFraming).toBe('single')
    useSettingsStore.getState().setVerticalFraming('fill')
  })

  it('上下に積む filter: 2つの窓を切り出して、上下の段の大きさにして積む(fps は積む前に)', () => {
    const f = scaleToFrameFilter(1080, 1920, true, { x: 0.2, y: 0.5 }, false, {
      labelSuffix: '_m1',
      fps: 30,
      stack: {
        top: { x: 0.05, y: 0.1, w: 0.3, h: 0.47 },
        bottom: { x: 0.6, y: 0.1, w: 0.3, h: 0.47 }
      }
    })
    expect(f).toContain('split=2')
    expect(f).toContain('crop=w=iw*0.3:h=ih*0.47:x=iw*0.05:y=ih*0.1,scale=1080:960')
    expect(f).toContain('crop=w=iw*0.3:h=ih*0.47:x=iw*0.6:y=ih*0.1,scale=1080:960')
    expect(f.endsWith('vstack=inputs=2')).toBe(true)
    expect(f.split('fps=30').length - 1).toBe(2)
  })
})

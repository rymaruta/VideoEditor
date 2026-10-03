import { describe, expect, it } from 'vitest'
import type { MediaAsset } from '@shared/types'
import type { AudioItem, MediaItem, Sequence, TelopItem } from '@shared/sequence/types'
import { planSegments, type Segment } from '@shared/sequence/segmentPlan'
import { defaultTextStyle } from '@shared/textStyle'
import {
  buildSegmentAudioGraph,
  buildSegmentVideoGraph,
  fpsExpr,
  frameToSample,
  type GraphContext
} from '@main/segmentGraph'
import {
  defaultParallelism,
  encoderLabel,
  telopsAsOverlays,
  videoEncodeArgs
} from '@main/segmentRenderer'
import { seeded } from '../helpers/boundary'

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  filePath: `/m/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 3600,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  hasVideo: true,
  ...extra
})

const media = (
  id: string,
  startFrame: number,
  durationFrames: number,
  extra: Partial<MediaItem> = {}
): MediaItem => ({
  kind: 'media',
  id,
  assetId: 'a',
  startFrame,
  durationFrames,
  sourceIn: 0,
  speed: 1,
  origin: 'manual',
  placement: { kind: 'frame', fit: 'contain' },
  ...extra
})

const audio = (
  id: string,
  startFrame: number,
  durationFrames: number,
  extra: Partial<AudioItem> = {}
): AudioItem => ({
  kind: 'audio',
  id,
  assetId: 'a',
  startFrame,
  durationFrames,
  sourceIn: 0,
  speed: 1,
  origin: 'manual',
  ...extra
})

const sequence = (partial: Partial<Sequence> = {}): Sequence => ({
  width: 1920,
  height: 1080,
  fps: { num: 30, den: 1 },
  videoTracks: [],
  audioTracks: [],
  ...partial
})

const ctxOf = (seq: Sequence, extra: Partial<GraphContext> = {}): GraphContext => ({
  sequence: seq,
  assetsById: new Map([
    ['a', asset('a')],
    ['b', asset('b')],
    ['silent', asset('silent', { hasAudio: false })]
  ]),
  ...extra
})

const seg = (startFrame: number, endFrame: number, index = 0): Segment => ({
  index,
  startFrame,
  endFrame,
  itemIds: []
})

/** 出力ラベル(`[x]` で終わるもの)が二重定義されていないこと・使われるラベルが定義済みであること */
function expectWellFormed(filter: string): void {
  expect(filter).not.toMatch(/NaN|undefined|Infinity/)
  const defined = new Map<string, number>()
  const used: string[] = []
  for (const part of filter.split(';')) {
    // 出力は末尾に並ぶラベル(asplit のように複数のこともある)
    const outs = part.match(/(\[[A-Za-z0-9_]+\])+$/)
    for (const label of outs?.[0].match(/\[[^\]]+\]/g) ?? []) {
      defined.set(label, (defined.get(label) ?? 0) + 1)
    }
    const ins = part.match(/^(\[[A-Za-z0-9_:]+\])+/)
    if (ins) used.push(...(ins[0].match(/\[[^\]]+\]/g) ?? []))
  }
  for (const [label, n] of defined) expect(n, label).toBe(1)
  for (const label of used) {
    if (/^\[\d+:[av]\]$/.test(label)) continue
    expect(defined.has(label), label).toBe(true)
  }
}

describe('frameToSample — 区間の音の長さ', () => {
  it('29.97fps でも、どう区切っても合計は全体のサンプル数と一致する', () => {
    const s = sequence({ fps: { num: 30000, den: 1001 } })
    expect(fpsExpr(s)).toBe('30000/1001')
    const rnd = seeded(77)
    for (let n = 0; n < 200; n++) {
      const total = 1 + Math.floor(rnd() * 200000)
      const cuts = [0]
      while (cuts[cuts.length - 1] < total) {
        cuts.push(Math.min(total, cuts[cuts.length - 1] + 1 + Math.floor(rnd() * 3000)))
      }
      let sum = 0
      for (let i = 1; i < cuts.length; i++)
        sum += frameToSample(s, cuts[i]) - frameToSample(s, cuts[i - 1])
      expect(sum).toBe(frameToSample(s, total))
    }
    // 1時間ちょうど(107,892フレーム)= 3600.0 - 0.0 秒のずれ無しで 172,800,000 サンプルに近い
    expect(frameToSample(s, 107892)).toBe(Math.round((107892 * 1001 * 48000) / 30000))
  })
})

describe('buildSegmentVideoGraph — 区間の映像', () => {
  it('区間に掛かるアイテムだけを入力にし、途中から始まるものは素材の途中から読む', () => {
    const s = sequence({
      videoTracks: [
        {
          id: 'v1',
          name: 'V1',
          hidden: false,
          items: [
            media('before', 0, 100),
            media('cross', 100, 300, { sourceIn: 10, speed: 2 }),
            media('after', 400, 100)
          ]
        }
      ]
    })
    const g = buildSegmentVideoGraph(ctxOf(s), seg(250, 400))
    expect(g.inputs).toHaveLength(1)
    // 区間の頭は アイテムの頭から 150フレーム = 5秒。2倍速なので素材は 10 + 10 = 20秒から、150フレーム×2 = 10秒ぶん
    expect(g.inputs[0]).toEqual({ path: '/m/a.mp4', seek: 20, duration: 10 })
    expect(g.filter).toContain('trim=end_frame=150')
    expect(g.filter).toContain('setpts=PTS/2')
    expectWellFormed(g.filter)
  })

  it('隙間は黒で埋め、区間の長さちょうどにする', () => {
    const s = sequence({
      videoTracks: [{ id: 'v1', name: 'V1', hidden: false, items: [media('m', 30, 30)] }]
    })
    const g = buildSegmentVideoGraph(ctxOf(s), seg(0, 90))
    expect(g.filter.match(/color=c=black/g)).toHaveLength(2)
    expect(g.filter).toMatch(
      /trim=end_frame=90,settb=1\/30,setpts=N,fps=30,format=yuv420p\[vout\]$/
    )
    expectWellFormed(g.filter)
  })

  it('区間の中の繋ぎは xfade(位置と長さはフレームから)', () => {
    const s = sequence({
      videoTracks: [
        {
          id: 'v1',
          name: 'V1',
          hidden: false,
          items: [
            media('c1', 0, 70),
            media('c2', 49, 93, { transitionIn: { type: 'crossfade', durationFrames: 21 } })
          ]
        }
      ]
    })
    const g = buildSegmentVideoGraph(ctxOf(s), seg(0, 142))
    expect(g.filter).toContain('xfade=transition=fade:duration=0.7:offset=1.633333333')
    expectWellFormed(g.filter)
  })

  it('ワイプは隅からの距離と幅で重ね、出ている間だけ有効にする(境目は半フレームずらす)', () => {
    const s = sequence({
      videoTracks: [
        { id: 'v1', name: 'V1', hidden: false, items: [media('m', 0, 300)] },
        {
          id: 'pip',
          name: 'PiP',
          hidden: false,
          items: [
            media('p', 60, 90, {
              assetId: 'b',
              placement: { kind: 'box', anchor: 'bottom-right', margin: 0.04, width: 0.3 }
            })
          ]
        },
        {
          id: 'gone',
          name: '非表示',
          hidden: true,
          items: [media('h', 0, 300)]
        }
      ]
    })
    const g = buildSegmentVideoGraph(ctxOf(s), seg(0, 300))
    expect(g.inputs.map((i) => i.path)).toEqual(['/m/a.mp4', '/m/b.mp4'])
    expect(g.filter).toContain('scale=576:-2')
    expect(g.filter).toContain('setpts=N+60')
    expect(g.filter).toContain(
      "overlay=x=W-w-77:y=H-h-77:enable='between(t\\,1.983333333\\,4.983333333)'"
    )
    expectWellFormed(g.filter)
  })

  it('テロップは区間に掛かるときだけ、時刻を区間の頭へずらして焼く', () => {
    const telop: TelopItem = {
      kind: 'telop',
      id: 't',
      startFrame: 100,
      durationFrames: 30,
      origin: 'auto',
      text: 'あ',
      style: defaultTextStyle()
    }
    const s = sequence({
      videoTracks: [
        { id: 'v1', name: 'V1', hidden: false, items: [media('m', 0, 300)] },
        { id: 'tl', name: 'T', hidden: false, items: [telop] }
      ]
    })
    const ctx = ctxOf(s, { assPath: '/tmp/x.ass' })
    expect(buildSegmentVideoGraph(ctx, seg(90, 200)).filter).toContain(
      "setpts=PTS+3/TB,subtitles=filename='/tmp/x.ass',setpts=PTS-STARTPTS"
    )
    expect(buildSegmentVideoGraph(ctx, seg(0, 90)).filter).not.toContain('subtitles')
    expect(buildSegmentVideoGraph(ctx, seg(130, 200)).filter).not.toContain('subtitles')
  })

  it('共通レンダラのテロップの層があるときは、ASS ではなく画像の一覧を1本の入力として重ねる', () => {
    const telop: TelopItem = {
      kind: 'telop',
      id: 't',
      startFrame: 100,
      durationFrames: 30,
      origin: 'auto',
      text: 'あ',
      style: defaultTextStyle()
    }
    const s = sequence({
      videoTracks: [
        { id: 'v1', name: 'V1', hidden: false, items: [media('m', 0, 300)] },
        { id: 'tl', name: 'T', hidden: false, items: [telop] }
      ]
    })
    const ctx = ctxOf(s, {
      assPath: '/tmp/x.ass',
      telopLayer: {
        runs: [{ startFrame: 100, endFrame: 130, image: 1 }],
        imagePaths: ['/w/0.png', '/w/1.png']
      }
    })
    const g = buildSegmentVideoGraph(ctx, seg(90, 200))
    expect(g.filter).not.toContain('subtitles')
    const layerInput = g.inputs.find((i) => i.concatList !== undefined)!
    expect(layerInput.concatList).toContain("file '/w/1.png'")
    // 毎フレームへ複製しない(複製すると全フレームの RGBA が待ち行列に溜まってメモリを使い切る)
    expect(g.filter).toContain('format=rgba,settb=1/30[l')
    expect(g.filter).not.toMatch(/fps=30,format=rgba/)
    expect(g.filter).toMatch(/overlay=0:0:eof_action=repeat\[t\d+\]/)
    expectWellFormed(g.filter)
    // 層に区間が掛からなければ入力も足さない
    expect(
      buildSegmentVideoGraph(ctx, seg(0, 90)).inputs.some((i) => i.concatList !== undefined)
    ).toBe(false)
  })

  it('【不変条件】ランダムな企画をどう区切っても、グラフの形が壊れず、入力は区間に掛かる分だけ', () => {
    const rnd = seeded(5150)
    for (let n = 0; n < 150; n++) {
      const items: MediaItem[] = []
      let at = 0
      for (let i = 0; i < 1 + Math.floor(rnd() * 25); i++) {
        const len = 2 + Math.floor(rnd() * 300)
        const prev = items[i - 1]
        const tr =
          prev && rnd() < 0.3 ? Math.floor(rnd() * Math.min(len - 1, prev.durationFrames - 1)) : 0
        const start = at - tr + (tr === 0 && rnd() < 0.1 ? Math.floor(rnd() * 50) : 0)
        items.push(
          media(`c${i}`, start, len, {
            speed: rnd() < 0.2 ? 1.5 : 1,
            ...(tr > 0 ? { transitionIn: { type: 'crossfade', durationFrames: tr } } : {})
          })
        )
        at = start + len
      }
      const pips = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) =>
        media(`p${i}`, Math.floor(rnd() * at), 1 + Math.floor(rnd() * 200), {
          placement: { kind: 'box', anchor: 'top-left', margin: 0.04, width: 0.25 }
        })
      )
      const s = sequence({
        videoTracks: [
          { id: 'v1', name: 'V1', hidden: false, items },
          ...pips.map((p, i) => ({ id: `pip${i}`, name: 'P', hidden: false, items: [p] }))
        ]
      })
      const plan = planSegments(s, { targetFrames: 120, minFrames: 40, maxFrames: 240 })
      for (const sg of plan) {
        const g = buildSegmentVideoGraph(ctxOf(s), sg)
        expectWellFormed(g.filter)
        const touching = [...items, ...pips].filter(
          (i) => i.startFrame < sg.endFrame && i.startFrame + i.durationFrames > sg.startFrame
        ).length
        expect(g.inputs.length).toBeLessThanOrEqual(touching)
        for (const input of g.inputs) {
          expect(input.seek).toBeGreaterThanOrEqual(0)
          expect(input.duration).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('buildSegmentAudioGraph — 区間の音', () => {
  it('前置きぶん手前から鳴らして、区間の頭で切り落とす。長さは区間ちょうど', () => {
    const s = sequence({
      audioTracks: [
        {
          id: 'a1',
          name: 'A1',
          muted: false,
          volume: 1,
          duckingEnabled: false,
          items: [audio('x', 0, 600)]
        }
      ]
    })
    const g = buildSegmentAudioGraph(ctxOf(s), seg(300, 450))
    // 前置き2秒 = 60フレーム → 240フレームから鳴らし、60フレーム(96000サンプル)を捨てる
    expect(g.inputs).toEqual([{ path: '/m/a.mp4', seek: 8, duration: 7 }])
    expect(g.samples).toBe(240000)
    expect(g.filter).toMatch(/atrim=start_sample=96000:end_sample=336000,/)
    expectWellFormed(g.filter)
  })

  it('ミュートしたトラック・音の無い素材は入れない', () => {
    const s = sequence({
      audioTracks: [
        {
          id: 'm',
          name: 'M',
          muted: true,
          volume: 1,
          duckingEnabled: false,
          items: [audio('x', 0, 60)]
        },
        {
          id: 'n',
          name: 'N',
          muted: false,
          volume: 1,
          duckingEnabled: false,
          items: [audio('y', 0, 60, { assetId: 'silent' })]
        }
      ]
    })
    const g = buildSegmentAudioGraph(ctxOf(s), seg(0, 60))
    expect(g.inputs).toEqual([])
    expectWellFormed(g.filter)
  })

  it('同じトラックで重なる音(本編の繋ぎ)は、重なりの区間で直線のクロスフェードにする', () => {
    const s = sequence({
      audioTracks: [
        {
          id: 'a1',
          name: 'A1',
          muted: false,
          volume: 1,
          duckingEnabled: false,
          items: [audio('o', 0, 70), audio('i', 49, 93)]
        }
      ]
    })
    const g = buildSegmentAudioGraph(ctxOf(s), seg(0, 142))
    // 出ていく側: 尺 70/30 秒の最後の 0.7秒で下がる。入ってくる側: 頭の 0.7秒で上がる
    expect(g.filter).toContain('min(1\\,max(0\\,2.333333333-(t+0))/0.7)')
    expect(g.filter).toContain('min(1\\,(t+0)/0.7)')
    // 入ってくる側は 49フレーム = 78400 サンプル遅らせる
    expect(g.filter).toContain('adelay=78400S:all=1')
    expectWellFormed(g.filter)
  })

  it('ダッキング: 本編(一番下の映像)に紐づく音があるときだけ圧縮を掛ける', () => {
    const tracks = (linked: boolean): Sequence =>
      sequence({
        videoTracks: [{ id: 'v1', name: 'V1', hidden: false, items: [media('m', 0, 300)] }],
        audioTracks: [
          {
            id: 'voice',
            name: '本編の音',
            muted: false,
            volume: 1,
            duckingEnabled: false,
            items: [audio('m:audio', 0, 300, linked ? { linkedItemId: 'm' } : {})]
          },
          {
            id: 'bgm',
            name: 'BGM',
            muted: false,
            volume: 0.5,
            duckingEnabled: true,
            items: [audio('bgm', 0, 300, { assetId: 'b', fadeInFrames: 30 })]
          }
        ]
      })
    const on = buildSegmentAudioGraph(ctxOf(tracks(true)), seg(0, 300))
    expect(on.filter).toContain('sidechaincompress')
    expectWellFormed(on.filter)
    const off = buildSegmentAudioGraph(ctxOf(tracks(false)), seg(0, 300))
    expect(off.filter).not.toContain('sidechaincompress')
    expectWellFormed(off.filter)
  })
})

describe('segmentRenderer の小物', () => {
  it('テロップは絶対秒の v1 形式へ戻す(単語もアイテムの頭からの秒を足す)。非表示のトラックは除く', () => {
    const t: TelopItem = {
      kind: 'telop',
      id: 't',
      startFrame: 90,
      durationFrames: 60,
      origin: 'auto',
      text: 'こんにちは',
      style: defaultTextStyle(),
      words: [{ text: 'こん', start: 0.5, end: 1 }]
    }
    const s = sequence({
      videoTracks: [
        { id: 'a', name: 'A', hidden: false, items: [t] },
        { id: 'b', name: 'B', hidden: true, items: [{ ...t, id: 'hidden' }] }
      ]
    })
    const out = telopsAsOverlays(s)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 't',
      startTime: 3,
      endTime: 5,
      words: [{ text: 'こん', start: 3.5, end: 4 }]
    })
  })

  it('エンコードの引数は全区間で同じ(連結の前提)・並列数はエンコーダと CPU 数から', () => {
    expect(videoEncodeArgs('libx264', 'standard', '30')).toEqual(
      videoEncodeArgs('libx264', 'standard', '30')
    )
    expect(videoEncodeArgs('h264_nvenc', 'high', '30000/1001')).toContain('h264_nvenc')
    expect(videoEncodeArgs('h264_nvenc', 'high', '30000/1001')).toContain('30000/1001')
    expect(defaultParallelism('h264_nvenc', 32)).toBe(4)
    expect(defaultParallelism('libx264', 4)).toBe(1)
    expect(defaultParallelism('libx264', 16)).toBe(4)
    expect(defaultParallelism('libx264', 64)).toBe(6)
    expect(defaultParallelism('libx264', 1)).toBe(1)
    expect(encoderLabel('h264_nvenc')).toBe('GPU: NVENC')
    expect(encoderLabel('libx264')).toBe('CPU: x264')
  })
})

import { describe, expect, it } from 'vitest'
import {
  NO_SOURCE_METADATA_ARGS,
  hdrToSdrLutFilter,
  isHdrTransfer,
  isInterlacedFieldOrder,
  sourceVideoFilter
} from '../../src/shared/sourceVideo'
import {
  ENCODED_TRUE_PEAK_MARGIN_DB,
  LOUDNESS_TARGETS,
  MAX_LOUDNESS_PASSES,
  fitEncodedLoudness,
  fitEncodedTruePeak,
  limitedGainFilter,
  planLimitedGainValues,
  loudnormAccepts,
  loudnormApplyFilter,
  parseEbur128Summary,
  type EncodedLoudness
} from '../../src/shared/loudness'
import {
  clipsBeyondSource,
  clipsBeyondSourceMessage,
  sequenceItemsBeyondSource
} from '../../src/shared/clipSourceRange'
import type { Project } from '../../src/shared/types'
import type { ProjectV2 } from '../../src/shared/sequence/types'
import { NASTY_VALUES } from '../helpers/boundary'

describe('sourceVideoFilter(素材の頭に掛けるフィルタ)', () => {
  it('SDR・プログレッシブ・分からない素材は空(今までの書き出しを変えない)', () => {
    for (const info of [
      undefined,
      {},
      { colorTransfer: 'bt709', fieldOrder: 'progressive' },
      { colorTransfer: 'bt2020-10', colorPrimaries: 'bt2020', fieldOrder: 'unknown' },
      { colorTransfer: 'smpte170m' }
    ])
      for (const zscale of [true, false]) expect(sourceVideoFilter(info, { zscale })).toBe('')
  })

  it('インターレース(tt/bb/tb/bt)だけ bwdif で解除する', () => {
    for (const fieldOrder of ['tt', 'bb', 'tb', 'bt']) {
      expect(isInterlacedFieldOrder(fieldOrder)).toBe(true)
      expect(sourceVideoFilter({ fieldOrder }, { zscale: true })).toBe(
        'bwdif=mode=send_frame:parity=auto:deint=all,'
      )
    }
    for (const v of ['progressive', 'unknown', '', undefined])
      expect(isInterlacedFieldOrder(v)).toBe(false)
  })

  it('PQ・HLG は zscale + mobius(基準の白 203)で BT.709 へ寄せる。zscale が無ければ表引き', () => {
    expect(isHdrTransfer('smpte2084')).toBe(true)
    expect(isHdrTransfer('arib-std-b67')).toBe(true)
    expect(isHdrTransfer('bt709')).toBe(false)
    const pq = sourceVideoFilter(
      { colorTransfer: 'smpte2084', colorSpace: 'bt2020nc' },
      { zscale: true }
    )
    expect(pq).toContain(
      'zscale=tin=smpte2084:min=2020_ncl:pin=bt2020:rin=limited:t=linear:npl=203'
    )
    expect(pq).toContain('tonemap=tonemap=mobius')
    expect(pq.endsWith('format=yuv420p,')).toBe(true)
    const hlgFull = sourceVideoFilter(
      { colorTransfer: 'arib-std-b67', colorRange: 'pc', fieldOrder: 'tt' },
      { zscale: true }
    )
    // インターレースの解除が先(フィールドの並びを見るのは、色を変える前の絵)
    expect(hlgFull.indexOf('bwdif')).toBe(0)
    expect(hlgFull).toContain('tin=arib-std-b67')
    expect(hlgFull).toContain('rin=full')
    const lut = sourceVideoFilter({ colorTransfer: 'smpte2084' }, { zscale: false })
    expect(lut).toBe(`${hdrToSdrLutFilter('pq')},`)
    expect(lut).not.toContain('zscale')
    // 式は引用符で括る(フィルタの区切りの `,` を式の中に置くため)。指数表記を出さない
    for (const kind of ['pq', 'hlg'] as const) {
      const f = hdrToSdrLutFilter(kind)
      expect(f).toMatch(/lutrgb=r='[^']+':g='[^']+':b='[^']+'/)
      expect(f).not.toMatch(/\de[-+]\d/)
    }
  })

  it('出力に素材のメタデータ・チャプター・データ・字幕を持ち込まない引数', () => {
    expect(NO_SOURCE_METADATA_ARGS).toEqual([
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-dn',
      '-sn'
    ])
  })
})

describe('parseEbur128Summary', () => {
  it('締めの集計の積分とトゥルーピークを読む(途中の行は見ない)', () => {
    const log = [
      '[Parsed_ebur128_0 @ 0x1] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -14.6 LUFS',
      '    Threshold: -24.8 LUFS',
      '',
      '  True peak:',
      '    Peak:       -3.5 dBFS'
    ].join('\n')
    expect(parseEbur128Summary(`I: -99 LUFS\n${log}`)).toEqual({
      integrated: -14.6,
      truePeak: -3.5
    })
    expect(parseEbur128Summary(log.replace('-14.6', '-inf'))).toEqual({
      integrated: -Infinity,
      truePeak: -3.5
    })
    for (const v of NASTY_VALUES) expect(parseEbur128Summary(String(v))).toBeNull()
  })
})

describe('fitEncodedLoudness(AAC にした後の大きさとトゥルーピーク)', () => {
  const web = LOUDNESS_TARGETS.web
  const measured = {
    inputI: -20,
    inputTP: -8,
    inputLRA: 8,
    inputThresh: -30,
    targetOffset: 0
  }
  /**
   * AAC にした後の模型。`lift`: AAC にするとリミッタの高さより山が上がる分。loudnorm(linear)は
   * 上限ちょうどから上がり、大きさは `loudnormMiss` だけ外れる
   */
  const model =
    (lift: number, calls: string[], opts: { loudnormMiss?: number } = {}) =>
    async (filter: string): Promise<EncodedLoudness> => {
      calls.push(filter)
      const m = /volume=(-?[\d.]+)dB.*alimiter=limit=([\d.]+)/.exec(filter)
      if (!m)
        return {
          integrated: web.integrated - (opts.loudnormMiss ?? 0),
          truePeak: web.truePeak + lift
        }
      const ceiling = 20 * Math.log10(Number(m[2]))
      // ゲインを上げるほど大きく、リミッタを下げるほど少し小さくなる
      return {
        integrated: measured.inputI + Number(m[1]) + Math.min(0, ceiling + 2.6) * 0.3,
        truePeak: ceiling + lift
      }
    }
  const tpLimit = web.truePeak - ENCODED_TRUE_PEAK_MARGIN_DB

  it('AAC にしても上限に収まり大きさも合えば、loudnorm をそのまま使う(1回だけ測る)', async () => {
    const calls: string[] = []
    const out = await fitEncodedLoudness('web', measured, model(-1, calls))
    expect(out).toBe(loudnormApplyFilter('web', measured))
    expect(calls).toHaveLength(1)
  })

  it('ピークが収まっていても、大きさが外れていればリミッタへ切り替えて直す(1回目をそのまま使わない)', async () => {
    // 前は AAC の確認の1回目でピークが収まっていると、大きさが 1.1 LU 外れていても使っていた
    // (実地テスト: 3時間で −15.1 LUFS・−2.8 dBTP)
    const calls: string[] = []
    const measure = model(-1, calls, { loudnormMiss: 1.1 })
    const out = await fitEncodedLoudness('web', measured, measure)
    const r = await measure(out)
    expect(Math.abs(r.integrated - web.integrated)).toBeLessThanOrEqual(0.3)
    expect(r.truePeak).toBeLessThanOrEqual(tpLimit)
  })

  it('越えていればリミッタを下げ、下がった大きさをゲインで戻す(上限以下・基準 ±0.3 LU)', async () => {
    for (const lift of [0.5, 1.5, 3.2, 5]) {
      const calls: string[] = []
      const measure = model(lift, calls)
      const out = await fitEncodedLoudness('web', { ...measured, inputTP: 0 }, measure)
      const passes = calls.length
      const r = await measure(out)
      expect(r.truePeak, `lift ${lift}`).toBeLessThanOrEqual(tpLimit)
      expect(Math.abs(r.integrated - web.integrated), `lift ${lift}`).toBeLessThanOrEqual(0.3)
      expect(passes, `lift ${lift}`).toBeLessThanOrEqual(4)
    }
  })

  /**
   * 振幅の分布で作った音の模型。リミッタは抑える高さで山を切り、
   * 大きさは二乗平均、AAC にした後のピークは残った山 + `lift`
   */
  const sampleModel = (
    spikeRate: number,
    spikeAmp: number,
    lift: number,
    calls: string[]
  ): {
    measured: typeof measured
    encode: (filter: string) => Promise<EncodedLoudness>
  } => {
    let seed = 12345
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const xs = Array.from({ length: 20000 }, () => {
      // 小さめの話し声(ラプラス分布)に、まばらな鋭い山(通信のクリック音・ビープ)
      const v = -0.05 * Math.log(1 - rnd()) * (rnd() < 0.5 ? -1 : 1)
      return rnd() < spikeRate ? spikeAmp * (0.5 + 0.5 * rnd()) : v
    })
    const level = (gainDb: number, ceilingDb: number): { i: number; peak: number } => {
      const g = Math.pow(10, gainDb / 20)
      const c = Math.pow(10, ceilingDb / 20)
      let e = 0
      let peak = 0
      for (const x of xs) {
        const a = Math.abs(x) * g
        const y = Math.min(a, c)
        e += y * y
        peak = Math.max(peak, Math.min(a, c))
      }
      return { i: 10 * Math.log10(e / xs.length), peak: 20 * Math.log10(peak) }
    }
    const raw = level(0, 100)
    const inputI = -26.2
    const offset = inputI - raw.i
    return {
      measured: { ...measured, inputI, inputTP: raw.peak },
      encode: async (filter: string): Promise<EncodedLoudness> => {
        calls.push(filter)
        const m = /volume=(-?[\d.]+)dB.*alimiter=limit=([\d.]+)/.exec(filter)
        // loudnorm(linear)は届くが、ピークは上限ちょうどから上がる
        if (!m) return { integrated: web.integrated, truePeak: web.truePeak + lift }
        const r = level(Number(m[1]), 20 * Math.log10(Number(m[2])))
        return { integrated: r.i + offset, truePeak: r.peak + lift }
      }
    }
  }

  it('深く抑える素材(上げても大きさが半分も上がらない)でも、少ない回数で基準 ±0.3 LU に入る', async () => {
    // 実測(3時間の記録映像の20分): 12.2 dB 上げて −16.0、14.2 dB で −14.9、15.1 dB で −14.5。
    // 上げるほど傾きが下がる(0.56 → 0.43)。前は「足りない分だけ足す」で回数が尽き、基準に届かなかった
    for (const [rate, amp, lift, maxPasses] of [
      [0.002, 1, 0.8, 2],
      [0.01, 1, 0.8, 4],
      // AAC で 1 dB より持ち上がる(抑える高さを下げ直す)ので 1 回多い
      [0.03, 0.5, 1.5, 4],
      [0.0005, 1.2, 0, 2]
    ]) {
      const calls: string[] = []
      const m = sampleModel(rate, amp, lift, calls)
      const out = await fitEncodedLoudness('web', m.measured, m.encode)
      const passes = calls.length
      const r = await m.encode(out)
      const label = `spikes ${rate} × ${amp}, lift ${lift}: ${passes} 回`
      expect(Math.abs(r.integrated - web.integrated), label).toBeLessThanOrEqual(0.3)
      expect(r.truePeak, label).toBeLessThanOrEqual(tpLimit)
      expect(passes, label).toBeLessThanOrEqual(maxPasses)
    }
  })

  it('クリック音が大きさを決めている素材でも、話し声が勝つところまで上げて基準に届かせる(上限で打ち切らない)', async () => {
    // 監査(実測): 0.5 秒ごとのクリック + 小さな音。見込み +11.8 dB で −28.7、+20.8 dB で −26.2 LUFS。
    // 途中版は「+9 dB まで」で打ち切って −24.4 だった(10/09 版は −14.0 に届く)。
    // 模型: 余裕 h(ゲイン − 抑える高さ)が 30 dB までは、クリックが削れて大きさがほとんど増えず、
    // その先は小さな音が勝って 1 dB ごとに 1 LU 上がる
    const calls: string[] = []
    const clicks = { ...measured, inputI: -25.8, inputTP: 0.2 }
    const encode = async (filter: string): Promise<EncodedLoudness> => {
      calls.push(filter)
      const m = /volume=(-?[\d.]+)dB.*alimiter=limit=([\d.]+)/.exec(filter)!
      const ceiling = 20 * Math.log10(Number(m[2]))
      const h = Number(m[1]) - ceiling
      const y = h < 30 ? -29 + 0.15 * (h - 14) : -26.6 + (h - 30)
      return { integrated: ceiling + y, truePeak: ceiling + 0.8 }
    }
    const out = await fitEncodedLoudness('web', clicks, encode)
    const r = await encode(out)
    expect(Math.abs(r.integrated - web.integrated)).toBeLessThanOrEqual(0.3)
    expect(r.truePeak).toBeLessThanOrEqual(tpLimit)
    expect(calls.length).toBeLessThanOrEqual(MAX_LOUDNESS_PASSES + 1)
  })

  /** 掛け方から (ゲイン, 抑える高さ) を読む。loudnorm なら null */
  const params = (filter: string): { gain: number; ceiling: number } | null => {
    const m = /^volume=(-?[\d.]+)dB.*alimiter=limit=([\d.]+)/.exec(filter)
    return m ? { gain: Number(m[1]), ceiling: 20 * Math.log10(Number(m[2])) } : null
  }

  it('上げると小さくなる区間がある素材(監査 c4)でも、前のやり方より基準から遠くならない', async () => {
    // 監査(実測 c4: 1 秒ごとの 3kHz の短い音 + 小さな話し声・配信): 途中版は +6.2 dB の −20.8 で止まった
    // (HEAD・10/09 版は −14.2)。模型: 余裕 h が 9〜25 dB の間は上げると小さくなり、その先で話し声が勝つ
    const c4 = { ...measured, inputI: -20.2, inputTP: 0 }
    const curve = (h: number): number =>
      h < 9 ? -23.4 + 0.3 * (h - 8.75) : h < 25 ? -23.4 - 0.12 * (h - 9) : -25.3 + 0.9 * (h - 25)
    const encode = async (filter: string): Promise<EncodedLoudness> => {
      const p = params(filter)
      if (!p) return { integrated: -20.8, truePeak: -2.5 }
      return { integrated: p.ceiling + curve(p.gain - p.ceiling), truePeak: p.ceiling + 0.4 }
    }
    // 前のやり方: AAC にする前の測りは、AAC にした後と同じとする
    const pre = async (filter: string): Promise<typeof measured> => {
      const r = await encode(filter)
      return { ...measured, inputI: r.integrated, inputTP: r.truePeak - 0.4 }
    }
    const legacyPlan = await planLimitedGainValues('web', c4, pre)
    const legacy = await encode(
      await fitEncodedTruePeak(
        'web',
        limitedGainFilter(legacyPlan!.gainDb, legacyPlan!.ceilingDb),
        legacyPlan,
        web.integrated - c4.inputI,
        encode
      )
    )
    const out = await encode(await fitEncodedLoudness('web', c4, encode, pre))
    expect(out.truePeak).toBeLessThanOrEqual(tpLimit)
    expect(Math.abs(out.integrated - web.integrated)).toBeLessThanOrEqual(
      Math.max(0.3, Math.abs(legacy.integrated - web.integrated))
    )
  })

  it('速いやり方で合わなければ前のやり方も測り、測った中で上限内・基準に最も近いものを返す', async () => {
    // 速いやり方の掛け方(リミッタ)はどれも −18 止まり、前のやり方の掛け方(loudnorm のまま)だけが合う模型
    const calls: string[] = []
    const encode = async (filter: string): Promise<EncodedLoudness> => {
      calls.push(filter)
      return params(filter)
        ? { integrated: -18, truePeak: -3 }
        : { integrated: -14.2, truePeak: -2 }
    }
    const loud = { ...measured, inputI: -20, inputTP: -8 }
    // 1回目の loudnorm で 0.2 LU なら、そもそも速いやり方で合う
    expect(await fitEncodedLoudness('web', loud, encode)).toBe(loudnormApplyFilter('web', loud))
    // 1回目が外れ、リミッタも届かない: 前のやり方の結果(loudnorm、測り済み)を返す
    let n = 0
    const encode2 = async (filter: string): Promise<EncodedLoudness> => {
      n++
      return params(filter) ? { integrated: -18, truePeak: -3 } : { integrated: -15, truePeak: -2 }
    }
    const out = await fitEncodedLoudness('web', loud, encode2)
    expect(out).toBe(loudnormApplyFilter('web', loud))
    expect(n).toBeLessThanOrEqual(MAX_LOUDNESS_PASSES + 1)
  })

  it('一度も上限に収まらなければ、抑える高さを下げて測り、収まったものを返す(測っていない掛け方を返さない)', async () => {
    const calls: string[] = []
    // AAC にすると、リミッタの高さより 6 dB 上がる。loudnorm は −0.5 dBTP
    const encode = async (filter: string): Promise<EncodedLoudness> => {
      calls.push(filter)
      const p = params(filter)
      return p
        ? { integrated: -14 + Math.min(0, p.ceiling + 2.6) * 0.1, truePeak: p.ceiling + 6 }
        : { integrated: -14, truePeak: -0.5 }
    }
    const out = await fitEncodedLoudness('web', { ...measured, inputTP: 0 }, encode, null, 2)
    expect(calls).toContain(out)
    expect((await encode(out)).truePeak).toBeLessThanOrEqual(tpLimit)
  })

  it('測れなかった(loudnorm の1パス)ときも、ピークが上限を越えたまま返さない', async () => {
    const calls: string[] = []
    const encode = async (filter: string): Promise<EncodedLoudness> => {
      calls.push(filter)
      const m = /alimiter=limit=([\d.]+)/.exec(filter)
      // loudnorm の1パスは AAC にすると +0.5 dBTP。後ろのリミッタで抑えると、その高さ + 0.8
      return m
        ? { integrated: -14.1, truePeak: 20 * Math.log10(Number(m[1])) + 0.8 }
        : { integrated: -14, truePeak: 0.5 }
    }
    const out = await fitEncodedLoudness('web', null, encode)
    expect(calls).toContain(out)
    expect(out).toMatch(/^loudnorm=I=-14:TP=-1\.5:LRA=11,aresample=192000,alimiter=/)
    expect((await encode(out)).truePeak).toBeLessThanOrEqual(tpLimit)
  })

  it('0 LUFS を越える音は loudnorm に渡さない(measured_I の範囲の外で ffmpeg が止まる)', async () => {
    const hot = { ...measured, inputI: 1.5, inputTP: 5 }
    expect(loudnormAccepts(hot)).toBe(false)
    expect(loudnormAccepts(measured)).toBe(true)
    expect(loudnormApplyFilter('web', hot)).toBe('loudnorm=I=-14:TP=-1.5:LRA=11')
    const calls: string[] = []
    await fitEncodedLoudness('web', hot, async (f) => {
      calls.push(f)
      return { integrated: -14, truePeak: -3 }
    })
    expect(calls[0]).toMatch(/^volume=-15\.50dB/)
  })

  it('loudnorm で合わせていて越えたら、同じゲインのリミッタへ切り替える', async () => {
    const calls: string[] = []
    const out = await fitEncodedLoudness('web', measured, model(2, calls))
    expect(out).toMatch(/^volume=/)
    expect((await model(2, [])(out)).truePeak).toBeLessThanOrEqual(web.truePeak)
  })

  it('測れないとき・ゲインが分からないときは、渡したものか最後に収まっていたものを返す(止めない)', async () => {
    expect(await fitEncodedLoudness('web', null, async () => null)).toBe(
      loudnormApplyFilter('web', null)
    )
    expect(
      await fitEncodedLoudness('web', null, async () => ({ integrated: -14, truePeak: 3 }))
    ).toBe(loudnormApplyFilter('web', null))
    // 2回目以降が測れなければ、収まっていたものを返す
    let n = 0
    const out = await fitEncodedLoudness('web', measured, async () =>
      n++ === 0 ? { integrated: -15, truePeak: -3 } : null
    )
    expect(out).toBe(loudnormApplyFilter('web', measured))
  })
})

describe('clipsBeyondSource(入点が素材の長さより後ろのクリップ)', () => {
  const assets = [
    {
      id: 'a',
      fileName: 'cam1.mp4',
      filePath: '/x/cam1.mp4',
      duration: 2,
      width: 1,
      height: 1,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    },
    {
      id: 's',
      fileName: 'card.png',
      filePath: '/x/card.png',
      duration: 3600,
      width: 1,
      height: 1,
      fps: 30,
      hasAudio: false,
      hasVideo: true,
      still: true
    },
    {
      id: 'u',
      fileName: 'nodur.mkv',
      filePath: '/x/nodur.mkv',
      duration: 0,
      width: 1,
      height: 1,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    }
  ]
  const v1 = {
    assets,
    clips: [
      { id: 'c0', assetId: 'a', inPoint: 0, outPoint: 1, speed: 1 },
      { id: 'c1', assetId: 'a', inPoint: 5, outPoint: 7, speed: 1 },
      { id: 'c2', assetId: 'u', inPoint: 50, outPoint: 51, speed: 1 }
    ],
    videoOverlayTracks: [
      {
        id: 'o',
        name: 'ワイプ',
        hidden: false,
        clips: [{ id: 'p', assetId: 's', startTime: 0, inPoint: 4000, outPoint: 4001 }]
      },
      {
        id: 'h',
        name: '隠し',
        hidden: true,
        clips: [{ id: 'q', assetId: 'a', startTime: 0, inPoint: 9, outPoint: 10 }]
      }
    ],
    audioTracks: [
      {
        id: 'b',
        name: 'BGM',
        muted: false,
        clips: [{ id: 'm', assetId: 'a', startTime: 0, inPoint: 2, outPoint: 3 }]
      }
    ]
  } as unknown as Project

  it('どのクリップかを返す(静止画・長さの分からない素材・隠したトラックは見ない)', () => {
    expect(clipsBeyondSource(v1).map((c) => `${c.fileName}|${c.where}`)).toEqual([
      'cam1.mp4|本編の2本目',
      'cam1.mp4|音声トラック「BGM」の1本目'
    ])
    const msg = clipsBeyondSourceMessage(clipsBeyondSource(v1))
    expect(msg).toContain('「cam1.mp4」(本編の2本目): 入点 5.00 秒・素材の長さ 2.00 秒')
    expect(msg).toContain('入点を素材の長さより前に直すか')
    expect(clipsBeyondSourceMessage([])).toBeNull()
  })

  it('v2 のシーケンスでも同じ(並びは始まりの順)', () => {
    const v2 = {
      assets,
      sequence: {
        width: 640,
        height: 360,
        fps: { num: 30, den: 1 },
        videoTracks: [
          {
            id: 'v1',
            name: 'V1',
            hidden: false,
            items: [
              {
                kind: 'media',
                id: 'x2',
                assetId: 'a',
                sourceIn: 5,
                startFrame: 30,
                durationFrames: 30
              },
              {
                kind: 'media',
                id: 'x1',
                assetId: 'a',
                sourceIn: 0,
                startFrame: 0,
                durationFrames: 30
              }
            ]
          }
        ],
        audioTracks: []
      }
    } as unknown as ProjectV2
    expect(sequenceItemsBeyondSource(v2).map((c) => c.where)).toEqual(['本編の2本目'])
  })
})

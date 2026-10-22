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
  fitEncodedTruePeak,
  limitedGainFilter,
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

describe('fitEncodedTruePeak(AAC にした後のトゥルーピーク)', () => {
  const web = LOUDNESS_TARGETS.web
  /** AAC にすると、リミッタの高さより `lift` dB 山が上がる模型。loudnorm(linear)は上限ちょうどから上がる */
  const model =
    (lift: number, calls: string[]) =>
    async (filter: string): Promise<EncodedLoudness> => {
      calls.push(filter)
      const m = /volume=(-?[\d.]+)dB.*alimiter=limit=([\d.]+)/.exec(filter)
      if (!m) return { integrated: web.integrated, truePeak: web.truePeak + lift }
      const ceiling = 20 * Math.log10(Number(m[2]))
      // ゲインを上げるほど大きく、リミッタを下げるほど少し小さくなる
      return {
        integrated: -20 + Number(m[1]) + Math.min(0, ceiling + 2.6) * 0.3,
        truePeak: ceiling + lift
      }
    }

  it('AAC にしても上限に収まっていれば、渡したフィルタをそのまま使う(1回だけ測る)', async () => {
    const calls: string[] = []
    const first = limitedGainFilter(6, -2.6)
    const out = await fitEncodedTruePeak(
      'web',
      first,
      { gainDb: 6, ceilingDb: -2.6 },
      6,
      model(0.5, calls)
    )
    expect(out).toBe(first)
    expect(calls).toHaveLength(1)
  })

  it('越えていればリミッタを下げ、下がった大きさをゲインで戻す(上限以下・基準 ±0.6 LU)', async () => {
    for (const lift of [1.5, 3.2, 5]) {
      const calls: string[] = []
      const measure = model(lift, calls)
      const out = await fitEncodedTruePeak(
        'web',
        limitedGainFilter(6, -2.6),
        { gainDb: 6, ceilingDb: -2.6 },
        6,
        measure
      )
      const r = await measure(out)
      expect(r.truePeak, `lift ${lift}`).toBeLessThanOrEqual(
        web.truePeak - ENCODED_TRUE_PEAK_MARGIN_DB
      )
      expect(Math.abs(r.integrated - web.integrated), `lift ${lift}`).toBeLessThanOrEqual(0.6)
    }
  })

  it('loudnorm で合わせていて越えたら、同じゲインのリミッタへ切り替える', async () => {
    const calls: string[] = []
    const out = await fitEncodedTruePeak('web', 'loudnorm=I=-14', null, 6, model(2, calls))
    expect(out).toMatch(/^volume=/)
    expect((await model(2, [])(out)).truePeak).toBeLessThanOrEqual(web.truePeak)
  })

  it('測れないとき・ゲインが分からないときは、渡したものか最後に収まっていたものを返す(止めない)', async () => {
    expect(await fitEncodedTruePeak('web', 'loudnorm=I=-14', null, null, async () => null)).toBe(
      'loudnorm=I=-14'
    )
    expect(
      await fitEncodedTruePeak('web', 'loudnorm=I=-14', null, null, async () => ({
        integrated: -14,
        truePeak: 3
      }))
    ).toBe('loudnorm=I=-14')
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

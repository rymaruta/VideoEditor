import { describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DOMParser } from '@xmldom/xmldom'
import type { MediaAsset, Project } from '@shared/types'
import { defaultTextStyle } from '@shared/textStyle'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { AudioItem, MediaItem, ProjectV2 } from '@shared/sequence/types'
import { readFcp7, type Fcp7Clip, type Fcp7Sequence, type XmlElement } from '@shared/import/fcp7'
import {
  buildPremiereXml,
  fcpRateOf,
  fileUrl,
  framesToTimecode,
  xmlEscape
} from '@shared/export/premiereXml'
import { premiereMarkers, premiereSrt } from '@shared/export/premiereMarkers'
import { parseSrt } from '@shared/telop/srt'

const asset = (id: string, extra: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  filePath: `/media/ロケ 素材/${id}.mp4`,
  fileName: `${id}.mp4`,
  duration: 600,
  width: 1920,
  height: 1080,
  fps: 30000 / 1001,
  hasAudio: true,
  hasVideo: true,
  ...extra
})

function parse(xml: string): Fcp7Sequence {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const seq = readFcp7(doc.documentElement as unknown as XmlElement)
  if (!seq) throw new Error('読めない')
  return seq
}

/** 秒 → シーケンスのフレーム(読み戻しの比較用) */
const fr = (sec: number, fps: number): number => Math.round(sec * fps)

/** 本編2台のカメラの切り替え・速さ・クロスフェード、ワイプ、CG、BGM・SE、テロップ・章のある企画 */
function sampleProject(): Project {
  return {
    id: 'p1',
    name: '#12 浜の回',
    aspectRatio: '16:9',
    assets: [
      asset('camA'),
      asset('camB', { filePath: 'C:\\収録\\カメラB #2\\100% 完成.MP4', fileName: '100% 完成.MP4' }),
      asset('face', { width: 1280, height: 720 }),
      asset('cg', {
        still: true,
        hasAudio: false,
        duration: 0,
        filePath: '/media/cg/タイトル.png',
        fileName: 'タイトル.png',
        width: 1920,
        height: 1080
      }),
      asset('bgm', {
        hasVideo: false,
        width: 0,
        height: 0,
        duration: 180,
        filePath: '/media/音楽/bgm.wav',
        fileName: 'bgm.wav'
      }),
      asset('se', {
        hasVideo: false,
        width: 0,
        height: 0,
        duration: 2,
        filePath: '/media/音楽/se.wav',
        fileName: 'se.wav'
      })
    ],
    clips: [
      { id: 'c1', assetId: 'camA', inPoint: 10, outPoint: 15, speed: 1 },
      // アングルの切り替え(別のカメラの同じ時刻)
      { id: 'c2', assetId: 'camB', inPoint: 15, outPoint: 21, speed: 2 },
      {
        id: 'c3',
        assetId: 'camA',
        inPoint: 30,
        outPoint: 36,
        speed: 1,
        transitionIn: { type: 'crossfade', duration: 1 }
      },
      {
        id: 'c4',
        assetId: 'camB',
        inPoint: 40,
        outPoint: 44.5,
        speed: 1,
        fillCrop: true,
        cropCenter: { x: 0.3, y: 0.5 }
      }
    ],
    videoOverlayTracks: [
      {
        id: 'pip',
        name: 'ワイプ',
        hidden: false,
        position: 'top-right',
        scale: 0.25,
        clips: [{ id: 'p1', assetId: 'face', startTime: 2, inPoint: 100, outPoint: 104 }]
      },
      {
        id: 'cgt',
        name: 'CG',
        hidden: false,
        position: 'full',
        scale: 1,
        clips: [{ id: 'g1', assetId: 'cg', startTime: 0, inPoint: 0, outPoint: 3 }]
      }
    ],
    audioTracks: [
      {
        id: 'bgmT',
        name: 'BGM',
        muted: false,
        volume: 0.5,
        duckingEnabled: false,
        clips: [
          {
            id: 'b1',
            assetId: 'bgm',
            startTime: 1,
            inPoint: 0,
            outPoint: 12,
            volume: 0.8,
            fadeIn: 1,
            fadeOut: 2
          }
        ]
      },
      {
        id: 'seT',
        name: 'SE',
        muted: true,
        volume: 1,
        duckingEnabled: false,
        clips: [{ id: 's1', assetId: 'se', startTime: 4, inPoint: 0, outPoint: 1.5 }]
      }
    ],
    textOverlays: [
      { id: 't1', text: '浜に**到着**!', startTime: 1, endTime: 3, style: defaultTextStyle() },
      {
        id: 't2',
        text: '第1章\n浜の朝',
        startTime: 0.3,
        endTime: 3.3,
        style: defaultTextStyle(),
        effectId: 'chapter-s1'
      },
      { id: 't3', text: '<危ない> & "注意"', startTime: 8, endTime: 9.5, style: defaultTextStyle() }
    ]
  }
}

describe('buildPremiereXml — 書いた XML を FCP7 の読み込みで読み戻す(往復)', () => {
  const project = sampleProject()
  const v2 = projectV1ToV2(project, { resolution: 1080 })
  const fps = v2.sequence.fps.num / v2.sequence.fps.den
  const markers = premiereMarkers(project, v2, {
    reviews: [{ key: 'k', kind: 'テロップと顔', text: '顔に掛かる', overlayId: 't1' }]
  })
  const { xml, stats } = buildPremiereXml(v2, { markers })
  const seq = parse(xml)

  it('シーケンスの名前・フレームレート(29.97)・尺', () => {
    expect(seq.name).toBe('#12 浜の回')
    expect(seq.fps).toBeCloseTo(30000 / 1001, 9)
    expect(xml).toContain('<timebase>30</timebase>')
    expect(xml).toContain('<ntsc>TRUE</ntsc>')
    expect(xml).toContain('<displayformat>DF</displayformat>')
    expect(xml).toContain('<string>00;00;00;00</string>')
    expect(xml).toContain('<width>1920</width>')
    expect(xml).toContain('<samplerate>48000</samplerate>')
    expect(fr(seq.duration, fps)).toBe(stats.durationFrames)
  })

  it('本編: カット・アングル・位置・in/out・速さ(繋ぎは真ん中で突き合わせ)', () => {
    const main = v2.sequence.videoTracks[0].items as MediaItem[]
    const got = seq.video[0]
    expect(got.map((c) => c.fileName)).toEqual([
      'camA.mp4',
      '100% 完成.MP4',
      'camA.mp4',
      '100% 完成.MP4'
    ])
    // 期待値を v2 から作る: 繋ぎのある所は切れ目 = 繋ぎの頭 + 長さの半分
    const expected = main.map((it) => ({
      start: it.startFrame,
      end: it.startFrame + it.durationFrames,
      sourceIn: it.sourceIn,
      speed: it.speed
    }))
    for (let i = 1; i < main.length; i++) {
      const t = main[i].transitionIn
      if (!t) continue
      const cut = main[i].startFrame + Math.floor(t.durationFrames / 2)
      expected[i - 1].end = cut
      expected[i].sourceIn += ((cut - main[i].startFrame) / fps) * main[i].speed
      expected[i].start = cut
    }
    got.forEach((c, i) => {
      expect(fr(c.start, fps)).toBe(expected[i].start)
      expect(fr(c.end, fps)).toBe(expected[i].end)
      const speed = c.speed ?? 1
      expect(speed).toBe(expected[i].speed)
      // 素材の秒(in × 速さ)。クリップの時間のフレームに丸めるので、ずれは半フレーム × 速さまで
      expect(Math.abs(c.in * speed - expected[i].sourceIn)).toBeLessThanOrEqual(
        (0.5 * speed) / fps + 1e-9
      )
      expect(fr(c.out - c.in, fps)).toBe(expected[i].end - expected[i].start)
    })
    expect(xml).toContain('<name>Cross Dissolve</name>')
    expect(xml).toContain('<effectid>timeremap</effectid>')
    expect(xml).toMatch(/<parameterid>speed<\/parameterid>[\s\S]*?<value>200<\/value>/)
  })

  it('ワイプ・CG(素材ファイルのある重ね)は上のトラックに、大きさと位置つきで', () => {
    const files = seq.video.slice(1).map((t) => t.map((c) => c.fileName))
    expect(files).toEqual([['face.mp4'], ['タイトル.png']])
    const pip = v2.sequence.videoTracks.find((t) => t.id === 'pip')!.items[0] as MediaItem
    const got = seq.video[1][0]
    expect(fr(got.start, fps)).toBe(pip.startFrame)
    expect(fr(got.end, fps)).toBe(pip.startFrame + pip.durationFrames)
    expect(Math.abs(got.in - pip.sourceIn)).toBeLessThanOrEqual(0.5 / fps + 1e-9)
    // 1280 幅の素材を 1920 の 1/4(480px)に: 37.5%
    expect(xml).toContain('<value>37.5</value>')
    expect(xml).toContain('<alphatype>straight</alphatype>')
  })

  it('音声: 本編の音・BGM・SE のトラック、音量(クリップ × トラック)、フェード、ミュート', () => {
    const names = (t: Fcp7Clip[]): string[] => t.map((c) => c.fileName)
    // ミュートした SE のトラックは enabled=FALSE(読み込みは読まない)
    expect(seq.audio.map(names)).toEqual([
      ['camA.mp4', '100% 完成.MP4', 'camA.mp4', '100% 完成.MP4'],
      ['bgm.wav'],
      ['face.mp4']
    ])
    expect(xml).toMatch(
      /<enabled>FALSE<\/enabled>\s*<locked>FALSE<\/locked>\s*<outputchannelindex>/
    )
    const bgm = v2.sequence.audioTracks.find((t) => t.id === 'bgmT')!.items[0] as AudioItem
    const got = seq.audio[1][0]
    expect(got.gain).toBeCloseTo(0.4, 6)
    expect(fr(got.start, fps)).toBe(bgm.startFrame)
    expect(fr(got.end, fps)).toBe(bgm.startFrame + bgm.durationFrames)
    expect(xml).toContain('<alignment>start-black</alignment>')
    expect(xml).toContain('<alignment>end-black</alignment>')
    expect(xml).toContain('KGAudioTransCrossFade3dB')
    // 本編の映像と音はリンクする
    expect(xml).toMatch(
      /<link>\s*<linkclipref>clipitem-\d+<\/linkclipref>\s*<mediatype>audio<\/mediatype>/
    )
  })

  it('音の速さも映像と同じ(本編の 2 倍速の音)', () => {
    expect(seq.audio[0][1].speed).toBe(2)
  })

  it('マーカー: テロップ(文字はコメント)・章・要確認が、同じフレームで読み戻せる', () => {
    expect(seq.markers!.length).toBe(markers.length)
    seq.markers!.forEach((m, i) => {
      expect(fr(m.start, fps)).toBe(markers[i].frame)
      expect(m.name).toBe(markers[i].name)
      expect(m.comment).toBe(markers[i].comment)
      if (markers[i].durationFrames)
        expect(fr(m.end! - m.start, fps)).toBe(markers[i].durationFrames)
    })
    const names = markers.map((m) => m.name)
    expect(names).toContain('章: 第1章 浜の朝')
    expect(names).toContain('要確認: テロップと顔')
    const comments = markers.map((m) => m.comment)
    expect(comments).toContain('浜に到着!')
    expect(comments).toContain('<危ない> & "注意"')
  })

  it('素材のパス(Windows・日本語・空白・#・%)が読み戻すと元のパスになる', () => {
    expect(seq.video[0][1].path).toBe('C:/収録/カメラB #2/100% 完成.MP4')
    expect(seq.video[0][0].path).toBe('/media/ロケ 素材/camA.mp4')
  })

  it('SRT はシーケンスの時刻(繋ぎで詰めた後の時刻)で、文字の飾りを外す', () => {
    const cues = parseSrt(premiereSrt(v2))
    const telops = v2.sequence.videoTracks.flatMap((t) => t.items.filter((i) => i.kind === 'telop'))
    expect(cues.length).toBe(telops.length)
    expect(cues.map((c) => c.text)).toContain('浜に到着!')
    for (const c of cues) {
      const t = telops.find((x) => Math.abs(x.startFrame / fps - c.start) < 0.001)
      expect(t).toBeDefined()
    }
  })

  it('xmllint で整形式。DTD(XMEML_DTD に Apple の v4 の DTD を置いたとき)にも沿う', () => {
    const r = spawnSync('xmllint', ['--version'])
    if (r.error) return
    const dir = mkdtempSync(join(tmpdir(), 've-xml-'))
    try {
      const p = join(dir, 'a.xml')
      writeFileSync(p, xml, 'utf-8')
      const check = spawnSync('xmllint', ['--noout', p], { encoding: 'utf-8' })
      expect(check.stderr).toBe('')
      expect(check.status).toBe(0)
      // Apple の DTD(「Final Cut Pro XML Interchange Format」付録 A の Listing A-4)は同梱しない。
      // 置いたときだけ検査する。Premiere の拡張(authoringApp・premiereTrackType・numOutputChannels。
      // Premiere 自身が書き出す形)だけは DTD に無いので除く
      const dtd = process.env.XMEML_DTD
      if (!dtd) return
      const valid = spawnSync('xmllint', ['--noout', '--dtdvalid', dtd, p], { encoding: 'utf-8' })
      const errors = valid.stderr
        .split('\n')
        .filter((l) => /: (validity )?error/.test(l) || /does not follow|No declaration/.test(l))
        .filter(
          (l) =>
            !/authoringApp|premiereTrackType|numOutputChannels/.test(l) &&
            !/does not validate/.test(l)
        )
      expect(errors).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('形: 全クリップに start/end/in/out/file、out - in = 長さ、トラックの中で重ならない', () => {
    const doc = new DOMParser().parseFromString(xml, 'text/xml')
    const items = doc.getElementsByTagName('clipitem')
    expect(items.length).toBe(stats.videoClips + stats.audioClips)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      for (const tag of ['start', 'end', 'in', 'out', 'duration', 'file', 'rate'])
        expect(it.getElementsByTagName(tag).length).toBeGreaterThan(0)
      const v = (t: string): number => Number(it.getElementsByTagName(t)[0].textContent)
      if (v('start') >= 0 && v('end') >= 0) expect(v('out') - v('in')).toBe(v('end') - v('start'))
      expect(v('out')).toBeLessThanOrEqual(v('duration'))
      expect(v('in')).toBeGreaterThanOrEqual(0)
    }
    for (const t of [...seq.video, ...seq.audio])
      for (let i = 1; i < t.length; i++)
        expect(t[i].start).toBeGreaterThanOrEqual(t[i - 1].end - 1e-9)
  })
})

describe('フレームレート', () => {
  const cases: [string, number, number, number, boolean][] = [
    ['23.976', 24000, 1001, 24, true],
    ['29.97', 30000, 1001, 30, true],
    ['59.94', 60000, 1001, 60, true],
    ['25', 25, 1, 25, false],
    ['30', 30, 1, 30, false],
    ['60', 60, 1, 60, false]
  ]
  for (const [label, num, den, tb, ntsc] of cases) {
    it(`${label} → timebase ${tb} / ntsc ${ntsc}、読み戻しのレートが一致`, () => {
      expect(fcpRateOf({ num, den })).toEqual({ timebase: tb, ntsc })
      const v2: ProjectV2 = {
        version: 2,
        id: 'x',
        name: 'x',
        assets: [asset('a', { fps: num / den })],
        sequence: {
          width: 1920,
          height: 1080,
          fps: { num, den },
          videoTracks: [
            {
              id: 'v',
              name: 'v',
              hidden: false,
              items: [
                {
                  kind: 'media',
                  id: 'm',
                  assetId: 'a',
                  startFrame: 0,
                  durationFrames: 100,
                  sourceIn: 0,
                  speed: 1,
                  origin: 'auto',
                  placement: { kind: 'frame', fit: 'contain' }
                }
              ]
            }
          ],
          audioTracks: []
        }
      }
      const { xml } = buildPremiereXml(v2)
      const seq = parse(xml)
      expect(seq.fps).toBeCloseTo(num / den, 9)
      // DF は 29.97 / 59.94 だけ
      expect(xml.includes('<displayformat>DF</displayformat>')).toBe(ntsc && tb !== 24)
    })
  }

  it('ノンドロップを選べる(29.97 NDF)', () => {
    expect(framesToTimecode(1800, { timebase: 30, ntsc: true }, false)).toBe('00:01:00:00')
  })
})

describe('29.97 DF・3 時間で 1 フレームもずれない', () => {
  it('タイムコード: DF の飛ばし方と 3 時間ちょうど', () => {
    const r = { timebase: 30, ntsc: true }
    expect(framesToTimecode(0, r, true)).toBe('00;00;00;00')
    expect(framesToTimecode(1799, r, true)).toBe('00;00;59;29')
    expect(framesToTimecode(1800, r, true)).toBe('00;01;00;02')
    expect(framesToTimecode(17982, r, true)).toBe('00;10;00;00')
    expect(framesToTimecode(107892, r, true)).toBe('01;00;00;00')
    expect(framesToTimecode(323676, r, true)).toBe('03;00;00;00')
    expect(framesToTimecode(323675, r, true)).toBe('02;59;59;29')
    const r60 = { timebase: 60, ntsc: true }
    expect(framesToTimecode(3600, r60, true)).toBe('00;01;00;04')
    expect(framesToTimecode(647352, r60, true)).toBe('03;00;00;00')
  })

  it('3 時間・約 2000 カット(長さも素材の位置もばらばら)の全カットが、読み戻しで同じフレーム', () => {
    const fps = 30000 / 1001
    const total = 323676 // 3 時間(29.97 DF)
    const items: MediaItem[] = []
    const audio: AudioItem[] = []
    let f = 0
    let k = 0
    // 決まった並びの擬似乱数(毎回同じ)
    let seed = 12345
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    while (f < total) {
      const len = Math.min(total - f, 30 + Math.floor(rnd() * 300))
      // 素材の位置はフレームに乗った秒(29.97 の素材のフレーム境界)
      const srcFrame = Math.floor(rnd() * 300000)
      const sourceIn = (srcFrame * 1001) / 30000
      items.push({
        kind: 'media',
        id: `m${k}`,
        assetId: 'a',
        startFrame: f,
        durationFrames: len,
        sourceIn,
        speed: 1,
        origin: 'auto',
        placement: { kind: 'frame', fit: 'contain' }
      })
      audio.push({
        kind: 'audio',
        id: `a${k}`,
        assetId: 'a',
        startFrame: f,
        durationFrames: len,
        sourceIn,
        speed: 1,
        origin: 'auto',
        linkedItemId: `m${k}`
      })
      f += len
      k++
    }
    const v2: ProjectV2 = {
      version: 2,
      id: 'long',
      name: '3時間',
      assets: [asset('a', { duration: 4 * 3600 })],
      sequence: {
        width: 1920,
        height: 1080,
        fps: { num: 30000, den: 1001 },
        videoTracks: [{ id: 'v', name: 'v', hidden: false, items }],
        audioTracks: [
          { id: 'a', name: 'a', muted: false, volume: 1, duckingEnabled: false, items: audio }
        ]
      }
    }
    const { xml, stats } = buildPremiereXml(v2, {
      markers: [{ frame: total - 1, name: '最後', comment: '' }]
    })
    expect(stats.durationFrames).toBe(total)
    const seq = parse(xml)
    expect(seq.video[0].length).toBe(items.length)
    expect(fr(seq.duration, fps)).toBe(total)
    let bad = 0
    seq.video[0].forEach((c, i) => {
      const it = items[i]
      if (fr(c.start, fps) !== it.startFrame) bad++
      if (fr(c.end, fps) !== it.startFrame + it.durationFrames) bad++
      // 素材の位置も同じフレーム
      if (fr(c.in, fps) !== Math.round(it.sourceIn * fps)) bad++
    })
    seq.audio[0].forEach((c, i) => {
      if (fr(c.start, fps) !== audio[i].startFrame) bad++
    })
    expect(bad).toBe(0)
    expect(fr(seq.markers![0].start, fps)).toBe(total - 1)
  })
})

describe('素材のパスの符号化', () => {
  it('mac / Linux: 日本語・空白・#・%・?・& を符号化する', () => {
    expect(fileUrl('/Users/山田/Movies/ロケ #1/100% 完成?.mov')).toBe(
      'file://localhost/Users/%E5%B1%B1%E7%94%B0/Movies/%E3%83%AD%E3%82%B1%20%231/100%25%20%E5%AE%8C%E6%88%90%3F.mov'
    )
    expect(fileUrl('/home/a/b&c d.mp4')).toBe('file://localhost/home/a/b%26c%20d.mp4')
  })

  it('Windows: ドライブは C%3a、区切りは /', () => {
    expect(fileUrl('D:\\ロケ\\A0001.MP4')).toBe(
      'file://localhost/D%3a/%E3%83%AD%E3%82%B1/A0001.MP4'
    )
  })

  it('Windows の共有フォルダ(UNC)', () => {
    expect(fileUrl('\\\\nas\\共有\\a b.mov')).toBe('file://nas/%E5%85%B1%E6%9C%89/a%20b.mov')
  })

  it('mac の分解した濁点(NFD)は合成済み(NFC)にそろえる', () => {
    const nfd = '/Users/a/ガ.mov'.normalize('NFD')
    expect(fileUrl(nfd)).toBe(fileUrl('/Users/a/ガ.mov'.normalize('NFC')))
  })

  it('読み込み(FCP7)で元のパスに戻る', () => {
    for (const path of [
      '/Users/山田/Movies/ロケ #1/100% 完成?.mov',
      'C:/収録/カメラB #2/100%.MP4',
      '/home/u/a&b;c=d+e(1).mp4'
    ]) {
      const v2: ProjectV2 = {
        version: 2,
        id: 'x',
        name: 'x',
        assets: [asset('a', { filePath: path })],
        sequence: {
          width: 1920,
          height: 1080,
          fps: { num: 30, den: 1 },
          videoTracks: [
            {
              id: 'v',
              name: 'v',
              hidden: false,
              items: [
                {
                  kind: 'media',
                  id: 'm',
                  assetId: 'a',
                  startFrame: 0,
                  durationFrames: 10,
                  sourceIn: 0,
                  speed: 1,
                  origin: 'auto',
                  placement: { kind: 'frame', fit: 'contain' }
                }
              ]
            }
          ],
          audioTracks: []
        }
      }
      expect(parse(buildPremiereXml(v2).xml).video[0][0].path).toBe(path)
    }
  })

  it('XML の特別な文字・使えない制御文字', () => {
    expect(xmlEscape('a<b>&"c\'\u0001d')).toBe('a&lt;b&gt;&amp;&quot;c&apos;d')
  })
})

describe('見た目どおりのテロップ(透過の画像・動画)', () => {
  it('PNG の区間は一番上のトラックに、同じ画像は同じファイルの定義を使い回す', () => {
    const project = sampleProject()
    const v2 = projectV1ToV2(project)
    const { xml } = buildPremiereXml(v2, {
      telopMedia: {
        width: 1920,
        height: 1080,
        clips: [
          {
            path: '/out/x_テロップ/telop_000001.png',
            startFrame: 30,
            durationFrames: 10,
            still: true
          },
          {
            path: '/out/x_テロップ/telop_000002.png',
            startFrame: 40,
            durationFrames: 20,
            still: true
          },
          {
            path: '/out/x_テロップ/telop_000001.png',
            startFrame: 90,
            durationFrames: 5,
            still: true
          }
        ]
      }
    })
    const seq = parse(xml)
    const top = seq.video[seq.video.length - 1]
    expect(top.map((c) => [fr(c.start, 30000 / 1001), fr(c.end, 30000 / 1001)])).toEqual([
      [30, 40],
      [40, 60],
      [90, 95]
    ])
    expect(top[2].path).toBe('/out/x_テロップ/telop_000001.png')
    expect((xml.match(/<file id="file-\d+">/g) ?? []).length).toBe(
      new Set(xml.match(/<file id="file-\d+"/g)).size
    )
  })

  it('ProRes 4444 の 1 本は頭から全体に', () => {
    const v2 = projectV1ToV2(sampleProject())
    const total = 400
    const { xml } = buildPremiereXml(v2, {
      telopMedia: {
        width: 1920,
        height: 1080,
        clips: [
          {
            path: '/out/x_テロップ.mov',
            startFrame: 0,
            durationFrames: total,
            still: false,
            sourceInFrame: 0,
            fileFrames: total
          }
        ]
      }
    })
    const seq = parse(xml)
    const top = seq.video[seq.video.length - 1]
    expect(top.length).toBe(1)
    expect(fr(top[0].end, 30000 / 1001)).toBe(total)
    expect(fr(seq.duration, 30000 / 1001)).toBeGreaterThanOrEqual(total)
  })
})

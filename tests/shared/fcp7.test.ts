import { describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { fcp7ToProject, readFcp7, type XmlElement } from '../../src/shared/import/fcp7'
import { compareEdits, cutPoints } from '../../src/shared/eval/compare'
import { measureProject } from '../../src/shared/style/showStyle'
import type { MulticamInfo } from '../../src/shared/sync/multicam'
import type { Project } from '../../src/shared/types'

/** Premiere が書き出す形に近い xmeml(30fps・NTSC でない) */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>#297 浄土ヶ浜</name>
    <duration>900</duration>
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <track>
          <clipitem id="c1">
            <name>A0001.MP4</name><start>0</start><end>150</end><in>300</in><out>450</out>
            <file id="file-a"><name>A0001.MP4</name><pathurl>file://localhost/D:/%E3%83%AD%E3%82%B1/A0001.MP4</pathurl>
              <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate><duration>9000</duration></file>
          </clipitem>
          <clipitem id="c2">
            <name>B0001.MP4</name><start>150</start><end>300</end><in>300</in><out>450</out>
            <file id="file-b"><name>B0001.MP4</name><rate><timebase>30</timebase></rate><duration>9000</duration></file>
          </clipitem>
          <clipitem id="c3">
            <name>A0001.MP4</name><start>300</start><end>450</end><in>900</in><out>1050</out>
            <file id="file-a"/>
          </clipitem>
          <clipitem id="c4">
            <name>OTHER.MP4</name><start>450</start><end>480</end><in>0</in><out>30</out>
            <file id="file-x"><name>OTHER.MP4</name></file>
          </clipitem>
        </track>
        <track>
          <generatoritem id="g1">
            <name>テキスト</name><start>30</start><end>90</end>
            <effect><name>Text</name><effectid>Text</effectid>
              <parameter><parameterid>str</parameterid><value>浄土ヶ浜に到着!</value></parameter>
            </effect>
          </generatoritem>
          <generatoritem id="g2">
            <name>テキスト</name><start>120</start><end>180</end>
            <effect><parameter><parameterid>str</parameterid><value>うまい!</value></parameter></effect>
          </generatoritem>
        </track>
      </video>
      <audio>
        <track>
          <clipitem id="m1"><name>PIN_01.WAV</name><start>0</start><end>450</end><in>300</in><out>750</out>
            <file id="file-m"><name>PIN_01.WAV</name><rate><timebase>30</timebase></rate><duration>108000</duration></file>
          </clipitem>
        </track>
        <track>
          <clipitem id="bgm"><name>fun.mp3</name><start>0</start><end>900</end><in>0</in><out>900</out>
            <file id="file-bgm"><name>fun.mp3</name><rate><timebase>30</timebase></rate><duration>5400</duration></file>
            <filter><effect><name>Audio Levels</name><parameter><parameterid>level</parameterid><value>0.25</value></parameter></effect></filter>
          </clipitem>
        </track>
        <track>
          <clipitem id="se1"><name>pon.wav</name><start>60</start><end>75</end><in>0</in><out>15</out>
            <file id="file-se"><name>pon.wav</name><rate><timebase>30</timebase></rate><duration>15</duration></file></clipitem>
          <clipitem id="se2"><name>pon.wav</name><start>200</start><end>215</end><in>0</in><out>15</out><file id="file-se"/></clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>`

const root = new DOMParser().parseFromString(XML, 'text/xml')
  .documentElement as unknown as XmlElement

describe('readFcp7', () => {
  it('本編・テロップ・音声を秒で読み、ID だけの参照も元のファイルにたどる', () => {
    const seq = readFcp7(root)!
    expect(seq.name).toBe('#297 浄土ヶ浜')
    expect(seq.duration).toBe(30)
    const v1 = seq.video[0]
    expect(v1.map((c) => [c.fileName, c.start, c.end, c.in, c.out])).toEqual([
      ['A0001.MP4', 0, 5, 10, 15],
      ['B0001.MP4', 5, 10, 10, 15],
      ['A0001.MP4', 10, 15, 30, 35],
      ['OTHER.MP4', 15, 16, 0, 1]
    ])
    expect(v1[0].path).toBe('D:/ロケ/A0001.MP4')
    expect(v1[2].fileDuration).toBe(300)
    expect(seq.texts).toEqual([
      { start: 1, end: 3, text: '浄土ヶ浜に到着!' },
      { start: 4, end: 6, text: 'うまい!' }
    ])
    expect(seq.audio[1][0].gain).toBe(0.25)
    expect(seq.audio[2].map((c) => c.start)).toEqual([2, 200 / 30])
  })
})

describe('fcp7ToProject → 番組スタイルの学習', () => {
  it('長い録音は声として除き、短い音を SE、残りを BGM として音量を測る', () => {
    const project = fcp7ToProject(readFcp7(root)!)
    const m = measureProject(project)
    expect(m.bgmVolume).toBeCloseTo(0.25)
    // 本編 16 秒に SE 2 個 → 30秒未満なので SE の頻度は測らない(短すぎる回は使わない)
    expect(m.sePerMinute).toBeUndefined()
    expect(project.audioTracks[0].voice).toBe(true)
    expect(project.textOverlays.map((t) => t.text)).toEqual(['浄土ヶ浜に到着!', 'うまい!'])
  })
})

describe('compareEdits', () => {
  const info: MulticamInfo = {
    anchorSourceId: 'A',
    sources: [
      { id: 'A', name: 'カメラA', kind: 'camera' },
      { id: 'B', name: 'カメラB', kind: 'camera' }
    ],
    files: [
      { assetId: 'a', sourceId: 'A', start: 0, rate: 1, duration: 300 },
      // カメラB は 5 秒遅れて回った(素材の 5 秒 = 共通の 10 秒)
      { assetId: 'b', sourceId: 'B', start: 5, rate: 1, duration: 300 }
    ]
  }
  const asset = (id: string, fileName: string): Project['assets'][number] => ({
    id,
    filePath: `/x/${fileName}`,
    fileName,
    duration: 300,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    hasVideo: true
  })
  const base: Project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [asset('a', 'A0001.MP4'), asset('b', 'B0001.MP4')],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  }

  it('人の完成版(共通の 10〜15 秒をカメラA・15〜20 秒をカメラB・30〜35 秒をカメラA)と同じなら一致度 1', () => {
    const seq = readFcp7(root)!
    const same: Project = {
      ...base,
      clips: [
        { id: '1', assetId: 'a', inPoint: 10, outPoint: 15, speed: 1 },
        { id: '2', assetId: 'b', inPoint: 10, outPoint: 15, speed: 1 },
        { id: '3', assetId: 'a', inPoint: 30, outPoint: 35, speed: 1 }
      ]
    }
    const r = compareEdits(seq, same, info)
    expect(r.iou).toBeCloseTo(1)
    expect(r.cutRecall).toBe(1)
    expect(r.angleAgreement).toBe(1)
    expect([r.matchedClips, r.totalClips]).toEqual([3, 4])
    expect(r.unmatchedFiles).toEqual(['OTHER.MP4'])
  })

  it('残した区間・カット点・アングルの食い違いを測る', () => {
    const seq = readFcp7(root)!
    const differ: Project = {
      ...base,
      // 10〜20 秒を全部カメラA で、30〜35 秒は使わず 40〜45 秒を使った
      clips: [
        { id: '1', assetId: 'a', inPoint: 10, outPoint: 20, speed: 1 },
        { id: '2', assetId: 'a', inPoint: 40, outPoint: 45, speed: 1 }
      ]
    }
    const r = compareEdits(seq, differ, info)
    // 人 15 秒・自動 15 秒・重なり 10 秒 → 10 / 20
    expect(r.iou).toBeCloseTo(0.5)
    expect(r.angleAgreement).toBeCloseTo(0.5, 1)
    expect(r.cutRecall).toBeLessThan(1)
  })

  it('カット点は、時間が飛ぶ所とカメラが替わる所', () => {
    expect(
      cutPoints([
        { start: 0, end: 5, cameraId: 'A' },
        { start: 5, end: 10, cameraId: 'B' },
        { start: 20, end: 25, cameraId: 'B' }
      ])
    ).toEqual([5, 10, 20])
  })
})

/**
 * Premiere がマルチカメラのまま書き出した形: 親のクリップがネストしたシーケンスを指す。
 * マルチカメラのソース(mc)は、同期したカメラA(V1)・カメラB(V2。5秒遅れて回った)を積んだもの。
 * どのカメラを選んだかは XML に残らない。plain は1トラックだけの普通のネスト。
 */
const NESTED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4">
  <sequence id="main">
    <name>マルチカメラのまま</name><duration>450</duration>
    <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <track>
          <clipitem id="p1"><name>MC</name><start>0</start><end>150</end><in>300</in><out>450</out>
            <sequence id="mc"><name>MC</name><rate><timebase>30</timebase></rate>
              <media><video>
                <track><clipitem id="m1"><name>A0001.MP4</name><start>0</start><end>9000</end><in>0</in><out>9000</out>
                  <file id="fa"><name>A0001.MP4</name></file></clipitem></track>
                <track><clipitem id="m2"><name>B0001.MP4</name><start>150</start><end>9000</end><in>0</in><out>8850</out>
                  <file id="fb"><name>B0001.MP4</name></file></clipitem></track>
              </video></media>
            </sequence>
          </clipitem>
          <clipitem id="p2"><name>MC</name><start>150</start><end>300</end><in>450</in><out>600</out>
            <sequence id="mc"/>
          </clipitem>
          <clipitem id="p3"><name>plain</name><start>300</start><end>450</end><in>0</in><out>150</out>
            <sequence id="plain"><name>plain</name><rate><timebase>30</timebase></rate>
              <media><video><track>
                <clipitem id="q1"><name>A0001.MP4</name><start>0</start><end>300</end><in>900</in><out>1200</out>
                  <file id="fa"/></clipitem>
              </track></video></media>
            </sequence>
          </clipitem>
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`

describe('ネストしたシーケンス(マルチカメラのまま書き出した XML)', () => {
  const nestedRoot = new DOMParser().parseFromString(NESTED_XML, 'text/xml')
  const seq = readFcp7(nestedRoot.documentElement as unknown as XmlElement)!

  it('中身のカメラの素材に展開する。カメラが積まれている所は「選んだカメラが分からない」印を付ける', () => {
    expect(seq.nested).toEqual({ count: 3, multicam: 2 })
    expect(
      seq.video[0].map((c) => [c.fileName, c.start, c.end, c.in, c.out, c.angleUnknown])
    ).toEqual([
      // 上のトラック(カメラB)を仮に入れる。B は 5 秒遅れて回ったので、ソースの 10 秒 = B の 5 秒
      ['B0001.MP4', 0, 5, 5, 10, 0],
      ['B0001.MP4', 5, 10, 10, 15, 1],
      ['A0001.MP4', 10, 15, 30, 35, undefined]
    ])
  })

  it('比べるとき、採用区間とカット点には使い、アングルの一致からは外す', () => {
    const info: MulticamInfo = {
      anchorSourceId: 'A',
      sources: [
        { id: 'A', name: 'カメラA', kind: 'camera' },
        { id: 'B', name: 'カメラB', kind: 'camera' }
      ],
      files: [
        { assetId: 'a', sourceId: 'A', start: 0, rate: 1, duration: 300 },
        { assetId: 'b', sourceId: 'B', start: 5, rate: 1, duration: 300 }
      ]
    }
    const asset = (id: string, fileName: string): Project['assets'][number] => ({
      id,
      filePath: `/x/${fileName}`,
      fileName,
      duration: 300,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    })
    const project: Project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [asset('a', 'A0001.MP4'), asset('b', 'B0001.MP4')],
      // 自動: 共通の 10〜15 秒をカメラA、15〜20 秒をカメラB、30〜35 秒をカメラA
      clips: [
        { id: '1', assetId: 'a', inPoint: 10, outPoint: 15, speed: 1 },
        { id: '2', assetId: 'b', inPoint: 10, outPoint: 15, speed: 1 },
        { id: '3', assetId: 'a', inPoint: 30, outPoint: 35, speed: 1 }
      ],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    }
    const r = compareEdits(seq, project, info)
    expect(r.iou).toBeCloseTo(1)
    // 人のカット点(15 = 親のクリップの境目、20 と 30 = 飛び)を自動も全部切っている
    expect(r.cutRecall).toBe(1)
    expect(r.angleUnknownSec).toBeCloseTo(10, 0)
    // 比べたのはカメラが分かる 30〜35 秒だけ(どちらもカメラA)
    expect(r.angleAgreement).toBe(1)
  })
})

describe('つなぎ(トランジション)の付いたクリップ・文字', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4"><sequence id="s"><name>つなぎ</name><duration>300</duration>
  <rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>
  <media><video>
    <track>
      <clipitem id="a"><name>A.MP4</name><start>0</start><end>-1</end><in>0</in><out>165</out><file id="fa"><name>A.MP4</name></file></clipitem>
      <transitionitem><start>135</start><end>165</end></transitionitem>
      <clipitem id="b"><name>B.MP4</name><start>-1</start><end>300</end><in>285</in><out>450</out><file id="fb"><name>B.MP4</name></file></clipitem>
    </track>
    <track>
      <transitionitem><start>30</start><end>60</end></transitionitem>
      <generatoritem id="g"><name>Text</name><start>-1</start><end>120</end><in>0</in><out>90</out>
        <effect><parameter><parameterid>str</parameterid><value>溶けて出る文字</value></parameter></effect></generatoritem>
    </track>
  </video></media></sequence></xmeml>`
  const seq = readFcp7(
    new DOMParser().parseFromString(xml, 'text/xml').documentElement as unknown as XmlElement
  )!

  it('始まりの分からないクリップは、終わりから素材の長さぶん戻した所から', () => {
    const b = seq.video[0][1]
    expect(b.start).toBeCloseTo(4.5)
    expect(b.end).toBeCloseTo(10)
    expect(b.end - b.start).toBeCloseTo(b.out - b.in)
  })

  it('溶けて出る文字(start が -1)も落とさない', () => {
    expect(seq.texts).toEqual([{ start: 1, end: 4, text: '溶けて出る文字' }])
  })
})

describe('入れ子の中のマルチカメラ', () => {
  // 普通の入れ子 N(0〜1秒)がマルチカメラ M を包み、その直後に M を直接使ったクリップ(1〜2秒)
  const mc = `<sequence id="m"><name>M</name><rate><timebase>30</timebase></rate><media><video>
      <track><clipitem id="m1"><name>A0001.MP4</name><start>0</start><end>9000</end><in>0</in><out>9000</out><file id="fa"><name>A0001.MP4</name></file></clipitem></track>
      <track><clipitem id="m2"><name>B0001.MP4</name><start>0</start><end>9000</end><in>0</in><out>9000</out><file id="fb"><name>B0001.MP4</name></file></clipitem></track>
    </video></media></sequence>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4"><sequence id="main"><name>入れ子</name><duration>60</duration>
  <rate><timebase>30</timebase></rate><media><video><track>
    <clipitem id="p1"><name>N</name><start>0</start><end>30</end><in>0</in><out>30</out>
      <sequence id="n"><name>N</name><rate><timebase>30</timebase></rate><media><video><track>
        <clipitem id="n1"><name>M</name><start>0</start><end>300</end><in>0</in><out>300</out>${mc}</clipitem>
      </track></video></media></sequence>
    </clipitem>
    <clipitem id="p2"><name>M</name><start>30</start><end>60</end><in>300</in><out>330</out><sequence id="m"/></clipitem>
  </track></video></media></sequence></xmeml>`
  const seq = readFcp7(
    new DOMParser().parseFromString(xml, 'text/xml').documentElement as unknown as XmlElement
  )!

  it('親のクリップごとに別の印が付き、境目のカット点が残る。マルチカメラと数えるのは M だけ', () => {
    const marks = seq.video[0].map((c) => c.angleUnknown)
    expect(new Set(marks).size).toBe(2)
    expect(seq.nested).toEqual({ count: 3, multicam: 2 })
    const segs = seq.video[0].map((c) => ({
      start: c.start,
      end: c.end,
      cameraId: `?${c.angleUnknown}`
    }))
    expect(cutPoints(segs)).toEqual([1])
  })
})

describe('完成版のクリップの素材を、同じ名前のファイルと取り違えない', () => {
  it('カードが違って名前が同じ(C0001.MP4)なら、パスの後ろの段で見分ける。決められなければ外す', async () => {
    const { humanCoverage } = await import('../../src/shared/eval/compare')
    const info: MulticamInfo = {
      anchorSourceId: 'A',
      sources: [{ id: 'A', name: 'カメラA', kind: 'camera' }],
      files: [
        { assetId: 'c1', sourceId: 'A', start: 0, rate: 1, duration: 1300 },
        { assetId: 'c2', sourceId: 'A', start: 1300, rate: 1, duration: 1300 }
      ]
    }
    const a = (id: string, path: string): Project['assets'][number] => ({
      id,
      filePath: path,
      fileName: 'C0001.MP4',
      duration: 1300,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    })
    const project = {
      assets: [a('c1', '/x/CamA/Card1/C0001.MP4'), a('c2', '/x/CamA/Card2/C0001.MP4')]
    } as unknown as Project
    const clip = (path?: string): Record<string, unknown> => ({
      start: 0,
      end: 100,
      in: 100,
      out: 200,
      fileName: 'C0001.MP4',
      ...(path ? { path } : {})
    })
    const seq = (path?: string): never => ({ video: [[clip(path)]] }) as never
    // 編集した PC が違っても(D:\\ロケ\\…)、後ろの段(Card1/C0001.MP4)でそろう
    const r = humanCoverage(seq('D:\\\\ロケ\\\\CamA\\\\Card1\\\\C0001.MP4'), project, info)
    expect(r.segs.map((s) => [s.start, s.end])).toEqual([[100, 200]])
    const r2 = humanCoverage(seq('file://localhost/Volumes/R/CamA/Card2/C0001.MP4'), project, info)
    expect(r2.segs.map((s) => [s.start, s.end])).toEqual([[1400, 1500]])
    // パスが無い・名前しかそろわないなら、どちらか決められないので外す
    expect(humanCoverage(seq(), project, info).unmatched).toEqual(['C0001.MP4'])
  })
})

describe('Premiere の書き出しの細部', () => {
  const read = (body: string): ReturnType<typeof readFcp7> =>
    readFcp7(
      new DOMParser().parseFromString(
        `<?xml version="1.0" encoding="UTF-8"?><xmeml version="4"><sequence><name>s</name><duration>1800</duration>
        <rate><timebase>30</timebase></rate><media>${body}</media></sequence></xmeml>`,
        'text/xml'
      ).documentElement as unknown as XmlElement
    )
  const se = (id: string, start: number): string =>
    `<clipitem id="${id}"><name>se.wav</name><start>${start}</start><end>${start + 30}</end><in>0</in><out>30</out>
      <file id="file-se"><name>se.wav</name><rate><timebase>30</timebase></rate><duration>30</duration></file></clipitem>`

  it('ステレオを左右2本に分けたトラックは1本として読む(SE を2倍に数えない)', () => {
    const clips = [0, 300, 600].map((t, i) => se(`s${i}`, t)).join('')
    const seq = read(
      `<audio>
        <track currentExplodedTrackIndex="0" totalExplodedTrackCount="2" premiereTrackType="Stereo">${clips}</track>
        <track currentExplodedTrackIndex="1" totalExplodedTrackCount="2" premiereTrackType="Stereo">${clips}</track>
      </audio>`
    )!
    expect(seq.audio).toHaveLength(1)
    expect(seq.audio[0]).toHaveLength(3)
  })

  it('無効にした文字・無効にしたトラックの文字は読まない', () => {
    const title = (text: string, enabled = true): string =>
      `<generatoritem><name>t</name>${enabled ? '' : '<enabled>FALSE</enabled>'}<start>30</start><end>90</end>
        <effect><parameter><parameterid>str</parameterid><value>${text}</value></parameter></effect></generatoritem>`
    const seq = read(
      `<video>
        <track>${title('ボツ', false)}${title('使う')}</track>
        <track><enabled>FALSE</enabled>${title('隠したトラック')}</track>
      </video>`
    )!
    expect(seq.texts.map((t) => t.text)).toEqual(['使う'])
  })
})

describe('readFcp7: パスの % ', () => {
  it('生の % が混ざったパスも file:// を外して読み、正しい %XX は戻す', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4"><sequence id="s"><name>x</name><duration>30</duration>
<rate><timebase>30</timebase></rate><media><video><track>
<clipitem id="c1"><name>A.MP4</name><start>0</start><end>30</end><in>0</in><out>30</out>
<file id="f"><name>A.MP4</name><pathurl>file://localhost/D:/100%完成/%E3%83%AD%E3%82%B1/A.MP4</pathurl>
<rate><timebase>30</timebase></rate><duration>300</duration></file></clipitem>
</track></video></media></sequence></xmeml>`
    const r = new DOMParser().parseFromString(xml, 'text/xml')
      .documentElement as unknown as XmlElement
    expect(readFcp7(r)!.video[0][0].path).toBe('D:/100%完成/ロケ/A.MP4')
  })
})

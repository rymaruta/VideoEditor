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

import { describe, expect, it } from 'vitest'
import {
  foreignBetweenOf,
  lineAtTime,
  lineOf,
  rangeOfLines,
  reviewTranscriptLines,
  type TranscriptLine
} from '../../src/renderer/src/lib/reviewTranscript'
import type { PlacedClipRef, TranscriptUtterance } from '@shared/transcript'
import type { Project } from '@shared/types'
import { seeded } from '../helpers/boundary'

/**
 * 確認の画面の文字起こし: 今の本編に残っている言葉と、削った言葉(取り消し線)を分ける。
 * 言葉の時刻が素材を置いたクリップに入っていれば残っている
 */

const utt = (
  words: [string, number, number][],
  extra: Partial<TranscriptUtterance> = {}
): TranscriptUtterance => ({
  id: 'u',
  assetId: 'mic',
  speaker: 'セリア',
  sourceStart: words[0][1],
  sourceEnd: words[words.length - 1][2],
  text: words.map((w) => w[0]).join(''),
  words: words.map(([text, start, end]) => ({ text, start, end })),
  overlap: false,
  ...extra
})

const clip = (startTime: number, inPoint: number, outPoint: number, speed = 1): PlacedClipRef => ({
  assetId: 'mic',
  startTime,
  inPoint,
  outPoint,
  speed
})

describe('lineOf — 1つの発言を、残っている所と削った所に分ける', () => {
  it('言い直し(「あの、えっと、」)を削っていれば、その言葉だけ取り消し線', () => {
    const u = utt([
      ['ここが例の場所よ。', 1, 2.5],
      ['あの、えっと、', 2.7, 3.5],
      ['覚えてる?', 3.7, 5]
    ])
    // 2.6〜3.6 を削った本編(0〜2.6 と 3.6〜6 を詰めて並べる)
    const l = lineOf(u, [clip(0, 0, 2.6), clip(2.6, 3.6, 6)], (t) => t)
    expect(l.parts).toEqual([
      { text: 'ここが例の場所よ。', cut: false, kind: 'speech' },
      { text: 'あの、えっと、', cut: true, kind: 'speech' },
      { text: '覚えてる?', cut: false, kind: 'speech' }
    ])
    expect(l.start).toBeCloseTo(1)
    expect(l.end).toBeCloseTo(2.6 + (5 - 3.6), 2)
    expect(l.allCut).toBe(false)
  })

  it('言葉の間の長い無音を削っていれば「(無音 2.5 秒)」の印を入れる(短い間・残した間には入れない)', () => {
    const u = utt([
      ['忘れるわけないだろ。', 0, 1.5],
      ['あの日、', 4, 5],
      ['終わったんだ。', 5.4, 6]
    ])
    const l = lineOf(u, [clip(0, 0, 1.6), clip(1.6, 3.9, 7)], (t) => t)
    expect(l.parts.map((p) => p.text)).toEqual([
      '忘れるわけないだろ。',
      '(無音 2.5 秒)',
      'あの日、終わったんだ。'
    ])
    expect(l.parts[1]).toMatchObject({ cut: true, kind: 'pause' })
  })

  it('全部削った発言は allCut で、タイムラインの区間は無い', () => {
    const u = utt([['ねえ、ちょっと待って。', 10, 12]])
    const l = lineOf(u, [clip(0, 0, 5)], (t) => t)
    expect(l.allCut).toBe(true)
    expect(l.start).toBeNull()
    expect(l.parts).toEqual([{ text: 'ねえ、ちょっと待って。', cut: true, kind: 'speech' }])
  })

  it('速さを変えたクリップでは、タイムラインの秒は速さで割る', () => {
    const u = utt([['はい', 2, 4]])
    const l = lineOf(u, [clip(10, 0, 8, 2)], (t) => t)
    expect(l.start).toBeCloseTo(11)
    expect(l.end).toBeCloseTo(12, 2)
  })

  it('言葉の時刻が無い発言は、残っている長さの割合で文字を分ける(目安)', () => {
    const u: TranscriptUtterance = {
      id: 'u',
      assetId: 'mic',
      sourceStart: 0,
      sourceEnd: 4,
      text: 'あいうえおかきくけこ',
      words: [],
      overlap: false
    }
    // 前半 2 秒だけ残す
    const l = lineOf(u, [clip(0, 0, 2)], (t) => t)
    expect(l.parts).toEqual([
      { text: 'あいうえお', cut: false, kind: 'speech' },
      { text: 'かきくけこ', cut: true, kind: 'speech' }
    ])
  })

  it('不変条件: 乱数の言葉と本編でも、切れの文字をつなぐと元の発言(無音の印を除く)', () => {
    const rnd = seeded(7)
    for (let k = 0; k < 300; k++) {
      const words: [string, number, number][] = []
      let t = rnd() * 3
      const n = 1 + Math.floor(rnd() * 8)
      for (let i = 0; i < n; i++) {
        const len = 0.1 + rnd() * 1.5
        words.push([`語${i}`, t, t + len])
        t += len + rnd() * 2.5
      }
      const clips: PlacedClipRef[] = []
      let at = 0
      let src = 0
      while (src < t + 2) {
        const keep = 0.2 + rnd() * 3
        clips.push(clip(at, src, src + keep))
        at += keep
        src += keep + rnd() * 2
      }
      const l = lineOf(utt(words), clips, (x) => x)
      const text = l.parts
        .filter((p) => p.kind === 'speech')
        .map((p) => p.text)
        .join('')
      expect(text).toBe(words.map((w) => w[0]).join(''))
      if (l.start !== null && l.end !== null) expect(l.end).toBeGreaterThanOrEqual(l.start)
      expect(l.allCut).toBe(l.parts.every((p) => p.cut))
    }
  })
})

describe('reviewTranscriptLines / rangeOfLines / lineAtTime', () => {
  const project = {
    assets: [
      {
        id: 'mic',
        filePath: '/m/mic.wav',
        fileName: 'mic.wav',
        duration: 100,
        width: 0,
        height: 0,
        fps: 0,
        hasAudio: true,
        hasVideo: false
      }
    ],
    clips: [],
    audioTracks: [
      {
        id: 't',
        name: '声',
        muted: false,
        volume: 1,
        clips: [
          { id: 'a', assetId: 'mic', startTime: 0, inPoint: 0, outPoint: 10, volume: 1 },
          { id: 'b', assetId: 'mic', startTime: 10, inPoint: 20, outPoint: 30, volume: 1 }
        ]
      }
    ],
    videoOverlayTracks: [],
    transcript: [
      { ...utt([['二つ目', 21, 23]]), id: 'u2' },
      { ...utt([['一つ目', 2, 4]]), id: 'u1', speaker: 'トム' },
      { ...utt([['削った', 12, 14]]), id: 'u3' }
    ]
  } as unknown as Project

  it('収録の時刻の順に並べ、残っている所のタイムラインの区間を持つ', () => {
    const lines = reviewTranscriptLines(project)
    expect(lines.map((l) => l.id)).toEqual(['u1', 'u3', 'u2'])
    expect(lines[0]).toMatchObject({ start: 2, end: 4, speaker: 'トム' })
    expect(lines[1].allCut).toBe(true)
    expect(lines[2].start).toBeCloseTo(11)
  })

  it('選んだ行の範囲は、残っている所をつないだもの(削った行は入れない)。全部削った行だけなら null', () => {
    const lines = reviewTranscriptLines(project)
    expect(rangeOfLines(lines, [0, 1, 2])).toEqual({
      start: 2,
      end: 13,
      pieces: [
        { start: 2, end: 4 },
        { start: 11, end: 13 }
      ],
      contiguous: true
    })
    expect(rangeOfLines(lines, [1])).toBeNull()
    expect(rangeOfLines(lines, [])).toBeNull()
    expect(rangeOfLines(lines, [99])).toBeNull()
  })

  it('時刻の行: 含む行、無ければ前で一番近い行。前に無ければ -1', () => {
    const lines: TranscriptLine[] = reviewTranscriptLines(project)
    expect(lineAtTime(lines, 3)).toBe(0)
    expect(lineAtTime(lines, 8)).toBe(0)
    expect(lineAtTime(lines, 12)).toBe(2)
    expect(lineAtTime(lines, 0.5)).toBe(-1)
  })

  it('文字起こしが無ければ空', () => {
    expect(reviewTranscriptLines({ ...project, transcript: undefined })).toEqual([])
  })
})

describe('【監査 2026-10】並べ替えた本編で、選んだ範囲が選んだ文より広がらない', () => {
  const cam = {
    id: 'cam',
    filePath: '/m/cam.mp4',
    fileName: 'cam.mp4',
    duration: 100,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
    hasVideo: true
  }
  const make = (clips: [number, number][]): Project =>
    ({
      assets: [cam],
      clips: clips.map(([a, b], i) => ({
        id: `c${i}`,
        assetId: 'cam',
        inPoint: a,
        outPoint: b,
        speed: 1
      })),
      audioTracks: [],
      videoOverlayTracks: [],
      multicam: {
        anchorSourceId: 'A',
        sources: [{ id: 'A', name: 'A', kind: 'camera' }],
        files: [{ assetId: 'cam', sourceId: 'A', start: 0, rate: 1, duration: 100 }]
      },
      transcript: [
        { ...utt([['前の文', 2, 4]], { assetId: 'cam' }), id: 'u1' },
        { ...utt([['後の文', 6, 8]], { assetId: 'cam' }), id: 'u2' },
        { ...utt([['遠くの文', 22, 24]], { assetId: 'cam' }), id: 'u3' }
      ]
    }) as unknown as Project

  it('対照: 並べ替えていなければ、続いて並ぶ(外枠に当ててよい)', () => {
    const p = make([[0, 30]])
    const lines = reviewTranscriptLines(p)
    const r = rangeOfLines(lines, [0, 1], foreignBetweenOf(p))
    expect(r).toMatchObject({ start: 2, end: 8, contiguous: true })
  })

  it('間に別の所(収録の 50〜60 秒)を挟むと、続いていない。切れごとの区間を返す', () => {
    // 本編: 収録 0〜5 → 50〜60 → 5〜10(2 つの文の間に、関係ない 10 秒が挟まる)
    const p = make([
      [0, 5],
      [50, 60],
      [5, 10]
    ])
    const lines = reviewTranscriptLines(p)
    const r = rangeOfLines(lines, [0, 1], foreignBetweenOf(p))
    expect(r?.contiguous).toBe(false)
    expect(r?.pieces).toEqual([
      { start: 2, end: 4 },
      { start: 16, end: 18 }
    ])
    // 外枠(2〜18)は、挟まった 10 秒まで入ってしまう。外枠に当てる操作はしない
    expect(r).toMatchObject({ start: 2, end: 18 })
  })

  it('収録の後の文が、本編では前に来る(順番を入れ替えた)ときも続いていない', () => {
    const p = make([
      [20, 30],
      [0, 10]
    ])
    const lines = reviewTranscriptLines(p)
    const r = rangeOfLines(lines, [0, 2], foreignBetweenOf(p))
    expect(r?.contiguous).toBe(false)
    expect(r?.pieces).toEqual([
      { start: 12, end: 14 },
      { start: 2, end: 4 }
    ])
  })

  it('同じ所を削っただけ(言い直しを詰めた)なら続いている', () => {
    const p = make([
      [0, 5],
      [5.5, 10]
    ])
    const lines = reviewTranscriptLines(p)
    expect(rangeOfLines(lines, [0, 1], foreignBetweenOf(p))?.contiguous).toBe(true)
  })
})

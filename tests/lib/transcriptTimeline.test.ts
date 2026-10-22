import { describe, expect, it } from 'vitest'
import {
  mainHardCuts,
  placedUtterances,
  telopsFromTranscript
} from '../../src/renderer/src/lib/transcriptTimeline'
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { autoTelopKey, mergeManualTelops, type WithAutoSource } from '@shared/telop/manual'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project, TextOverlay } from '@shared/types'

const asset = (id: string): unknown => ({ id, filePath: `/x/${id}.mp4`, duration: 600 })
const clip = (assetId: string, inPoint: number, outPoint: number): unknown => ({
  id: `${assetId}-${inPoint}`,
  assetId,
  inPoint,
  outPoint,
  speed: 1
})

describe('mainHardCuts — 本編で時間の飛ぶ所', () => {
  it('同じ素材の続き・共通の時刻が続くカメラの切り替えは切れ目にしない', () => {
    const project = {
      assets: [asset('A'), asset('B')],
      clips: [clip('A', 0, 5), clip('A', 5, 8), clip('B', 3, 6), clip('A', 20, 25)],
      multicam: {
        anchorSourceId: 'a',
        sources: [],
        files: [
          { assetId: 'A', sourceId: 'a', start: 0, rate: 1, duration: 600 },
          // カメラB は共通の時刻で 5 秒遅れて録り始めた
          { assetId: 'B', sourceId: 'b', start: 5, rate: 1, duration: 600 }
        ]
      }
    } as unknown as Project
    // A 5〜8 → B 3〜6(共通の 8〜11、続いている)→ A 20〜25(飛ぶ)
    expect(mainHardCuts(project)).toEqual([11])
  })
})

describe('telopsFromTranscript — 時刻の整え', () => {
  it('切れ目の直後のテロップは切れ目から出し、短い間はつなぐ', () => {
    const project = {
      aspectRatio: '16:9',
      assets: [asset('A')],
      clips: [clip('A', 0, 10), clip('A', 30, 40)],
      audioTracks: [],
      videoOverlayTracks: [],
      transcript: [
        {
          id: 'u1',
          assetId: 'A',
          sourceStart: 1,
          sourceEnd: 4,
          text: 'こんにちは',
          words: [{ text: 'こんにちは', start: 1, end: 4 }],
          overlap: false
        },
        {
          id: 'u2',
          assetId: 'A',
          sourceStart: 4.2,
          sourceEnd: 9,
          text: 'どうもどうも',
          words: [{ text: 'どうもどうも', start: 4.2, end: 9 }],
          overlap: false
        },
        {
          id: 'u3',
          assetId: 'A',
          sourceStart: 30.1,
          sourceEnd: 33,
          text: 'はいはい',
          words: [{ text: 'はいはい', start: 30.1, end: 33 }],
          overlap: false
        }
      ]
    } as unknown as Project
    const out = telopsFromTranscript(project, [])
    expect(out.map((o) => [o.startTime, o.endTime])).toEqual([
      [1, 4.2],
      [4.2, 9],
      [10, 13]
    ])
  })
})

describe('telopsFromTranscript — 枚ごとの番号', () => {
  it('長い発言を何枚かに分けたら、枚ごとに別の番号(直した文字・消した枚が別の枚に付かない)', () => {
    const text =
      'ここが中華街の入り口で今日はここから歩いていきます。まずは名物の肉まんを食べてみましょう'
    const project = {
      aspectRatio: '16:9',
      assets: [asset('A')],
      clips: [clip('A', 0, 30)],
      audioTracks: [],
      videoOverlayTracks: [],
      transcript: [
        {
          id: 'u1',
          assetId: 'A',
          sourceStart: 1,
          sourceEnd: 12,
          text,
          words: [{ text, start: 1, end: 12 }],
          overlap: false
        }
      ]
    } as unknown as Project
    const out = telopsFromTranscript(project, [])
    expect(out.length).toBeGreaterThan(1)
    expect(out.map((o) => o.utteranceChunk)).toEqual(out.map((_, i) => i))
  })
})

describe('placedUtterances — 速くしたワイプの素材の発話', () => {
  it('ワイプの速さで割って、タイムラインの位置にする(顔カメラの音で拾った発話)', () => {
    const project = {
      assets: [asset('face')],
      clips: [],
      audioTracks: [],
      videoOverlayTracks: [
        {
          id: 'w',
          clips: [{ id: 'f1', assetId: 'face', startTime: 10, inPoint: 20, outPoint: 30, speed: 2 }]
        }
      ],
      transcript: [
        { id: 'u', assetId: 'face', sourceStart: 22, sourceEnd: 26, text: 'はい', words: [] }
      ]
    } as unknown as Project
    const [u] = placedUtterances(project)
    expect(u.start).toBeCloseTo(11, 9)
    expect(u.end).toBeCloseTo(13, 9)
  })
})

describe('telopsFromTranscript — 元の部分(仮編集と同じ)', () => {
  // 元の部分が無いと、人が消した枚の印が何枚目かだけ(`u:u1#1`)になり、その発話は以後ずっと
  // 10/09 版と同じ当て方になる(新しい企画でも範囲で当てられない)
  const ws = [
    '今日は',
    'みんなで',
    'ラーメンを',
    '食べに',
    '横浜まで',
    '来ました',
    'すごく',
    '並んで'
  ]
  const u = {
    id: 'u1',
    assetId: 'A',
    sourceStart: 20,
    sourceEnd: 24,
    text: ws.join(''),
    words: ws.map((text, i) => ({ text, start: 20 + i * 0.5, end: 20 + i * 0.5 + 0.5 })),
    overlap: false
  }
  const project = {
    aspectRatio: '16:9',
    assets: [asset('A')],
    clips: [clip('A', 0, 5), { ...(clip('A', 18, 30) as object), speed: 2 }],
    audioTracks: [],
    videoOverlayTracks: [],
    transcript: [u]
  } as unknown as Project
  type Auto = Omit<TextOverlay, 'id'> & WithAutoSource

  it('枚に元の部分(素材の時刻・文字の時刻・タイムラインへの写し)を付ける', () => {
    const out = telopsFromTranscript(project, [], [], { lineChars: 8, minSec: 1 }) as Auto[]
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const o of out) {
      const src = o.autoSource!
      expect(src, JSON.stringify(o)).toBeDefined()
      expect(src.text).toBe(o.text)
      expect(src.times).toHaveLength([...o.text.replace(/\s/g, '')].length)
      expect(src.start).toBeGreaterThanOrEqual(20 - 0.01)
      expect(src.end).toBeLessThanOrEqual(24 + 0.01)
      // タイムライン = offset + 素材 / rate(2倍速のクリップ: 5 + (素材 - 18) / 2)
      expect(src.rate).toBe(2)
      expect(src.offset! + src.start / 2).toBeCloseTo(5 + (src.start - 18) / 2, 6)
      expect(autoTelopKey(o)).toMatch(/^u:u1#\d+@/)
    }
  })

  it('人がこの枚を消しても、作り直しは範囲で当てる(消した言葉だけ出さず、枚は元の部分を持つ)', () => {
    const made = (telopsFromTranscript(project, [], [], { lineChars: 8, minSec: 1 }) as Auto[]).map(
      (o, i) => ({ ...o, id: `t${i}` })
    ) as TextOverlay[]
    const removed = made[1]
    const dismissed = new Set([autoTelopKey(removed)!])
    // 作り直し(1行の文字数が変わり、枚の分け方が変わる)
    const plan = utteranceToTelopChunks(u, { maxLineChars: 6 }).map((c, i) => ({
      text: c.text,
      startTime: c.sourceStart,
      endTime: c.sourceEnd,
      style: defaultTextStyle(),
      source: 'auto' as const,
      utteranceId: 'u1',
      utteranceChunk: i,
      autoSource: { start: c.sourceStart, end: c.sourceEnd, text: c.text, times: c.times }
    }))
    const merged = mergeManualTelops(
      made.filter((o) => o !== removed),
      plan,
      dismissed
    ) as Auto[]
    expect(merged.length).toBeGreaterThan(0)
    for (const o of merged) expect(o.autoSource, JSON.stringify(o)).toBeDefined()
    const shown = merged.map((o) => o.text.replace(/\s/g, '')).join('')
    expect(shown).not.toContain(removed.text.replace(/\s/g, ''))
  })
})

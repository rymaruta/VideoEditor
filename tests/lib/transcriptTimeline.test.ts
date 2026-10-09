import { describe, expect, it } from 'vitest'
import {
  mainHardCuts,
  placedUtterances,
  telopsFromTranscript
} from '../../src/renderer/src/lib/transcriptTimeline'
import type { Project } from '@shared/types'

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

import { describe, expect, it } from 'vitest'
import { speakerLines, speakerShots } from '@renderer/lib/verticalFraming'
import type { Project } from '@shared/types'

/** 監査の指摘 2: 相づちで切り替える・重なりのある長い答えが消える */
const keyOf = (s: string): number | null => (s === 'A' ? 0 : s === 'B' ? 1 : null)

describe('話す人の切り替え: 相づちでは切り替えない', () => {
  it('A が話し続ける途中の B の 0.5 秒の相づちで、B を映さない', () => {
    const shots = speakerShots(
      [
        { speaker: 'A', start: 0, end: 10 },
        { speaker: 'B', start: 3, end: 3.5 },
        { speaker: 'A', start: 10.5, end: 20 }
      ],
      0,
      20,
      keyOf
    )
    expect(shots.map((s) => s.key)).toEqual([0])
  })

  it('A が話している間に重なった B の発話(2 秒以上でも)では切り替えない。A が終わった後の B には切り替える', () => {
    const shots = speakerShots(
      [
        { speaker: 'A', start: 0, end: 10 },
        { speaker: 'B', start: 4, end: 7 },
        { speaker: 'B', start: 10.3, end: 18 }
      ],
      0,
      20,
      keyOf
    )
    expect(shots.map((s) => [s.start, s.key])).toEqual([
      [0, 0],
      [10.3, 1]
    ])
  })

  it('答える人の発話は、間 1 秒までの続きをつないで長さを見る', () => {
    const shots = speakerShots(
      [
        { speaker: 'A', start: 0, end: 5 },
        { speaker: 'B', start: 5.5, end: 6.5 },
        { speaker: 'B', start: 7, end: 8.2 },
        { speaker: 'A', start: 9, end: 15 }
      ],
      0,
      15,
      keyOf
    )
    expect(shots.map((s) => [s.start, s.key])).toEqual([
      [0, 0],
      [5.5, 1],
      [9, 0]
    ])
  })
})

describe('話者の区間に重なりの印がある長い答えも、切り替えに使う', () => {
  it('overlap の付いた発話も残す(印は持ったまま)', () => {
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '9:16',
      assets: [
        {
          id: 'A',
          filePath: '/a',
          fileName: 'a',
          duration: 60,
          width: 640,
          height: 360,
          fps: 30,
          hasAudio: true,
          hasVideo: true
        }
      ],
      clips: [{ id: 'c1', assetId: 'A', inPoint: 0, outPoint: 30, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: [],
      transcript: [
        {
          id: 'u1',
          assetId: 'A',
          speaker: '佐藤',
          sourceStart: 0,
          sourceEnd: 5,
          text: '質問',
          words: [],
          overlap: false
        },
        // 答えの途中に相づちが 0.3 秒重なり、区間全体に overlap が立った長い答え
        {
          id: 'u2',
          assetId: 'A',
          speaker: '山田',
          sourceStart: 5.5,
          sourceEnd: 25,
          text: '答え',
          words: [],
          overlap: true
        }
      ]
    } as unknown as Project
    const lines = speakerLines(project)
    expect(lines.map((l) => l.speaker)).toEqual(['佐藤', '山田'])
    expect(lines[1].overlap).toBe(true)
    const shots = speakerShots(lines, 0, 30, (s) => (s === '山田' ? 0 : 1))
    expect(shots.map((s) => [s.start, s.key])).toEqual([
      [0, 1],
      [5.5, 0]
    ])
  })
})

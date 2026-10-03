import { describe, expect, it } from 'vitest'
import {
  countEvents,
  eventScores,
  type AudioEventWindow
} from '../../src/shared/events/audioEvents'
import { heuristicJudgements, type Scene } from '../../src/shared/structure/scenes'

describe('eventScores', () => {
  it('AudioSet の笑い・歓声の分類名の確からしさを足す', () => {
    expect(
      eventScores([
        { label: 'Snicker', score: 0.22 },
        { label: 'Laughter', score: 0.17 },
        { label: 'Speech', score: 0.3 },
        { label: 'Applause', score: 0.1 },
        { label: 'Cheering', score: 0.05 }
      ])
    ).toEqual({ laugh: 0.39, cheer: expect.closeTo(0.15, 5) })
  })
})

describe('countEvents', () => {
  const w = (start: number, laugh: number, cheer = 0): AudioEventWindow => ({
    start,
    end: start + 10,
    laugh,
    cheer
  })
  it('続いて超えた窓は1回と数え、区間の中だけを数える', () => {
    const events = [w(0, 0.6), w(5, 0.7), w(10, 0.01), w(20, 0.5, 0.4), w(100, 0.9)]
    expect(countEvents(events, 0, 60)).toEqual({ laughs: 2, cheers: 1 })
    expect(countEvents(events, 90, 120)).toEqual({ laughs: 1, cheers: 0 })
  })
})

describe('heuristicJudgements(笑い)', () => {
  const scene = (id: string, laughs: number): Scene => ({
    id,
    start: 0,
    end: 60,
    speech: 15,
    laughs,
    lines: [
      { id: '1', start: 0, end: 5, text: 'こんにちは', speaker: 'A', overlap: false },
      { id: '2', start: 10, end: 15, text: 'どうも', speaker: 'B', overlap: false }
    ]
  })
  it('笑いの多い場面ほど点数が高く、2回以上で見どころ。理由に回数を書く', () => {
    const [plain, funny] = heuristicJudgements([scene('a', 0), scene('b', 2)])
    expect(funny.score).toBeGreaterThan(plain.score)
    expect(funny.kind).toBe('highlight')
    expect(funny.reason).toContain('笑い 2')
  })
})

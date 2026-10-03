import { describe, expect, it } from 'vitest'
import { chooseAngles, type AngleCamera } from '../../src/shared/angles/choose'

const cams: AngleCamera[] = [
  { id: 'WIDE', coverage: [{ start: 0, end: 200 }] },
  { id: 'CAMB', subject: 'B', coverage: [{ start: 0, end: 200 }] }
]

describe('chooseAngles', () => {
  it('話者が替わったら、その人を映すカメラへ(映す人が決まっていなければ全体)', () => {
    const shots = chooseAngles([{ start: 0, end: 30 }], cams, 'WIDE', [
      { speaker: 'A', start: 1, end: 5 },
      { speaker: 'B', start: 6, end: 12 },
      { speaker: 'A', start: 13, end: 20 }
    ])
    expect(shots.map((s) => [s.start, s.end, s.cameraId])).toEqual([
      [0, 6, 'WIDE'],
      [6, 13, 'CAMB'],
      [13, 30, 'WIDE']
    ])
  })

  it('2秒より短いショットは作らない', () => {
    const shots = chooseAngles([{ start: 0, end: 20 }], cams, 'WIDE', [
      { speaker: 'A', start: 0, end: 1 },
      { speaker: 'B', start: 1, end: 2 },
      { speaker: 'A', start: 2.5, end: 10 }
    ])
    expect(shots.every((s) => s.end - s.start >= 2 || s === shots.at(-1))).toBe(true)
  })

  it('カットのつなぎ目では必ず別のカメラに替える(画の跳びを隠す)', () => {
    const shots = chooseAngles(
      [
        { start: 0, end: 10 },
        { start: 40, end: 50 }
      ],
      cams,
      'WIDE',
      [
        { speaker: 'A', start: 1, end: 9 },
        { speaker: 'A', start: 41, end: 49 }
      ]
    )
    expect(shots.map((s) => [s.start, s.cameraId, s.reason])).toEqual([
      [0, 'WIDE', 'default'],
      [40, 'CAMB', 'jump']
    ])
  })

  it('長く同じカメラが続いたら、次の話し始めで替える', () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      speaker: 'A',
      start: i * 3,
      end: i * 3 + 2.5
    }))
    const shots = chooseAngles([{ start: 0, end: 30 }], cams, 'WIDE', lines, { maxShotSec: 8 })
    expect(shots.length).toBeGreaterThanOrEqual(3)
    expect(shots.slice(0, -1).every((s) => s.end - s.start <= 9.01)).toBe(true)
  })

  it('録っていない時間は、録っているカメラで埋める', () => {
    const shots = chooseAngles(
      [{ start: 0, end: 30 }],
      [
        {
          id: 'WIDE',
          coverage: [
            { start: 0, end: 10 },
            { start: 20, end: 30 }
          ]
        },
        { id: 'CAMB', subject: 'B', coverage: [{ start: 0, end: 30 }] }
      ],
      'WIDE',
      []
    )
    expect(shots.map((s) => [s.start, s.end, s.cameraId])).toEqual([
      [0, 10, 'WIDE'],
      [10, 20, 'CAMB'],
      [20, 30, 'WIDE']
    ])
  })
})

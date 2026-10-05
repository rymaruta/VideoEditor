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

  it('場面の頭は全体のカメラから入り、2秒たってから話者のカメラへ寄る', () => {
    const lines = [
      { speaker: 'B', start: 0.2, end: 5 },
      { speaker: 'B', start: 5.5, end: 9 },
      { speaker: 'B', start: 60.2, end: 64 },
      { speaker: 'B', start: 64.5, end: 69 }
    ]
    const shots = chooseAngles(
      [
        { start: 0, end: 10, sceneId: 's1' },
        { start: 60, end: 70, sceneId: 's3' }
      ],
      cams,
      'WIDE',
      lines
    )
    // 以前は場面の頭から話者のカメラ(CAMB)だった
    expect(shots.map((s) => [s.start, s.cameraId, s.reason])).toEqual([
      [0, 'WIDE', 'scene'],
      [5.5, 'CAMB', 'speaker'],
      [60, 'WIDE', 'scene'],
      [64.5, 'CAMB', 'speaker']
    ])
  })

  it('場面の頭でも、今が全体なら同じカメラのまま時間を飛ばさず話者のカメラへ', () => {
    const shots = chooseAngles(
      [
        { start: 0, end: 10, sceneId: 's1' },
        { start: 60, end: 70, sceneId: 's2' }
      ],
      cams,
      'WIDE',
      [
        { speaker: 'A', start: 0.2, end: 9 },
        { speaker: 'B', start: 60.2, end: 69 }
      ]
    )
    expect(shots.map((s) => [s.start, s.cameraId])).toEqual([
      [0, 'WIDE'],
      [60, 'CAMB']
    ])
  })

  it('同じ場面の中で間を詰めた切れ目は、今まで通り話者のカメラを選ぶ', () => {
    const shots = chooseAngles(
      [
        { start: 0, end: 10, sceneId: 's1' },
        { start: 12, end: 20, sceneId: 's1' }
      ],
      cams,
      'WIDE',
      [
        { speaker: 'A', start: 0.2, end: 9 },
        { speaker: 'B', start: 12.2, end: 19 }
      ]
    )
    expect(shots.map((s) => [s.start, s.cameraId, s.reason])).toEqual([
      [0, 'WIDE', 'scene'],
      [12, 'CAMB', 'jump']
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

describe('chooseAngles: 分割ファイルのつなぎ目', () => {
  it('つなぎ目のごく短い隙間で、別のカメラへ一瞬切り替えない', () => {
    const chapters: AngleCamera[] = [
      {
        id: 'WIDE',
        coverage: [
          { start: 0, end: 1000 },
          { start: 1000.02, end: 2000 }
        ]
      },
      { id: 'CAMB', subject: 'B', coverage: [{ start: 0, end: 2000 }] }
    ]
    const shots = chooseAngles([{ start: 990, end: 1010 }], chapters, 'WIDE', [
      { speaker: 'A', start: 990, end: 1010 }
    ])
    expect(shots.map((s) => [s.start, s.end, s.cameraId])).toEqual([[990, 1010, 'WIDE']])
  })

  it('録っていない時間に掛かって分けたショットでも、1フレーム未満の断片は残さない', () => {
    const cams2: AngleCamera[] = [
      { id: 'WIDE', coverage: [{ start: 0, end: 109.99 }] },
      { id: 'CAMB', subject: 'B', coverage: [{ start: 0, end: 200 }] }
    ]
    const shots = chooseAngles([{ start: 90, end: 110 }], cams2, 'WIDE', [
      { speaker: 'A', start: 90, end: 110 }
    ])
    // WIDE は区間の終わりの 0.01 秒前で止まる。そこだけ CAMB へ替える 0.01 秒のショットを作らない
    expect(shots.map((s) => [s.start, s.end, s.cameraId])).toEqual([[90, 110, 'WIDE']])
  })
})

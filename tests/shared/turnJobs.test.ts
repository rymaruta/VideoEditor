import { describe, expect, it } from 'vitest'
import { turnsToJobs } from '../../src/shared/diarize/turnJobs'

describe('turnsToJobs', () => {
  const files = [
    { id: 'm1a', path: '/m1a.wav', sourceId: 'M1', duration: 100 },
    { id: 'm1b', path: '/m1b.wav', sourceId: 'M1', duration: 100 },
    { id: 'm2', path: '/m2.wav', sourceId: 'M2', duration: 300 }
  ]
  const placements = [
    { id: 'm1a', start: 0, method: 'audio' as const, rate: 1 },
    { id: 'm1b', start: 100, method: 'audio' as const, rate: 1 },
    // M2 は 3 秒後に始まり、時計が 0.01% 速い
    { id: 'm2', start: 3, method: 'audio' as const, rate: 1.0001 }
  ]

  it('発話の頭を録っている素材と、その素材の時刻にする', () => {
    const jobs = turnsToJobs(
      [
        { micId: 'M1', start: 120, end: 124, overlap: false },
        { micId: 'M2', start: 53, end: 55, overlap: true }
      ],
      files,
      placements
    )
    expect(jobs[0].job).toEqual({ id: 'turn-0', path: '/m1b.wav', start: 20, end: 24 })
    expect(jobs[1].job.path).toBe('/m2.wav')
    expect(jobs[1].job.start).toBeCloseTo(50 * 1.0001, 9)
    expect(jobs[1].turn.overlap).toBe(true)
  })

  it('素材の切れ目をまたぐ発話は、その素材の終わりまでにする', () => {
    const [j] = turnsToJobs(
      [{ micId: 'M1', start: 98, end: 102, overlap: false }],
      files,
      placements
    )
    expect(j.job).toEqual({ id: 'turn-0', path: '/m1a.wav', start: 98, end: 100 })
  })
})

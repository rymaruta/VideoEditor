import { describe, expect, it } from 'vitest'
import {
  loudnormApplyFilter,
  loudnormMeasureFilter,
  normalizeLoudnessTarget,
  planLimitedGain
} from '../../src/shared/loudness'

const measured = {
  inputI: -20.5,
  inputTP: -3.2,
  inputLRA: 18.4,
  inputThresh: -31,
  targetOffset: 0.4
}

describe('loudness', () => {
  it('配信は -14 LUFS(これまでの書き出しと同じ指定)', () => {
    expect(loudnormMeasureFilter('web')).toBe('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json')
    expect(loudnormApplyFilter('web', null)).toBe('loudnorm=I=-14:TP=-1.5:LRA=11')
  })

  it('放送は -24 LKFS', () => {
    expect(loudnormMeasureFilter('broadcast')).toContain('I=-24:TP=-2')
    expect(loudnormApplyFilter('broadcast', measured)).toMatch(/^loudnorm=I=-24:TP=-2:/)
  })

  it('測れていれば linear で、LRA は測った値を下回らない', () => {
    const f = loudnormApplyFilter('web', measured)
    expect(f).toContain('LRA=19:')
    expect(f).toContain('measured_I=-20.5')
    expect(f).toContain('linear=true')
    expect(loudnormApplyFilter('web', { ...measured, inputLRA: 4 })).toContain('LRA=11:')
    expect(loudnormApplyFilter('web', { ...measured, inputLRA: 80 })).toContain('LRA=50:')
  })

  it('知らない値は配信に落とす', () => {
    expect(normalizeLoudnessTarget('broadcast')).toBe('broadcast')
    expect(normalizeLoudnessTarget('x')).toBe('web')
    expect(normalizeLoudnessTarget(undefined)).toBe('web')
  })
})

describe('planLimitedGain', () => {
  it('抑えた高さどおりにピークが収まる素材は、1回の測りで決める(音を丸ごと測り直さない)', async () => {
    const peaky = { ...measured, inputI: -24, inputTP: -2 }
    let calls = 0
    const filter = await planLimitedGain('web', peaky, async (f) => {
      calls++
      const gain = Number(/volume=(-?[\d.]+)dB/.exec(f)![1])
      const limit = Number(/limit=([\d.]+)/.exec(f)![1])
      // 4 倍の細かさで抑えると、測ったトゥルーピークは抑えた高さとほぼ同じ
      return { ...peaky, inputI: peaky.inputI + gain, inputTP: 20 * Math.log10(limit) + 0.02 }
    })
    expect(filter).toContain('alimiter')
    expect(calls).toBe(1)
  })
})

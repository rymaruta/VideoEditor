import { describe, expect, it } from 'vitest'
import { beatPeriod, onsetFeature, suppressBeat } from '../../../src/shared/sync/correlate'
import { seeded } from '../../helpers/boundary'

/**
 * 一定間隔の立ち上がり(BGM の拍)の周期を見つけ、特徴から消す(syncWorker が、拍に本当の位置が埋もれた組を
 * 照らし合わせ直すのに使う)。拍は消え、一度きりの立ち上がり(話し声・物音)は残ること
 */

/** 包絡線: 静かな床の上に、周期 period 秒の拍(beatAmp)と、events の時刻の一度きりの音 */
function envelope(
  seconds: number,
  period: number,
  beatAmp: number,
  events: number[]
): Float32Array {
  const n = seconds * 100
  const rnd = seeded(7)
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) env[i] = 0.001 * (1 + 0.2 * rnd())
  const pulse = (t: number, amp: number): void => {
    const i0 = Math.round(t * 100)
    for (let k = 0; k < 15 && i0 + k < n; k++) env[i0 + k] += amp * Math.exp(-k / 5)
  }
  if (beatAmp > 0) for (let t = 0.1; t < seconds; t += period) pulse(t, beatAmp)
  for (const t of events) pulse(t, 0.2)
  return env
}

describe('一定間隔の立ち上がり(拍)を見つけて消す', () => {
  const rnd = seeded(3)
  const events: number[] = []
  for (let t = 2; t < 290; t += 1 + rnd() * 3) events.push(t)

  it('拍の周期を、拍の整数倍でなく、10ms 単位でない周期(128 BPM)も細かく求める', () => {
    expect(beatPeriod(onsetFeature(envelope(300, 0.5, 0.05, events)))).toBe(50)
    const p = beatPeriod(onsetFeature(envelope(300, 0.46875, 0.05, events)))
    expect(p).not.toBeNull()
    expect(Math.abs(p! - 46.875)).toBeLessThanOrEqual(0.25)
  })

  it('拍の無い素材(話し声・物音だけ)では周期を返さない', () => {
    expect(beatPeriod(onsetFeature(envelope(300, 0.5, 0, events)))).toBeNull()
  })

  it('拍は消え、一度きりの立ち上がりは残る', () => {
    const x = onsetFeature(envelope(300, 0.5, 0.05, events))
    const y = suppressBeat(x, beatPeriod(x)!)
    // 拍だけの位置(一度きりの音から 1 秒以上離れた拍)と、一度きりの音の位置での値
    const beats: number[] = []
    for (let t = 0.1; t < 298; t += 0.5)
      if (events.every((e) => Math.abs(e - t) > 1)) beats.push(Math.round(t * 100))
    const at = (v: Float32Array, idx: number[]): number =>
      idx.reduce((s, i) => s + Math.max(v[i], v[i + 1]), 0) / idx.length
    const ev = events.map((t) => Math.round(t * 100))
    // 消す前は拍も一度きりの音と同じくらい目立つ
    expect(at(x, beats)).toBeGreaterThan(0.3 * at(x, ev))
    // 消した後は、拍は一度きりの音の 1 割未満
    expect(at(y, beats)).toBeLessThan(0.1 * at(y, ev))
  })
})

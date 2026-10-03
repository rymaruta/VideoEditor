import { describe, expect, it } from 'vitest'
import { detectTurns, placeEnvelope, TURN_RATE } from '../../src/shared/diarize/micTurns'

/** 区間ごとの大きさ(dB)を与えて 100Hz の包絡線を作る。指定の無い所は floorDb */
function env(seconds: number, floorDb: number, parts: [number, number, number][]): Float32Array {
  const out = new Float32Array(seconds * TURN_RATE)
  for (let i = 0; i < out.length; i++) {
    // 話し声らしく、細かく揺らす
    let db = floorDb + (Math.sin(i * 1.7) + 1) * 1.5
    for (const [a, b, level] of parts)
      if (i >= a * TURN_RATE && i < b * TURN_RATE) db = level + Math.sin(i * 0.9) * 3
    out[i] = 10 ** (db / 20)
  }
  return out
}

describe('detectTurns', () => {
  // A は 1〜4秒・10〜12秒、B は 6〜9秒・10.5〜12秒(重なり)。かぶりは 20dB 小さい
  const a = env(15, -60, [
    [1, 4, -20],
    [6, 9, -40],
    [10, 12, -20]
  ])
  const b = env(15, -55, [
    [1, 4, -38],
    [6, 9, -18],
    [10.5, 12, -19]
  ])
  const turns = detectTurns([
    { id: 'A', envelope: a },
    { id: 'B', envelope: b }
  ])

  it('一番大きく鳴っているマイクの持ち主を話者にする(かぶりは数えない)', () => {
    const aTurns = turns.filter((t) => t.micId === 'A')
    const bTurns = turns.filter((t) => t.micId === 'B')
    expect(aTurns[0].start).toBeCloseTo(0.85, 1)
    expect(aTurns[0].end).toBeCloseTo(4.15, 1)
    expect(bTurns[0].start).toBeCloseTo(5.85, 1)
    expect(bTurns[0].end).toBeCloseTo(9.15, 1)
    // A の 6〜9 秒(B のかぶり)、B の 1〜4 秒(A のかぶり)は発話にしない
    expect(aTurns.some((t) => t.start > 5 && t.end < 10)).toBe(false)
    expect(bTurns.some((t) => t.end < 5)).toBe(false)
  })

  it('2人が近い大きさで話している所は、両方を重なりとして残す', () => {
    const last = turns.filter((t) => t.start > 9.5)
    expect(last.map((t) => t.micId).sort()).toEqual(['A', 'B'])
    expect(last.every((t) => t.overlap)).toBe(true)
    expect(turns.filter((t) => t.start < 9.5).every((t) => !t.overlap)).toBe(true)
  })

  it('長い発話は上限より短く切る', () => {
    const long = env(70, -60, [[2, 65, -20]])
    const t = detectTurns([{ id: 'A', envelope: long }], { maxTurnSec: 25 })
    expect(t.length).toBeGreaterThanOrEqual(3)
    expect(t.every((x) => x.end - x.start <= 25.5)).toBe(true)
  })
})

describe('placeEnvelope', () => {
  it('共通の時間軸の位置と時計の進みに合わせて並べ直す', () => {
    const src = Float32Array.from({ length: 1000 }, (_, i) => i)
    const out = placeEnvelope(src, 2, 1, 1500)
    expect(Number.isNaN(out[100])).toBe(true)
    expect(out[200]).toBe(0)
    expect(out[700]).toBe(500)
    expect(Number.isNaN(out[1300])).toBe(true)
    // 時計が 1% 速い素材は、共通の時間軸の 5 秒目が素材の 5.05 秒目
    expect(placeEnvelope(src, 0, 1.01, 1000)[500]).toBe(505)
  })
})

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

describe('detectTurns: 途中で止まったマイク', () => {
  // A は 1〜4秒・21〜24秒・30〜34秒・45〜49秒に本人の声(-10dB)、B は 25 秒で止まる。B の持ち主が 36〜42 秒に話し、
  // A には 20dB 小さく(-30dB)入る
  const a = env(50, -60, [
    [1, 4, -10],
    [10, 14, -30],
    [21, 24, -10],
    [30, 34, -10],
    [36, 42, -30],
    [45, 49, -10]
  ])
  const b = env(50, -55, [
    [10, 14, -12],
    [16, 20, -12]
  ])
  for (let i = 25 * TURN_RATE; i < b.length; i++) b[i] = NaN
  const turns = detectTurns([
    { id: 'A', envelope: a },
    { id: 'B', envelope: b }
  ])

  it('止まったマイクの持ち主の声(残ったマイクへの回り込み)を、残ったマイクの持ち主の発言と決めない', () => {
    const late = turns.filter((t) => t.micId === 'A' && t.start > 35 && t.end < 44)
    expect(late.length).toBeGreaterThan(0)
    expect(late.every((t) => t.uncertain)).toBe(true)
  })

  it('残ったマイクの持ち主本人の声は、これまでどおり持ち主の発言', () => {
    const own = turns.filter(
      (t) => t.micId === 'A' && (t.start > 29 || t.start < 5) && !(t.start > 35 && t.end < 44)
    )
    expect(own).toHaveLength(3)
    expect(own.every((t) => !t.uncertain)).toBe(true)
  })
})

describe('detectTurns: 伏せた全部入りの残り', () => {
  // 友達のマイク: 普段の声 -10dB、30〜33 秒は小さい声(-26dB)。全部入りの残り(配信者)は、
  // 友達が話している所を伏せてある(NaN)
  const friend = env(60, -60, [
    [1, 5, -10],
    [10, 15, -10],
    [20, 24, -10],
    [30, 33, -26],
    [40, 45, -10]
  ])
  const residual = env(60, -60, [
    [6, 9, -12],
    [50, 55, -12]
  ])
  const maskedFrames = new Uint8Array(residual.length)
  for (const [a, b] of [
    [0.8, 5.2],
    [9.8, 15.2],
    [19.8, 24.2],
    [29.8, 33.2],
    [39.8, 45.2]
  ]) {
    residual.fill(NaN, a * TURN_RATE, b * TURN_RATE)
    maskedFrames.fill(1, a * TURN_RATE, b * TURN_RATE)
  }

  it('伏せた所を「止まったマイク」とみなさず、友達の小さい声も友達の発言にする', () => {
    const turns = detectTurns([
      { id: 'friend', envelope: friend },
      { id: 'mix', envelope: residual, maskedFrames }
    ])
    const soft = turns.filter((t) => t.micId === 'friend' && t.start > 29 && t.end < 34)
    expect(soft).toHaveLength(1)
    expect(soft[0].uncertain).toBeUndefined()
  })
})

describe('detectTurns: 伏せた時刻と、録っていない時刻', () => {
  it('伏せた時刻のある残りでも、録っていない時刻はこれまでどおり止まったマイクとみなす', () => {
    const a = env(50, -60, [
      [1, 4, -10],
      [21, 24, -10],
      [30, 34, -10],
      [36, 42, -30],
      [45, 49, -10]
    ])
    const b = env(50, -55, [[16, 20, -12]])
    for (let i = 25 * TURN_RATE; i < b.length; i++) b[i] = NaN
    // 伏せた時刻は別(1〜4 秒)。25 秒からは録っていない
    const maskedFrames = new Uint8Array(b.length)
    maskedFrames.fill(1, 1 * TURN_RATE, 4 * TURN_RATE)
    const turns = detectTurns([
      { id: 'A', envelope: a },
      { id: 'B', envelope: b, maskedFrames }
    ])
    const late = turns.filter((t) => t.micId === 'A' && t.start > 35 && t.end < 44)
    expect(late.length).toBeGreaterThan(0)
    expect(late.every((t) => t.uncertain)).toBe(true)
  })
})

describe('detectTurns: ふつうの会話のあとで止まったマイク', () => {
  it('かぶりの多い会話でも、止まったマイクの人の声を残ったマイクの人の発言と決めない', () => {
    const a = env(50, -60, [
      [1, 4, -10],
      [10, 14, -30],
      [16, 20, -30],
      [21, 24, -10],
      [30, 34, -10],
      [36, 42, -30],
      [45, 49, -10]
    ])
    const b = env(50, -55, [
      [10, 14, -12],
      [16, 20, -12]
    ])
    for (let i = 25 * TURN_RATE; i < b.length; i++) b[i] = NaN
    const turns = detectTurns([
      { id: 'A', envelope: a },
      { id: 'B', envelope: b }
    ])
    const late = turns.filter((t) => t.micId === 'A' && t.start > 35 && t.end < 44)
    expect(late.length).toBeGreaterThan(0)
    expect(late.every((t) => t.uncertain)).toBe(true)
  })
})

describe('detectTurns: 回り込みと持ち主の声がつながった発話・重なり', () => {
  it('止まったマイクの人の声のすぐ後に持ち主が話しても、持ち主の発言は持ち主の発言のまま', () => {
    const a = env(60, -60, [
      [1, 4, -10],
      [10, 14, -30],
      [21, 24, -10],
      [30, 34, -10],
      // 回り込み(36〜40 秒)のすぐ後(0.2 秒の切れ目)に、持ち主が話す
      [36, 40, -30],
      [40.2, 44, -10],
      [50, 54, -10]
    ])
    const b = env(60, -55, [[10, 14, -12]])
    for (let i = 25 * TURN_RATE; i < b.length; i++) b[i] = NaN
    const turns = detectTurns([
      { id: 'A', envelope: a },
      { id: 'B', envelope: b }
    ])
    const own = turns.filter((t) => t.micId === 'A' && t.end > 41 && t.start < 44)
    expect(own.length).toBeGreaterThan(0)
    expect(own.some((t) => !t.uncertain && t.end > 43)).toBe(true)
    const bleed = turns.filter((t) => t.micId === 'A' && t.start < 37 && t.end > 37)
    expect(bleed.every((t) => t.uncertain)).toBe(true)
  })

  it('短い掛け合いの重なりを見落とさない(普段の声の大きさに、かぶりの少ない人の声も使う)', () => {
    // 2人とも本人の声 -10dB・かぶり -30dB。10〜10.5 秒だけ両者が同時に話す
    const a = env(30, -60, [
      [1, 6, -10],
      [10, 10.5, -10],
      [12, 17, -30],
      [20, 25, -10]
    ])
    const b = env(30, -60, [
      [1, 6, -30],
      [7, 10.5, -10],
      [12, 17, -10],
      [20, 25, -30]
    ])
    const turns = detectTurns([
      { id: 'A', envelope: a },
      { id: 'B', envelope: b }
    ])
    expect(turns.some((t) => t.overlap)).toBe(true)
  })
})

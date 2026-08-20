import { describe, expect, it } from 'vitest'
import { fadeGainAt, normalizeFades } from '@shared/audioFade'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

describe('normalizeFades — 尺に収まるフェード秒数', () => {
  it('合計が尺に収まるならそのまま', () => {
    expect(normalizeFades(1, 2, 10)).toEqual({ fadeIn: 1, fadeOut: 2 })
  })

  it('合計が尺を超えたら**比を保ったまま**縮める', () => {
    // 1:3 を尺2秒へ → 0.5:1.5(比 1:3 のまま)。
    // 片方ずつ頭打ちにすると 1:1 になってしまう(過去の実バグ)。
    expect(normalizeFades(1, 3, 2)).toEqual({ fadeIn: 0.5, fadeOut: 1.5 })
    const n = normalizeFades(1, 3, 2)
    expect(round(n.fadeOut / n.fadeIn)).toBe(3)
  })

  it('合計が尺ちょうどなら縮めない', () => {
    expect(normalizeFades(2, 3, 5)).toEqual({ fadeIn: 2, fadeOut: 3 })
  })

  it('片方だけでも尺を超えたら尺いっぱいまで', () => {
    expect(normalizeFades(10, 0, 4)).toEqual({ fadeIn: 4, fadeOut: 0 })
    expect(normalizeFades(0, 10, 4)).toEqual({ fadeIn: 0, fadeOut: 4 })
  })

  it('未設定・0・負は 0 として扱う', () => {
    expect(normalizeFades(undefined, undefined, 10)).toEqual({ fadeIn: 0, fadeOut: 0 })
    expect(normalizeFades(0, 0, 10)).toEqual({ fadeIn: 0, fadeOut: 0 })
    expect(normalizeFades(-1, -2, 10)).toEqual({ fadeIn: 0, fadeOut: 0 })
  })

  it('NaN・Infinity は 0 として扱う(ffmpeg に定義域外を渡さない)', () => {
    expect(normalizeFades(NaN, 1, 10)).toEqual({ fadeIn: 0, fadeOut: 1 })
    expect(normalizeFades(1, NaN, 10)).toEqual({ fadeIn: 1, fadeOut: 0 })
    // Infinity は sanitize を通るが、合計が尺を超えるので按分で潰れる
    const inf = normalizeFades(Infinity, 0, 10)
    expect(Number.isFinite(inf.fadeIn)).toBe(true)
    expect(Number.isFinite(inf.fadeOut)).toBe(true)
  })

  it('尺が 0・負・NaN・Infinity でも壊れない', () => {
    expect(normalizeFades(1, 1, 0)).toEqual({ fadeIn: 0, fadeOut: 0 })
    expect(normalizeFades(1, 1, -5)).toEqual({ fadeIn: 0, fadeOut: 0 })
    expect(normalizeFades(1, 1, NaN)).toEqual({ fadeIn: 0, fadeOut: 0 })
    // 尺が Infinity は「有限で正」ではないので 0 扱い＝フェード無し。
    // ffmpeg へ Infinity 秒の afade を渡さないための門で、意図どおり。
    expect(normalizeFades(1, 1, Infinity)).toEqual({ fadeIn: 0, fadeOut: 0 })
  })

  it('【不変条件】どんな入力でも 0 以上・合計が尺以下・有限', () => {
    for (const a of NASTY_NUMBERS) {
      for (const b of NASTY_NUMBERS) {
        for (const dur of [0, 0.1, 1, 10, 1e6, -1, NaN, Infinity]) {
          const n = normalizeFades(a, b, dur)
          expect(Number.isFinite(n.fadeIn), `in=${a} out=${b} dur=${dur}`).toBe(true)
          expect(Number.isFinite(n.fadeOut), `in=${a} out=${b} dur=${dur}`).toBe(true)
          expect(n.fadeIn).toBeGreaterThanOrEqual(0)
          expect(n.fadeOut).toBeGreaterThanOrEqual(0)
          if (Number.isFinite(dur) && dur > 0) {
            expect(n.fadeIn + n.fadeOut).toBeLessThanOrEqual(dur + 1e-9)
          }
        }
      }
    }
  })
})

describe('fadeGainAt — クリップ内の経過秒に対する倍率', () => {
  it('フェードが無ければ常に等倍', () => {
    for (const t of [0, 1, 5, 9.999, 10]) expect(fadeGainAt(t, 10, 0, 0)).toBe(1)
  })

  it('フェードインは 0 から 1 へ直線(ffmpeg の既定カーブ tri と同じ)', () => {
    expect(fadeGainAt(0, 10, 2, 0)).toBe(0)
    expect(fadeGainAt(0.5, 10, 2, 0)).toBe(0.25)
    expect(fadeGainAt(1, 10, 2, 0)).toBe(0.5)
    expect(fadeGainAt(1.5, 10, 2, 0)).toBe(0.75)
    expect(fadeGainAt(2, 10, 2, 0)).toBe(1)
    expect(fadeGainAt(3, 10, 2, 0)).toBe(1)
  })

  it('フェードアウトは 1 から 0 へ直線', () => {
    expect(fadeGainAt(7, 10, 0, 3)).toBe(1)
    expect(round(fadeGainAt(8.5, 10, 0, 3))).toBe(0.5)
    expect(fadeGainAt(10, 10, 0, 3)).toBe(0)
  })

  it('区間の外を渡されても 0〜1 に収まる', () => {
    expect(fadeGainAt(-5, 10, 2, 2)).toBe(0)
    expect(fadeGainAt(15, 10, 2, 2)).toBe(0)
  })

  it('経過が NaN なら等倍(音を消さない)', () => {
    expect(fadeGainAt(NaN, 10, 2, 2)).toBe(1)
  })

  it('【不変条件】戻り値は必ず 0〜1 の有限値', () => {
    const rnd = seeded(4242)
    for (let i = 0; i < 20000; i++) {
      const dur = [0, 0.1, 1, 10][Math.floor(rnd() * 4)]
      const g = fadeGainAt(
        (rnd() - 0.2) * 12,
        dur,
        NASTY_NUMBERS[Math.floor(rnd() * NASTY_NUMBERS.length)],
        NASTY_NUMBERS[Math.floor(rnd() * NASTY_NUMBERS.length)]
      )
      expect(Number.isFinite(g)).toBe(true)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
    }
  })
})

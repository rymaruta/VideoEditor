import { describe, expect, it } from 'vitest'
import {
  MIN_TRANSITION_SECONDS,
  TRANSITION_SAFETY_MARGIN,
  crossfadeOpacity,
  effectiveTransitionSeconds,
  transitionSecondsForClip
} from '@shared/transition'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

const T = (duration: number): { type: 'crossfade'; duration: number } => ({
  type: 'crossfade',
  duration
})

describe('effectiveTransitionSeconds — 実際に掛かるつなぎの秒数', () => {
  it('つなぎが無ければ全部 0', () => {
    expect(effectiveTransitionSeconds([5, 5, 5], [null, null, null])).toEqual([0, 0, 0])
  })

  it('先頭のクリップにはつなぎが掛からない', () => {
    expect(effectiveTransitionSeconds([5, 5], [T(1), null])[0]).toBe(0)
  })

  it('両隣に収まるならそのまま', () => {
    expect(effectiveTransitionSeconds([5, 5], [null, T(1)])).toEqual([0, 1])
  })

  it('隣より長いつなぎは詰められる(黙って落とさない)', () => {
    const [, eff] = effectiveTransitionSeconds([0.5, 5], [null, T(2)])
    expect(eff).toBeLessThan(2)
    expect(eff).toBeLessThanOrEqual(0.5 - TRANSITION_SAFETY_MARGIN + 1e-9)
  })

  it('隣が短すぎるときは 0(＝ハードカットへ落ちる)', () => {
    const [, eff] = effectiveTransitionSeconds([0.01, 5], [null, T(1)])
    expect(eff).toBe(0)
  })

  it('上限は「ここまでの累積」と「これから足す1本」の短いほう', () => {
    // 5秒3本に 1.5秒ずつ。累積は繋ぎのぶんしか縮まない(5 → 8.5 → 12)ので、
    // どちらの上限も 5 - 0.05 = 4.95。1.5 はどちらにも収まるので**詰められない**。
    expect(effectiveTransitionSeconds([5, 5, 5], [null, T(1.5), T(1.5)])).toEqual([0, 1.5, 1.5])
    // 詰められるのは「これから足す1本」が短いとき。
    const eff = effectiveTransitionSeconds([5, 5, 1], [null, T(1.5), T(1.5)])
    expect(eff[1]).toBe(1.5)
    expect(round(eff[2])).toBe(round(1 - TRANSITION_SAFETY_MARGIN))
  })

  it('【不変条件】どの要素も 0 以上・有限・隣の尺未満', () => {
    const rnd = seeded(31337)
    for (let round_ = 0; round_ < 3000; round_++) {
      const n = 1 + Math.floor(rnd() * 6)
      const durations = Array.from({ length: n }, () => rnd() * 8)
      const transitions = Array.from({ length: n }, (_, i) =>
        i === 0 || rnd() < 0.3 ? null : T(rnd() * 4)
      )
      const eff = effectiveTransitionSeconds(durations, transitions)
      expect(eff).toHaveLength(n)
      eff.forEach((v, i) => {
        expect(Number.isFinite(v), `i=${i}`).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        if (v > 0) {
          expect(v).toBeGreaterThanOrEqual(MIN_TRANSITION_SECONDS)
          // 上限は「これから足す1本」と「ここまでの累積」の短いほうから余裕を引いた値。
          // 直前の1本ではない——累積は繋ぎのぶんしか縮まないため。
          expect(v).toBeLessThanOrEqual(durations[i] - TRANSITION_SAFETY_MARGIN + 1e-9)
        }
      })
    }
  })

  it('異常な尺・異常なつなぎ秒でも落ちず、有限を返す', () => {
    for (const d of NASTY_NUMBERS) {
      for (const t of NASTY_NUMBERS) {
        const eff = effectiveTransitionSeconds([d, d], [null, T(t)])
        expect(eff).toHaveLength(2)
        eff.forEach((v) => {
          expect(Number.isFinite(v), `dur=${d} t=${t} -> ${v}`).toBe(true)
          expect(v).toBeGreaterThanOrEqual(0)
        })
      }
    }
  })

  it('空の入力', () => {
    expect(effectiveTransitionSeconds([], [])).toEqual([])
  })
})

describe('transitionSecondsForClip — 指定した秒と実際に効く秒', () => {
  const clips = [
    { id: 'a', inPoint: 0, outPoint: 5, speed: 1 },
    { id: 'b', inPoint: 0, outPoint: 5, speed: 1, transitionIn: T(1.5) },
    // 1秒しかないクリップ ——1.5秒のつなぎは入らないので詰められる
    { id: 'c', inPoint: 0, outPoint: 1, speed: 1, transitionIn: T(1.5) }
  ]

  it('先頭のクリップは「指定はあるが効かない」を返す', () => {
    const first = transitionSecondsForClip([{ ...clips[0], transitionIn: T(1) }, clips[1]], 'a')
    expect(first).toEqual({ specified: 1, effective: 0 })
  })

  it('収まっているクリップは指定と実効が一致', () => {
    expect(transitionSecondsForClip(clips, 'b')).toEqual({ specified: 1.5, effective: 1.5 })
  })

  it('詰められたクリップは、指定と実効が食い違ったまま返る(画面に出すため)', () => {
    const r = transitionSecondsForClip(clips, 'c')
    expect(r?.specified).toBe(1.5)
    expect(round(r!.effective)).toBe(round(1 - TRANSITION_SAFETY_MARGIN))
  })

  it('つなぎを持たないクリップは null', () => {
    expect(transitionSecondsForClip(clips, 'a')).toBeNull()
  })

  it('居ないIDは null', () => {
    expect(transitionSecondsForClip(clips, 'zzz')).toBeNull()
  })
})

describe('crossfadeOpacity — 画面側の重なりの濃さ', () => {
  it('0 から 1 へ直線', () => {
    expect(crossfadeOpacity(0, 2)).toBe(0)
    expect(crossfadeOpacity(1, 2)).toBe(0.5)
    expect(crossfadeOpacity(2, 2)).toBe(1)
  })

  it('尺が 0・負・NaN なら 1(重ねない)', () => {
    expect(crossfadeOpacity(1, 0)).toBe(1)
    expect(crossfadeOpacity(1, -1)).toBe(1)
    expect(crossfadeOpacity(1, NaN)).toBe(1)
  })

  it('【不変条件】必ず 0〜1', () => {
    const rnd = seeded(99)
    for (let i = 0; i < 5000; i++) {
      const v = crossfadeOpacity((rnd() - 0.3) * 6, rnd() * 4)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    for (const a of NASTY_NUMBERS) {
      for (const b of NASTY_NUMBERS) {
        const v = crossfadeOpacity(a, b)
        expect(Number.isFinite(v), `${a}/${b} -> ${v}`).toBe(true)
        expect(round(v)).toBeGreaterThanOrEqual(0)
        expect(round(v)).toBeLessThanOrEqual(1)
      }
    }
  })
})

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERLAY_DURATION,
  MIN_OVERLAY_DURATION,
  newOverlayRange
} from '@renderer/lib/textOverlayPlacement'
import { snapClamped } from '@renderer/lib/snapping'
import { NASTY_NUMBERS, round, seeded } from '../helpers/boundary'

/**
 * タイムラインのつまみを引いたときの規則(`Timeline.tsx` の mousemove と同じ式)。
 * **数字は共有の `MIN_OVERLAY_DURATION` から取る**——ここに別の数字を書いたことが
 * 2026-09-10 のバグそのものなので、テストでも絶対に直書きしない。
 */
function dragLeft(start: number, end: number, deltaSec: number): { s: number; e: number } {
  const maxStart = end - MIN_OVERLAY_DURATION
  const rawStart = Math.min(maxStart, Math.max(0, start + deltaSec))
  return { s: round(snapClamped(rawStart, [], 0, 0, maxStart).time), e: round(end) }
}
function dragRight(start: number, end: number, deltaSec: number): { s: number; e: number } {
  const minEnd = start + MIN_OVERLAY_DURATION
  const rawEnd = Math.max(minEnd, end + deltaSec)
  return {
    s: round(start),
    e: round(snapClamped(rawEnd, [], 0, minEnd, Number.POSITIVE_INFINITY).time)
  }
}
/** 「テキスト」タブの数値欄の規則(`TelopInspector.tsx` と同じ式) */
function fieldStart(value: number, end: number): number {
  if (!Number.isFinite(value)) return 0
  return round(Math.min(Math.max(0, value), Math.max(0, end - MIN_OVERLAY_DURATION)))
}
function fieldEnd(value: number, start: number): number {
  if (!Number.isFinite(value)) return round(start + MIN_OVERLAY_DURATION)
  return round(Math.max(value, start + MIN_OVERLAY_DURATION))
}

describe('【レグレッション】テロップの最短の長さは1つだけ', () => {
  /**
   * 2026-09-10 のバグ狩り。共有は 0.1秒なのに `Timeline.tsx` が自前で 0.2秒を
   * 持っていたので、同じ「縮める」操作が入口によって別の結果になり、しかも
   * 0.1秒のテロップの端を掴むと**掴んだ向きと逆へ飛んで伸びた**。
   */
  it('数値欄とつまみが同じ最短に着く', () => {
    // 実測(ズーム100%): 4.000〜7.000 のテロップを目一杯縮める
    expect(fieldStart(99, 7)).toBe(6.9)
    expect(dragLeft(4, 7, 5)).toEqual({ s: 6.9, e: 7 })
    expect(round(7 - fieldStart(99, 7))).toBe(round(7 - dragLeft(4, 7, 5).s))
    expect(round(7 - dragLeft(4, 7, 5).s)).toBe(MIN_OVERLAY_DURATION)
  })

  it('最短のテロップを、さらに縮める向きへ掴んでも動かない', () => {
    // 修正前は左端を右へ動かすと 4.000 → 3.900 と左へ飛び、尺が 0.2秒に伸びていた
    expect(dragLeft(4, 4.1, 0.02)).toEqual({ s: 4, e: 4.1 })
    expect(dragLeft(4, 4.1, 5)).toEqual({ s: 4, e: 4.1 })
    expect(dragRight(4, 4.1, -0.02)).toEqual({ s: 4, e: 4.1 })
    expect(dragRight(4, 4.1, -5)).toEqual({ s: 4, e: 4.1 })
  })

  it('伸ばす向きは今までどおり効く(実機の回帰6通りと同じ数字)', () => {
    expect(dragLeft(4, 7, 1)).toEqual({ s: 5, e: 7 })
    expect(dragLeft(4, 7, -1.5)).toEqual({ s: 2.5, e: 7 })
    expect(dragRight(4, 7, -1)).toEqual({ s: 4, e: 6 })
    expect(dragRight(4, 7, 2)).toEqual({ s: 4, e: 9 })
    expect(dragRight(4, 7, -5)).toEqual({ s: 4, e: 4.1 })
    expect(dragLeft(0, 3, -2)).toEqual({ s: 0, e: 3 })
  })

  it('【不変条件】つまみを引いても、尺が最短を下回らない/開始が負にならない', () => {
    const rnd = seeded(864213)
    for (let i = 0; i < 20000; i++) {
      const s = rnd() * 20
      const e = s + MIN_OVERLAY_DURATION + rnd() * 10
      const d = (rnd() - 0.5) * 40
      for (const r of [dragLeft(s, e, d), dragRight(s, e, d)]) {
        expect(Number.isFinite(r.s) && Number.isFinite(r.e), `${s}..${e} ${d}`).toBe(true)
        expect(r.s).toBeGreaterThanOrEqual(0)
        expect(r.e - r.s).toBeGreaterThanOrEqual(MIN_OVERLAY_DURATION - 1e-9)
      }
    }
  })

  it('数値欄も同じ不変条件を守る', () => {
    for (const v of NASTY_NUMBERS) {
      const s = fieldStart(v, 7)
      expect(Number.isFinite(s), `start ${v} -> ${s}`).toBe(true)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(7 - MIN_OVERLAY_DURATION + 1e-9)

      const e = fieldEnd(v, 4)
      expect(Number.isFinite(e), `end ${v} -> ${e}`).toBe(true)
      expect(e).toBeGreaterThanOrEqual(4 + MIN_OVERLAY_DURATION - 1e-9)
    }
  })
})

describe('newOverlayRange — 「テロップを1枚足す」ときに置く区間', () => {
  it('再生位置に置き、既定の長さを使う', () => {
    expect(newOverlayRange(7, 12)).toEqual({ startTime: 7, endTime: 10 })
  })

  it('タイムラインの終わりを超えない', () => {
    expect(newOverlayRange(11, 12)).toEqual({ startTime: 11, endTime: 12 })
  })

  it('末尾ぴったりで押しても潰れない', () => {
    expect(newOverlayRange(12, 12)).toEqual({ startTime: 11.9, endTime: 12 })
  })

  it('まだクリップが無い(尺0)なら既定の長さをそのまま使う', () => {
    expect(newOverlayRange(0, 0)).toEqual({ startTime: 0, endTime: DEFAULT_OVERLAY_DURATION })
    expect(newOverlayRange(5, 0)).toEqual({ startTime: 5, endTime: 5 + DEFAULT_OVERLAY_DURATION })
  })

  it('負・NaN の再生位置は 0 から', () => {
    expect(newOverlayRange(-3, 12)).toEqual({ startTime: 0, endTime: 3 })
    expect(newOverlayRange(NaN, 12)).toEqual({ startTime: 0, endTime: 3 })
  })

  it('【不変条件】必ず 0 以上・最短以上の長さ・有限', () => {
    // 桁は実用の範囲(〜100時間)まで。それを超えると **足し算が吸収されて**
    // 長さが 0 になる(下の「既知の限界」を参照)。
    const playheads = NASTY_NUMBERS.filter((n) => !Number.isFinite(n) || Math.abs(n) <= 4e5)
    for (const p of playheads) {
      for (const total of [0, 0.05, 1, 12, 1e5, -1, NaN, Infinity]) {
        const r = newOverlayRange(p, total)
        expect(Number.isFinite(r.startTime), `p=${p} total=${total}`).toBe(true)
        expect(Number.isFinite(r.endTime), `p=${p} total=${total}`).toBe(true)
        expect(r.startTime).toBeGreaterThanOrEqual(0)
        expect(r.endTime - r.startTime).toBeGreaterThanOrEqual(MIN_OVERLAY_DURATION - 1e-9)
      }
    }
  })

  it('【既知の限界】再生位置の桁が極端だと、足し算が吸収されて長さ0になる', () => {
    // `MAX_VALUE + 3 === MAX_VALUE`(倍精度の吸収)。再生位置がこの桁になる経路は
    // UIには無いが、そういう `.veproj` を手で書けば届く。**直したらここが落ちる。**
    const r = newOverlayRange(Number.MAX_VALUE, 0)
    expect(r.endTime - r.startTime).toBe(0)
  })
})

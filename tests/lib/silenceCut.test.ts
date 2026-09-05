import { describe, expect, it } from 'vitest'
import { buildCutSegments } from '@renderer/lib/silenceCut'
import { sameClipContentIgnoringId } from '@renderer/lib/projectEquality'
import type { Clip, SilenceRange } from '@shared/types'
import { NASTY_NUMBERS, seeded } from '../helpers/boundary'

/**
 * 無音カット・フィラーカット・テキストで編集の3経路が通る、ただ1つの断片組み立て。
 * ここが返した断片は `replaceClipRange` がそのままタイムラインに置くので、
 * **返した `id` がそのままクリップの `id` になる**。
 */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    assetId: 'A',
    inPoint: 0,
    outPoint: 10,
    speed: 1,
    ...over
  } as Clip
}

const span = (segs: Clip[]): string => segs.map((s) => `${s.inPoint}-${s.outPoint}`).join(' / ')

describe('buildCutSegments — 区間を抜いた残りを断片にする', () => {
  it('真ん中の1区間を抜くと2本になる', () => {
    const segs = buildCutSegments(clip(), [{ start: 4, end: 6 }])
    expect(span(segs)).toBe('0-4 / 6-10')
    expect(new Set(segs.map((s) => s.id)).size).toBe(2)
  })

  it('複数の区間・並びが前後していても素材の順に並ぶ', () => {
    const segs = buildCutSegments(clip(), [
      { start: 7, end: 8 },
      { start: 2, end: 3 }
    ])
    expect(span(segs)).toBe('0-2 / 3-7 / 8-10')
  })

  it('重なった区間はまとめて1つの穴になる', () => {
    const segs = buildCutSegments(clip(), [
      { start: 2, end: 5 },
      { start: 4, end: 7 }
    ])
    expect(span(segs)).toBe('0-2 / 7-10')
  })

  it('つなぎは先頭の断片だけが持つ', () => {
    const c = clip({ transitionIn: { type: 'crossfade', duration: 0.5 } } as Partial<Clip>)
    const segs = buildCutSegments(c, [{ start: 4, end: 6 }])
    expect(segs[0].transitionIn).toEqual({ type: 'crossfade', duration: 0.5 })
    expect(segs.slice(1).every((s) => s.transitionIn === undefined)).toBe(true)
  })

  it('全部が削除対象なら、クリップを丸ごと残す(消し飛ばさない)', () => {
    const segs = buildCutSegments(clip(), [{ start: 0, end: 10 }])
    expect(span(segs)).toBe('0-10')
    expect(segs[0].id).toBe('c1')
  })
})

/**
 * 【レグレッション】何も切らない適用で、クリップのIDが作り直されていた (2026-09-15)
 *
 * フィラーカットは検出が1件でもあれば「選択した区間を削除」を押せてしまい、
 * チェックを全部外したまま押すと**削る区間0件**でここへ来ていた。文字起こしが
 * クリップの尺の外まで返したとき(区間が全部クリップの外)も同じ。
 *
 * 修正前の実測(4秒のクリップ・分離音声つき・そのクリップを選択中):
 * - 本編クリップの id が `c1` → `988ae3e2-…`、分離音声も `a2` → `6ad7a9bb-…`
 * - `selectedClipId` は `c1` のまま = **どのクリップも指さない** → 選択が外れる
 * - `past` が **1件**積まれ `isDirty` が立つ → 取り消しても画面は変わらないのに
 *   未保存の印と自動保存だけが走り出す
 *
 * 修正後は id も選択も履歴もそのまま(数字は `tests/store/projectStore.test.ts` 側で固定)。
 */
describe('【レグレッション】何も切らないなら作り直さない (2026-09-15)', () => {
  it('区間が空なら、同じ id のクリップをそのまま返す', () => {
    const segs = buildCutSegments(clip(), [])
    expect(segs).toHaveLength(1)
    expect(segs[0].id).toBe('c1') // 修正前: 新しい uuid
    expect(span(segs)).toBe('0-10')
  })

  it('区間が全部クリップの外なら、同じ id のクリップをそのまま返す', () => {
    const c = clip({ inPoint: 2, outPoint: 6 })
    for (const outside of [
      [{ start: 6.5, end: 8 }],
      [{ start: 0, end: 1.5 }],
      [
        { start: 0, end: 1 },
        { start: 7, end: 9 }
      ]
    ] as SilenceRange[][]) {
      const segs = buildCutSegments(c, outside)
      expect(segs).toHaveLength(1)
      expect(segs[0].id).toBe('c1')
      expect(span(segs)).toBe('2-6')
    }
  })

  it('少しでも削れるなら、今までどおり新しい断片を作る', () => {
    // 端の 0.06秒(最短の切れ端 0.05 より大きい)だけを削る
    const segs = buildCutSegments(clip({ inPoint: 0, outPoint: 4 }), [{ start: 0, end: 0.06 }])
    expect(span(segs)).toBe('0.06-4')
    expect(segs[0].id).not.toBe('c1')
  })
})

describe('境界値 — 壊れた区間が混ざっても、他の区間まで無効にしない', () => {
  it('NaN・Infinity・長さ0の区間は捨てて、正常な区間だけ削る', () => {
    const segs = buildCutSegments(clip(), [
      { start: NaN, end: 5 },
      { start: 3, end: NaN },
      { start: 5, end: 5 },
      { start: Infinity, end: -Infinity },
      { start: 4, end: 6 }
    ])
    expect(span(segs)).toBe('0-4 / 6-10')
  })

  it('どんな数を入れても、断片は必ずクリップの中に収まる', () => {
    const c = clip({ inPoint: 2, outPoint: 8 })
    for (const a of NASTY_NUMBERS) {
      for (const b of NASTY_NUMBERS) {
        const segs = buildCutSegments(c, [{ start: a, end: b }])
        for (const s of segs) {
          expect(Number.isFinite(s.inPoint)).toBe(true)
          expect(Number.isFinite(s.outPoint)).toBe(true)
          expect(s.inPoint).toBeGreaterThanOrEqual(2)
          expect(s.outPoint).toBeLessThanOrEqual(8)
          expect(s.outPoint).toBeGreaterThan(s.inPoint)
        }
      }
    }
  })
})

describe('【不変条件】断片は順に並び、重ならず、クリップからはみ出さない', () => {
  it('乱数3000通り', () => {
    const rnd = seeded(20260905)
    for (let n = 0; n < 3000; n++) {
      const inPoint = rnd() * 20
      const c = clip({ inPoint, outPoint: inPoint + 0.1 + rnd() * 20 })
      const ranges: SilenceRange[] = Array.from({ length: Math.floor(rnd() * 6) }, () => {
        const start = inPoint - 5 + rnd() * 30
        return { start, end: start - 1 + rnd() * 6 }
      })
      const segs = buildCutSegments(c, ranges)
      expect(segs.length).toBeGreaterThan(0)
      segs.forEach((s, i) => {
        expect(s.outPoint).toBeGreaterThan(s.inPoint)
        expect(s.inPoint).toBeGreaterThanOrEqual(c.inPoint)
        expect(s.outPoint).toBeLessThanOrEqual(c.outPoint)
        if (i > 0) expect(s.inPoint).toBeGreaterThanOrEqual(segs[i - 1].outPoint)
      })
      // 断片が1本で範囲もそのままなら、それは「何も切らなかった」——id は変えない。
      if (segs.length === 1 && segs[0].inPoint === c.inPoint && segs[0].outPoint === c.outPoint) {
        expect(segs[0].id).toBe(c.id)
      }
    }
  })
})

describe('sameClipContentIgnoringId — id だけが違うクリップを見分ける', () => {
  it('id 以外が同じなら true、1つでも違えば false', () => {
    const a = clip()
    expect(sameClipContentIgnoringId(a, { ...a, id: 'other' })).toBe(true)
    expect(sameClipContentIgnoringId(a, { ...a, id: 'other', outPoint: 9 })).toBe(false)
    expect(sameClipContentIgnoringId(a, { ...a })).toBe(true)
    // `undefined` のキーは「無い」と同じ(保存すれば同じファイルになる)
    expect(sameClipContentIgnoringId(a, { ...a, transitionIn: undefined })).toBe(true)
  })
})

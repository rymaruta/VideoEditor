import { describe, expect, it } from 'vitest'
import {
  mapTimelineRange,
  timelineMapping,
  uncoveredSpans,
  type TimelineMapSeg,
  type TimelineSpan
} from '@shared/roughCut/follow'
import { NASTY_NUMBERS, seeded } from '../helpers/boundary'

/**
 * 本編を手で詰めたときに、ピンマイク・自動テロップを付いていかせる時刻の対応。
 * 速くするために索引で「重なりうる所」だけを調べるようにしたので、**総当たりの元の実装と
 * 1件も違わない**ことを、ばらばらな入力(重なり・同じ時刻の使い回し・並べ替え・NaN)で確かめる。
 */
const EPS = 1e-6

function naiveMapping(before: TimelineSpan[], after: TimelineSpan[]): TimelineMapSeg[] {
  const out: TimelineMapSeg[] = []
  for (const o of before)
    for (const n of after) {
      const a = Math.max(o.start, n.start)
      const b = Math.min(o.end, n.end)
      if (b - a <= EPS) continue
      out.push({
        from: o.timeline + (a - o.start),
        to: o.timeline + (b - o.start),
        at: n.timeline + (a - n.start)
      })
    }
  return out.sort((x, y) => x.from - y.from || x.at - y.at)
}

function naiveRange(segs: TimelineMapSeg[], a: number, b: number): TimelineMapSeg[] {
  const out: TimelineMapSeg[] = []
  for (const s of segs) {
    const from = Math.max(a, s.from)
    const to = Math.min(b, s.to)
    if (to - from <= EPS) continue
    out.push({ from, to, at: s.at + (from - s.from) })
  }
  return out
}

function naiveUncovered(
  after: TimelineSpan[],
  segs: TimelineMapSeg[]
): (TimelineSpan & { owner: number })[] {
  const out: (TimelineSpan & { owner: number })[] = []
  for (let owner = 0; owner < after.length; owner++) {
    const n = after[owner]
    const len = n.end - n.start
    const covered = segs
      .map((s) => ({
        a: Math.max(n.timeline, s.at),
        b: Math.min(n.timeline + len, s.at + (s.to - s.from))
      }))
      .filter((r) => r.b - r.a > EPS)
      .sort((x, y) => x.a - y.a)
    let t = n.timeline
    for (const r of covered) {
      if (r.a - t > EPS)
        out.push({
          timeline: t,
          start: n.start + (t - n.timeline),
          end: n.start + (r.a - n.timeline),
          owner
        })
      t = Math.max(t, r.b)
    }
    if (n.timeline + len - t > EPS)
      out.push({ timeline: t, start: n.start + (t - n.timeline), end: n.end, owner })
  }
  return out
}

/** 本編のクリップの並び → タイムラインの区間(共通の時刻は重なってよい・戻ってよい) */
function randomSpans(rnd: () => number, count: number): TimelineSpan[] {
  const out: TimelineSpan[] = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    const len = rnd() < 0.1 ? rnd() * 60 : 0.2 + rnd() * 4
    const start = rnd() < 0.15 ? rnd() * 200 : i * 2.1 + rnd()
    out.push({ timeline: cursor, start, end: start + len })
    cursor += len
  }
  return out
}

/** 本編を少し編集した後(消す・詰める・伸ばす・並べ替える・同じ所を2回使う) */
function edited(rnd: () => number, spans: TimelineSpan[]): TimelineSpan[] {
  const pieces = spans
    .filter(() => rnd() > 0.1)
    .map((s) => (rnd() < 0.2 ? { ...s, end: s.start + (s.end - s.start) * (0.3 + rnd()) } : s))
  if (pieces.length > 2 && rnd() < 0.5) pieces.splice(1, 0, pieces[pieces.length - 1])
  let cursor = 0
  return pieces.map((s) => {
    const out = { ...s, timeline: cursor }
    cursor += s.end - s.start
    return out
  })
}

describe('roughCut/follow — 索引で絞っても総当たりと同じ結果', () => {
  it('ばらばらな本編の編集 200通りで、対応・写した区間・新しく見えた区間が一致する', () => {
    const rnd = seeded(20261005)
    for (let trial = 0; trial < 200; trial++) {
      const before = randomSpans(rnd, 1 + Math.floor(rnd() * 40))
      const after = edited(rnd, before)
      const segs = timelineMapping(before, after)
      expect(segs).toEqual(naiveMapping(before, after))
      expect(uncoveredSpans(after, segs)).toEqual(naiveUncovered(after, segs))
      for (let q = 0; q < 20; q++) {
        const a = rnd() * 120 - 5
        const b = a + (rnd() < 0.1 ? -1 : rnd() * 10)
        expect(mapTimelineRange(segs, a, b)).toEqual(naiveRange(segs, a, b))
      }
    }
  })

  it('NaN・Infinity を含む端でも、総当たりと同じ結果(落ちない)', () => {
    const before: TimelineSpan[] = [
      { timeline: 0, start: 0, end: 5 },
      { timeline: 5, start: 10, end: 12 }
    ]
    for (const v of NASTY_NUMBERS) {
      const after: TimelineSpan[] = [
        { timeline: 0, start: 10, end: 12 },
        { timeline: 2, start: v, end: 3 }
      ]
      const segs = timelineMapping(before, after)
      expect(segs).toEqual(naiveMapping(before, after))
      expect(uncoveredSpans(after, segs)).toEqual(naiveUncovered(after, segs))
      expect(mapTimelineRange(segs, v, 4)).toEqual(naiveRange(segs, v, 4))
      expect(mapTimelineRange(segs, 0, v)).toEqual(naiveRange(segs, 0, v))
    }
  })

  it('並んでいない対応を渡されても、全部を調べる', () => {
    const segs: TimelineMapSeg[] = [
      { from: 10, to: 20, at: 0 },
      { from: 0, to: 5, at: 10 }
    ]
    expect(mapTimelineRange(segs, 1, 15)).toEqual(naiveRange(segs, 1, 15))
  })

  it('2,000クリップの本編の対応と、1万2千件の写しが 400ms 以内', () => {
    const rnd = seeded(7)
    const before = randomSpans(rnd, 2000)
    const after = edited(rnd, before)
    const t0 = performance.now()
    const segs = timelineMapping(before, after)
    uncoveredSpans(after, segs)
    for (let i = 0; i < 12000; i++) mapTimelineRange(segs, i * 0.35, i * 0.35 + 1.8)
    // 実測(他の処理と CPU を取り合う中で): 索引あり 51ms / 総当たり 681ms
    // (2,000 × 2,000 の組 + 1万2千 × 2,000 回)。総当たりに戻ると必ず超える
    expect(performance.now() - t0).toBeLessThan(400)
  })
})

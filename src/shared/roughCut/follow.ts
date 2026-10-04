/**
 * 本編(収録素材のカメラ)を手で消す・詰める・並べ替えたときに、ピンマイクの声・自動テロップ・
 * 自動の SE/BGM/CG を本編に付いていかせるための、タイムラインの時刻の対応。
 *
 * ピンマイクのクリップや自動テロップはタイムラインの絶対の時刻で置いてあり、本編のクリップとは
 * 紐づいていない。本編だけ詰めると、そこから後ろの声とテロップが詰めた分だけずれる
 * (実測: 10秒のクリップを消すと、映像は素材の 20 秒・声は 0 秒・テロップは 10 秒先のまま)。
 *
 * 本編の変更前と後の `spans`(タイムラインの時刻 ↔ 共通の時刻)を比べ、同じ共通の時刻を映している
 * 所どうしを結ぶ。変更前のタイムラインの区間を、この対応で変更後のタイムラインへ写す。
 */

import { fileAt, toSource, type MulticamInfo } from '../sync/multicam'

export interface TimelineSpan {
  timeline: number
  start: number
  end: number
}

/** 変更前のタイムラインの [from, to) が、変更後のタイムラインの at から続く */
export interface TimelineMapSeg {
  from: number
  to: number
  at: number
}

const EPS = 1e-6

export function timelineMapping(
  before: readonly TimelineSpan[],
  after: readonly TimelineSpan[]
): TimelineMapSeg[] {
  const out: TimelineMapSeg[] = []
  for (const o of before) {
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
  }
  return out.sort((x, y) => x.from - y.from || x.at - y.at)
}

const totalLength = (spans: readonly TimelineSpan[]): number =>
  spans.reduce((t, s) => t + (s.end - s.start), 0)

/** 本編の変更で、どの時刻も動いていない(作り直しの必要が無い) */
export function isIdentityMapping(
  segs: readonly TimelineMapSeg[],
  before: readonly TimelineSpan[],
  after: readonly TimelineSpan[]
): boolean {
  if (segs.some((s) => Math.abs(s.from - s.at) > EPS)) return false
  const mapped = segs.reduce((t, s) => t + (s.to - s.from), 0)
  return (
    Math.abs(mapped - totalLength(before)) <= 1e-4 && Math.abs(mapped - totalLength(after)) <= 1e-4
  )
}

/** 変更前のタイムラインの [a, b) を、変更後のタイムラインへ写した部分(変更前の時刻の順) */
export function mapTimelineRange(
  segs: readonly TimelineMapSeg[],
  a: number,
  b: number
): TimelineMapSeg[] {
  const out: TimelineMapSeg[] = []
  for (const s of segs) {
    const from = Math.max(a, s.from)
    const to = Math.min(b, s.to)
    if (to - from <= EPS) continue
    out.push({ from, to, at: s.at + (from - s.from) })
  }
  return out
}

/**
 * 変更後のタイムラインのうち、変更前には無かった(写ってこない)共通の時刻の区間。
 * 本編のクリップを伸ばしたときの、新しく見えるようになった所(ピンマイクの声を足す)
 */
export function uncoveredSpans(
  after: readonly TimelineSpan[],
  segs: readonly TimelineMapSeg[]
): TimelineSpan[] {
  const out: TimelineSpan[] = []
  for (const n of after) {
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
          end: n.start + (r.a - n.timeline)
        })
      t = Math.max(t, r.b)
    }
    if (n.timeline + len - t > EPS)
      out.push({ timeline: t, start: n.start + (t - n.timeline), end: n.end })
  }
  return out
}

/** 共通の時刻の区間を、その機材の素材のクリップにする(録っていない時間は飛ばす) */
export function sourcePieces(
  info: MulticamInfo,
  sourceId: string,
  span: TimelineSpan
): { assetId: string; startTime: number; inPoint: number; outPoint: number; speed: number }[] {
  const out: {
    assetId: string
    startTime: number
    inPoint: number
    outPoint: number
    speed: number
  }[] = []
  let t = span.start
  while (t < span.end - EPS) {
    const f = fileAt(info, sourceId, t)
    if (!f) {
      const next = info.files
        .filter((x) => x.sourceId === sourceId && x.start > t)
        .reduce((m, x) => Math.min(m, x.start), Infinity)
      t = Math.min(span.end, next)
      continue
    }
    const end = Math.min(span.end, f.start + f.duration / f.rate)
    out.push({
      assetId: f.assetId,
      startTime: span.timeline + (t - span.start),
      inPoint: toSource(f, t),
      outPoint: toSource(f, end),
      speed: f.rate
    })
    t = end
  }
  return out
}

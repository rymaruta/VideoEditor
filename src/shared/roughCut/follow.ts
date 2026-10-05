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
  // 総当たり(前 × 後)だと、2,000クリップの本編を1本消すだけで 400万組を調べる
  // (実測: 60分・2,000クリップ・ピンマイク6本で、本編の1回の編集に 170ms)。
  // 後の区間を共通の時刻の頭で並べておき、重なりうる所だけを調べる
  const index = spanIndex(
    after,
    (n) => n.start,
    (n) => n.end
  )
  const out: TimelineMapSeg[] = []
  for (const o of before) {
    for (const k of index.overlapping(o.start, o.end)) {
      const n = after[k]
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

/** 本編のクリップ1本ぶんの区間(どのクリップのものか付き) */
export interface ClipSpan extends TimelineSpan {
  id: string
}

/** 区間の並び `list` から [a, b) を取り除く */
function subtractRange(list: { start: number; end: number }[], a: number, b: number): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]
    if (r.end <= a + EPS || r.start >= b - EPS) continue
    const rest: { start: number; end: number }[] = []
    if (a - r.start > EPS) rest.push({ start: r.start, end: a })
    if (r.end - b > EPS) rest.push({ start: b, end: r.end })
    list.splice(i, 1, ...rest)
  }
}

/**
 * `timelineMapping` の、同じ素材の時刻が本編に2回以上出てくるときにも1対1で結ぶ版。
 *
 * 同じ時刻を映す所どうしを全部結ぶと、同じ所を2回使った本編(複製・貼り付け・同じ所の切り出し)では
 * 1か所の声が2か所へ写り、編集のたびに倍に増える(実測: 色ラベルを4回変えるとピンマイクが 2 → 32 本)。
 *
 * 1. 前後で同じクリップ(id が同じ)は、そのクリップどうしで結ぶ
 * 2. 残り(分割・作り直しで id が変わった所)は、まだ結んでいない所どうしを、前から順に1回ずつ結ぶ
 */
export function clipTimelineMapping(
  before: readonly ClipSpan[],
  after: readonly ClipSpan[],
  /** 分割で新しく作ったクリップの、元のクリップの id(分けた後ろ半分も、元のクリップとして先に結ぶ) */
  originOf: (id: string) => string | undefined = () => undefined
): TimelineMapSeg[] {
  const out: TimelineMapSeg[] = []
  const afterIndexById = new Map<string, number[]>()
  after.forEach((n, k) => {
    for (const id of new Set([n.id, originOf(n.id)])) {
      if (id === undefined) continue
      const list = afterIndexById.get(id)
      if (list) list.push(k)
      else afterIndexById.set(id, [k])
    }
  })
  // 変更後の区間ごとの、まだ結んでいない共通の時刻
  const free = after.map((n) => [{ start: n.start, end: n.end }])
  const link = (o: ClipSpan, n: ClipSpan, a: number, b: number): void => {
    out.push({
      from: o.timeline + (a - o.start),
      to: o.timeline + (b - o.start),
      at: n.timeline + (a - n.start)
    })
  }
  const left: { o: ClipSpan; rest: { start: number; end: number }[] }[] = []
  for (const o of before) {
    const rest = [{ start: o.start, end: o.end }]
    for (const k of afterIndexById.get(o.id) ?? []) {
      const n = after[k]
      for (const r of [...rest]) {
        for (const f of [...free[k]]) {
          const a = Math.max(r.start, f.start, n.start)
          const b = Math.min(r.end, f.end, n.end)
          if (b - a <= EPS) continue
          link(o, n, a, b)
          subtractRange(free[k], a, b)
          subtractRange(rest, a, b)
        }
      }
    }
    if (rest.length > 0) left.push({ o, rest })
  }
  if (left.length > 0) {
    const index = spanIndex(
      after,
      (n) => n.start,
      (n) => n.end
    )
    // 前から順に(変更前のタイムラインの順で)、変更後のタイムラインの早い所から結ぶ
    left.sort((x, y) => x.o.timeline - y.o.timeline)
    for (const { o, rest } of left) {
      const ks = index
        .overlapping(o.start, o.end)
        .sort((x, y) => after[x].timeline - after[y].timeline)
      for (const k of ks) {
        const n = after[k]
        for (const r of [...rest]) {
          for (const f of [...free[k]]) {
            const a = Math.max(r.start, f.start)
            const b = Math.min(r.end, f.end)
            if (b - a <= EPS) continue
            link(o, n, a, b)
            subtractRange(free[k], a, b)
            subtractRange(rest, a, b)
          }
        }
        if (rest.length === 0) break
      }
    }
  }
  return out.sort((x, y) => x.from - y.from || x.at - y.at)
}

/**
 * 区間の並びの、[lo, hi) と重なりうるものを速く引くための索引。
 * 頭(`startOf`)で並べ、いちばん長い区間の長さぶん手前から探す。返す番号は元の並びの順
 * (総当たりと同じ順に結果を作るため)。数値でない端を持つ区間があれば、索引を作らず全部を返す
 */
function spanIndex<T>(
  items: readonly T[],
  startOf: (t: T) => number,
  endOf: (t: T) => number
): { overlapping: (lo: number, hi: number) => number[] } {
  const all = (): number[] => items.map((_, i) => i)
  let maxLen = 0
  for (const t of items) {
    const s = startOf(t)
    const e = endOf(t)
    if (!Number.isFinite(s) || !Number.isFinite(e)) return { overlapping: all }
    maxLen = Math.max(maxLen, e - s)
  }
  const order = items.map((_, i) => i).sort((x, y) => startOf(items[x]) - startOf(items[y]))
  const starts = order.map((i) => startOf(items[i]))
  /** 頭が `v` 以上の最初の位置 */
  const lowerBound = (v: number): number => {
    let l = 0
    let h = starts.length
    while (l < h) {
      const m = (l + h) >> 1
      if (starts[m] < v) l = m + 1
      else h = m
    }
    return l
  }
  return {
    overlapping: (lo, hi) => {
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return all()
      // 頭が lo - いちばん長い区間 より前のものは、lo までに終わっている(余裕を見て EPS 広く取る)
      const out: number[] = []
      for (let k = lowerBound(lo - maxLen - EPS); k < starts.length && starts[k] < hi + EPS; k++) {
        out.push(order[k])
      }
      return out.sort((x, y) => x - y)
    }
  }
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
  // ピンマイクのクリップ・テロップ(合わせて1万件以上)ごとに対応の全部(2,000件)をなめると
  // 本編の1回の編集で数千万回になる。`timelineMapping` の結果は変更前の時刻の順に並んでいるので、
  // 重なりうる所から始めて、b を過ぎたら止める
  const range = sortedRange(segs, a, b)
  for (let k = range.first; k < range.end; k++) {
    const s = segs[k]
    const from = Math.max(a, s.from)
    const to = Math.min(b, s.to)
    if (to - from <= EPS) continue
    out.push({ from, to, at: s.at + (from - s.from) })
  }
  return out
}

/** 対応の並びの索引(並びは作り直さず使い回すので、並びごとに1回だけ作る) */
const segIndexCache = new WeakMap<readonly TimelineMapSeg[], { sorted: boolean; maxLen: number }>()

/** `segs` のうち [a, b) と重なりうる位置の範囲。変更前の時刻の順に並んでいなければ全部 */
function sortedRange(
  segs: readonly TimelineMapSeg[],
  a: number,
  b: number
): { first: number; end: number } {
  const whole = { first: 0, end: segs.length }
  if (!Number.isFinite(a) || !Number.isFinite(b)) return whole
  let info = segIndexCache.get(segs)
  if (!info) {
    let sorted = true
    let maxLen = 0
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]
      if (!Number.isFinite(s.from) || !Number.isFinite(s.to)) sorted = false
      if (k > 0 && !(segs[k - 1].from <= s.from)) sorted = false
      maxLen = Math.max(maxLen, s.to - s.from)
    }
    info = { sorted, maxLen }
    segIndexCache.set(segs, info)
  }
  if (!info.sorted) return whole
  // 頭が a - いちばん長い区間 より前のものは a までに終わっている(余裕を見て EPS 広く取る)
  const lo = a - info.maxLen - EPS
  let l = 0
  let h = segs.length
  while (l < h) {
    const m = (l + h) >> 1
    if (segs[m].from < lo) l = m + 1
    else h = m
  }
  let end = l
  // 頭が b 以上のものは重ならない(from = max(a, s.from) ≥ b ≥ to)
  while (end < segs.length && segs[end].from < b) end++
  return { first: l, end }
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
  // 対応を変更後の時刻(at)で引けるようにしておく(総当たりだと 2,000 × 2,000 の組を毎回作っていた)
  const index = spanIndex(
    segs,
    (s) => s.at,
    (s) => s.at + (s.to - s.from)
  )
  for (const n of after) {
    const len = n.end - n.start
    const covered = index
      .overlapping(n.timeline, n.timeline + len)
      .map((k) => {
        const s = segs[k]
        return {
          a: Math.max(n.timeline, s.at),
          b: Math.min(n.timeline + len, s.at + (s.to - s.from))
        }
      })
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

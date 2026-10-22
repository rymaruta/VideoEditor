import type { CutRange } from '../cut/tighten'
import { toCommon, type MulticamInfo } from '../sync/multicam'
import {
  subtractRanges,
  unionRanges,
  type CameraSeg,
  type CutOverrides,
  type Range
} from './overrides'

/**
 * 「固定する窓」(共通の時刻の区間)まわりの部品。
 *
 * - 範囲の自動編集: 選んだ範囲(タイムラインの時刻)を共通の時刻の窓にし、窓の中だけを作り直して
 *   本編に差し込む(`spliceClips`)。窓の外のクリップは同じオブジェクトのまま残す
 * - 自動編集で触らない範囲(ロック): 作り直しで、窓の中を今の中身に固定する(`pinOverrides`)
 *
 * 時刻は2種類ある: タイムラインの時刻(本編の頭からの秒)と、共通の時刻(基準カメラの時計)。
 * 窓(`Range`)は共通の時刻、`TimelineRange` はタイムラインの時刻。
 */

/** タイムラインの時刻の区間 */
export interface TimelineRange {
  start: number
  end: number
}

/** 本編のクリップ(範囲の計算に使う所だけ) */
export interface RangeClip {
  id: string
  assetId: string
  inPoint: number
  outPoint: number
  speed: number
}

const EPS = 1e-6
/** 並び順の確かめで許す、共通の時刻の戻り(丸め・分割ファイルのつなぎ目) */
const ORDER_SLACK = 0.05

/** 本編のクリップの、タイムラインの頭と終わり */
export function clipTimes(
  clips: readonly { inPoint: number; outPoint: number; speed?: number }[]
): {
  start: number
  end: number
}[] {
  let cursor = 0
  return clips.map((c) => {
    const start = cursor
    cursor += Math.max(0, c.outPoint - c.inPoint) / (c.speed || 1)
    return { start, end: cursor }
  })
}

/** 範囲の中の収録素材のクリップの、共通の時刻の切れ端(タイムラインの順) */
export interface CommonPiece {
  clipIndex: number
  /** タイムラインの時刻 */
  timelineStart: number
  timelineEnd: number
  /** 共通の時刻 */
  start: number
  end: number
}

export type CommonWindowResult =
  | {
      ok: true
      /** 共通の時刻の窓(範囲の最初の収録素材の頭 〜 最後の収録素材の終わり) */
      window: Range
      pieces: CommonPiece[]
      /** 範囲の中の、速さを変えたクリップの数(作り直すと素材の速さに戻る) */
      speedChanged: number
      /** 範囲の中の、収録素材でないクリップ(差し込みの画・静止画)の数 */
      extras: number
      /** 範囲の外にある、窓の中の時刻を映すクリップの数(並べ替え・複製) */
      outsideOverlap: number
    }
  | { ok: false; reason: string }

/**
 * タイムラインの範囲 → 共通の時刻の窓。範囲の中の収録素材のクリップが、共通の時刻の順に並んでいる
 * ことを確かめる(人が並べ替えた所は、窓にすると前後が入れ替わるので断る)
 */
export function commonWindowOf(
  clips: readonly RangeClip[],
  info: MulticamInfo,
  range: TimelineRange
): CommonWindowResult {
  if (!(range.end - range.start > EPS)) return { ok: false, reason: '範囲の長さがありません' }
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const times = clipTimes(clips)
  const pieces: CommonPiece[] = []
  let speedChanged = 0
  let extras = 0
  clips.forEach((c, i) => {
    const t = times[i]
    const a = Math.max(t.start, range.start)
    const b = Math.min(t.end, range.end)
    if (b - a <= EPS) return
    const f = fileOf.get(c.assetId)
    if (!f) {
      extras++
      return
    }
    const speed = c.speed || 1
    if (Math.abs(speed - f.rate) > 1e-9) speedChanged++
    const start = toCommon(f, c.inPoint + (a - t.start) * speed)
    const end = toCommon(f, c.inPoint + (b - t.start) * speed)
    if (end - start <= EPS) return
    pieces.push({ clipIndex: i, timelineStart: a, timelineEnd: b, start, end })
  })
  if (pieces.length === 0)
    return { ok: false, reason: '範囲に収録素材(同期した素材)のクリップがありません' }
  for (let k = 1; k < pieces.length; k++)
    if (pieces[k].start < pieces[k - 1].end - ORDER_SLACK)
      return {
        ok: false,
        reason:
          '範囲の中に、収録の時刻の順に並んでいない所があります(人が並べ替えた・複製した所)。その所を外して範囲を選んでください'
      }
  const window = { start: pieces[0].start, end: pieces[pieces.length - 1].end }
  let outsideOverlap = 0
  clips.forEach((c, i) => {
    const t = times[i]
    if (t.end > range.start + EPS && t.start < range.end - EPS) return
    const f = fileOf.get(c.assetId)
    if (!f) return
    const s = toCommon(f, c.inPoint)
    const e = toCommon(f, c.outPoint)
    if (Math.min(e, window.end) - Math.max(s, window.start) > ORDER_SLACK) outsideOverlap++
  })
  return { ok: true, window, pieces, speedChanged, extras, outsideOverlap }
}

/** 区間の並びどうしの重なり */
export function intersectRanges(a: readonly Range[], b: readonly Range[]): Range[] {
  const bb = unionRanges(b)
  const out: Range[] = []
  for (const r of unionRanges(a))
    for (const w of bb) {
      const start = Math.max(r.start, w.start)
      const end = Math.min(r.end, w.end)
      if (end - start > EPS) out.push({ start, end })
    }
  return out
}

/** カメラ付きの区間から `windows` を差し引く(カメラはそのまま) */
export function subtractSegs(segs: readonly CameraSeg[], windows: readonly Range[]): CameraSeg[] {
  return segs.flatMap((s) =>
    subtractRanges([s], windows).map((r) => ({ start: r.start, end: r.end, cameraId: s.cameraId }))
  )
}

/** カメラ付きの区間の、`windows` の中の所 */
export function intersectSegs(segs: readonly CameraSeg[], windows: readonly Range[]): CameraSeg[] {
  const ws = unionRanges(windows)
  const out: CameraSeg[] = []
  for (const s of segs)
    for (const w of ws) {
      const start = Math.max(s.start, w.start)
      const end = Math.min(s.end, w.end)
      if (end - start > EPS) out.push({ start, end, cameraId: s.cameraId })
    }
  return out.sort((x, y) => x.start - y.start)
}

/**
 * 窓の中を今の中身(`current`。今の本編の共通の時刻とカメラ)に固定する本編の修正。
 * 窓の中で今の本編に無い所は削り、ある所は足し(詰めずに残す)、カメラは今のカメラにする
 */
export function pinOverrides(
  windows: readonly Range[],
  current: readonly CameraSeg[]
): CutOverrides {
  const ws = unionRanges(windows)
  const inside = intersectSegs(current, ws)
  return {
    removed: subtractRanges(ws, inside),
    added: unionRanges(inside),
    angles: inside
  }
}

/** `base` の窓の中を `pinned` で置き換える(窓の外の判断はそのまま、窓の中は `pinned` が勝つ) */
export function overridesWithPinned(
  base: CutOverrides | undefined,
  pinned: CutOverrides,
  windows: readonly Range[]
): CutOverrides {
  const ws = unionRanges(windows)
  return {
    removed: unionRanges([...subtractRanges(base?.removed ?? [], ws), ...pinned.removed]),
    added: unionRanges([...subtractRanges(base?.added ?? [], ws), ...pinned.added]),
    angles: [...subtractSegs(base?.angles ?? [], ws), ...pinned.angles].sort(
      (x, y) => x.start - y.start
    )
  }
}

/** 本編の修正の、窓の中の所だけ(`keep` が false なら窓の外だけ) */
export function overridesWithin(
  o: CutOverrides | undefined,
  windows: readonly Range[],
  keep = true
): CutOverrides | undefined {
  if (!o) return undefined
  const ws = unionRanges(windows)
  const pick = (r: readonly Range[]): Range[] =>
    keep ? intersectRanges(r, ws) : subtractRanges(r, ws)
  const out: CutOverrides = {
    removed: pick(o.removed),
    added: pick(o.added),
    angles: keep ? intersectSegs(o.angles, ws) : subtractSegs(o.angles, ws)
  }
  return out.removed.length || out.added.length || out.angles.length ? out : undefined
}

/** 場面を窓で切る(窓に掛からない場面は外す。ID・判定はそのまま) */
export function clipScenesToWindow<S extends { id: string; start: number; end: number }>(
  scenes: readonly S[],
  window: Range
): S[] {
  return scenes
    .filter((s) => Math.min(s.end, window.end) - Math.max(s.start, window.start) > EPS)
    .map((s) => ({
      ...s,
      start: Math.max(s.start, window.start),
      end: Math.min(s.end, window.end)
    }))
}

/** 残す区間を窓の中に収める(静かな所へ寄せたカット点が、窓の外へ出た所を落とす) */
export function clampPieces(pieces: readonly CutRange[], window: Range): CutRange[] {
  return pieces
    .map((p) => ({
      ...p,
      start: Math.max(p.start, window.start),
      end: Math.min(p.end, window.end)
    }))
    .filter((p) => p.end - p.start > EPS)
}

/**
 * 残す区間の長さの合計を `target` 秒にそろえる(範囲の長さを保つ)。長すぎれば後ろから削り、
 * 短ければ後ろの区間から窓の中の素材の分だけ伸ばす(次の区間の頭まで。最後は窓の終わりまで)。
 * それでも足りなければ前へ伸ばす。埋めきれなかった秒を `short` に返す
 */
export function fitLength(
  pieces: readonly CutRange[],
  target: number,
  window: Range,
  /** 伸ばしてはいけない所(人が削った区間)。伸ばすのはその手前まで */
  blocked: readonly Range[] = []
): { pieces: CutRange[]; short: number } {
  const stops = unionRanges(blocked)
  /** t から後ろへ伸ばせる限り(削った区間の頭まで) */
  const forwardStop = (t: number): number => {
    for (const b of stops) if (b.end > t + EPS) return b.start <= t + EPS ? t : b.start
    return Infinity
  }
  /** t から前へ伸ばせる限り(削った区間の終わりまで) */
  const backwardStop = (t: number): number => {
    for (let i = stops.length - 1; i >= 0; i--) {
      const b = stops[i]
      if (b.start < t - EPS) return b.end >= t - EPS ? t : b.end
    }
    return -Infinity
  }
  const out = pieces.map((p) => ({ ...p })).sort((a, b) => a.start - b.start)
  const total = (): number => out.reduce((t, p) => t + (p.end - p.start), 0)
  let diff = total() - target
  if (diff > EPS) {
    for (let i = out.length - 1; i >= 0 && diff > EPS; i--) {
      const len = out[i].end - out[i].start
      if (len <= diff + EPS) {
        diff -= len
        out.splice(i, 1)
      } else {
        out[i].end -= diff
        diff = 0
      }
    }
    return { pieces: out, short: 0 }
  }
  let need = -diff
  // 後ろへ伸ばす(最後の区間から)
  for (let i = out.length - 1; i >= 0 && need > EPS; i--) {
    const limit = Math.min(
      i + 1 < out.length ? out[i + 1].start : window.end,
      forwardStop(out[i].end)
    )
    const room = Math.max(0, limit - out[i].end)
    const take = Math.min(room, need)
    out[i].end += take
    need -= take
  }
  // 前へ伸ばす(頭の区間から)
  for (let i = 0; i < out.length && need > EPS; i++) {
    const limit = Math.max(i > 0 ? out[i - 1].end : window.start, backwardStop(out[i].start))
    const room = Math.max(0, out[i].start - limit)
    const take = Math.min(room, need)
    out[i].start -= take
    need -= take
  }
  if (out.length === 0 && need > EPS && window.end - window.start > EPS) {
    const end = Math.min(window.end, forwardStop(window.start))
    const take = Math.min(need, Math.max(0, end - window.start))
    if (take > EPS) out.push({ start: window.start, end: window.start + take })
    need -= take
  }
  return { pieces: out, short: Math.max(0, need) }
}

/**
 * 本編のタイムラインの `range` の所を `replacement` に差し替える。範囲の境に掛かるクリップは境で分け、
 * 外側の切れ端が元の id を持つ(両側にはみ出すクリップは、前の切れ端が元の id、後ろの切れ端が
 * `splitIdOf` の id)。範囲に掛からないクリップは同じオブジェクトのまま
 */
export function spliceClips<C extends RangeClip & { transitionIn?: unknown }>(
  base: readonly C[],
  replacement: readonly C[],
  range: TimelineRange,
  splitIdOf: (id: string) => string
): { clips: C[]; before: C[]; inside: C[]; after: C[] } {
  const times = clipTimes(base)
  const before: C[] = []
  const inside: C[] = []
  const after: C[] = []
  base.forEach((c, i) => {
    const t = times[i]
    if (t.end <= range.start + EPS) return void before.push(c)
    if (t.start >= range.end - EPS) return void after.push(c)
    const speed = c.speed || 1
    const at = (x: number): number => c.inPoint + (x - t.start) * speed
    const hasLeft = t.start < range.start - EPS
    const hasRight = t.end > range.end + EPS
    if (hasLeft) before.push({ ...c, outPoint: at(range.start) })
    // 丸ごと範囲の中のクリップは同じオブジェクトのまま(ロックの中身はそのまま差し込む)
    if (!hasLeft && !hasRight) return void inside.push(c)
    inside.push({
      ...c,
      ...(hasLeft ? { id: splitIdOf(c.id), transitionIn: undefined } : {}),
      inPoint: hasLeft ? at(range.start) : c.inPoint,
      outPoint: hasRight ? at(range.end) : c.outPoint
    })
    if (hasRight)
      after.push({
        ...c,
        id: hasLeft ? splitIdOf(c.id) : c.id,
        inPoint: at(range.end),
        transitionIn: undefined
      })
  })
  // 外側が元の id を持つので、範囲の中の切れ端は(後ろの切れ端が元の id を持つとき)別の id にする
  const outsideIds = new Set([...before, ...after].map((c) => c.id))
  const insideFixed = inside.map((c) => (outsideIds.has(c.id) ? { ...c, id: splitIdOf(c.id) } : c))
  return { clips: [...before, ...replacement, ...after], before, inside: insideFixed, after }
}

/**
 * 時刻のあるもの(テロップ・音)を、窓(タイムラインの時刻)の中だけ入れ替える。真ん中の時刻が窓の中のものを
 * 外し、`replacement` の真ん中の時刻が窓の中のものを入れる
 */
export function spliceTimed<T extends { startTime: number; endTime: number }>(
  base: readonly T[],
  replacement: readonly T[],
  range: TimelineRange
): { items: T[]; removed: T[]; added: T[] } {
  const inside = (o: T): boolean => {
    const mid = (o.startTime + o.endTime) / 2
    return mid >= range.start - EPS && mid < range.end - EPS
  }
  const removed = base.filter(inside)
  const added = replacement.filter(inside)
  return { items: [...base.filter((o) => !inside(o)), ...added], removed, added }
}

/**
 * 共通の時刻の窓 → 本編のタイムラインの区間(窓の中を映すクリップが続いて並んでいる所)。
 * 窓の中を映すクリップのあいだに窓の外を映すクリップが挟まる(並べ替えた)ときは null。
 * 窓の中を映すクリップが無ければ null
 */
export function timelineWindowOf(
  clips: readonly RangeClip[],
  info: MulticamInfo,
  window: Range
): TimelineRange | null {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const times = clipTimes(clips)
  let start = Infinity
  let end = -Infinity
  let first = -1
  let last = -1
  clips.forEach((c, i) => {
    const f = fileOf.get(c.assetId)
    if (!f) return
    const speed = c.speed || 1
    const a = toCommon(f, c.inPoint)
    const b = toCommon(f, c.outPoint)
    const lo = Math.max(a, window.start)
    const hi = Math.min(b, window.end)
    if (hi - lo <= EPS) return
    // 共通の時刻 → このクリップのタイムラインの時刻(素材の速さと本編の速さの比で)
    const scale = f.rate / speed
    const ts = times[i].start + (lo - a) * scale
    const te = times[i].start + (hi - a) * scale
    start = Math.min(start, ts)
    end = Math.max(end, te)
    if (first < 0) first = i
    last = i
  })
  if (first < 0) return null
  // 間に窓の外を映す収録素材のクリップがあれば、続いていない
  for (let i = first + 1; i < last; i++) {
    const f = fileOf.get(clips[i].assetId)
    if (!f) continue
    const a = toCommon(f, clips[i].inPoint)
    const b = toCommon(f, clips[i].outPoint)
    if (a < window.start - ORDER_SLACK || b > window.end + ORDER_SLACK) return null
  }
  return { start, end }
}

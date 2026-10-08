import type { CutRange } from '../cut/tighten'
import type { Shot } from '../angles/choose'
import { coversRange, fileAt, toCommon, type MulticamInfo } from '../sync/multicam'

/**
 * 本編(カット・アングル)の人の修正を、仮編集の作り直しで上書きしない(計画書 §5.13)。
 *
 * 作り直す直前に、今の本編を「前に自動で組んだ本編」と**共通の時間軸**で比べ、人の判断を読み取る:
 * - 削った区間(自動では残したのに、今は無い)
 * - 足した区間(自動では無かったのに、今はある)
 * - カメラを替えた区間(同じ時間を、別のカメラで映している)
 * 読み取った判断は前の判断に重ねて覚え(新しい判断が勝つ)、作り直した仮編集にも当て直す。
 */

export interface Range {
  start: number
  end: number
}

/** 本編の1区間(共通の時刻)と、映しているカメラ */
export interface CameraSeg extends Range {
  cameraId: string
}

export interface CutOverrides {
  removed: Range[]
  added: Range[]
  angles: CameraSeg[]
}

export const EMPTY_OVERRIDES: CutOverrides = { removed: [], added: [], angles: [] }

const EPS = 0.02

/** 区間を並べ、重なり・つながりをまとめる */
export function unionRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter((r) => r.end - r.start > EPS).sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + EPS) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/** `a` から `b` を差し引いた残り */
export function subtractRanges(a: readonly Range[], b: readonly Range[]): Range[] {
  let pieces = unionRanges(a)
  for (const cut of unionRanges(b))
    pieces = pieces.flatMap((p) =>
      cut.end <= p.start || cut.start >= p.end
        ? [p]
        : [
            ...(cut.start > p.start ? [{ start: p.start, end: cut.start }] : []),
            ...(cut.end < p.end ? [{ start: cut.end, end: p.end }] : [])
          ]
    )
  return pieces.filter((p) => p.end - p.start > EPS)
}

/** タイムラインの本編のクリップ → 共通の時刻の区間とカメラ(同期した素材のクリップだけ) */
export function coverageOfClips(
  clips: readonly { assetId: string; inPoint: number; outPoint: number }[],
  info: MulticamInfo
): CameraSeg[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const out: CameraSeg[] = []
  for (const c of clips) {
    const f = fileOf.get(c.assetId)
    if (!f) continue
    const start = toCommon(f, c.inPoint)
    const end = toCommon(f, c.outPoint)
    if (end - start > EPS) out.push({ start, end, cameraId: f.sourceId })
  }
  return out
}

/**
 * 今の本編のクリップから、タイムラインの時刻 ↔ 共通の時刻 の対応を作る(仮編集の `spans` と同じ形)。
 * 作り直した直後の対応を覚えて使うと、元に戻す・手で詰めたあとに古い対応で置いてしまう
 */
export function spansOfClips(
  clips: readonly { assetId: string; inPoint: number; outPoint: number; speed?: number }[],
  info: MulticamInfo
): { timeline: number; start: number; end: number }[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const out: { timeline: number; start: number; end: number }[] = []
  let cursor = 0
  for (const c of clips) {
    const f = fileOf.get(c.assetId)
    if (f) {
      const start = toCommon(f, c.inPoint)
      const end = toCommon(f, c.outPoint)
      if (end - start > EPS) out.push({ timeline: cursor, start, end })
    }
    cursor += Math.max(0, c.outPoint - c.inPoint) / (c.speed || 1)
  }
  return out
}

/** 前に自動で組んだ本編(`auto`)と今の本編(`current`)を比べ、人の判断を読み取って前の判断に重ねる */
export function updateOverrides(
  previous: CutOverrides | undefined,
  auto: readonly CameraSeg[],
  current: readonly CameraSeg[]
): CutOverrides {
  const prev = previous ?? EMPTY_OVERRIDES
  const removedNow = subtractRanges(auto, current)
  const addedNow = subtractRanges(current, auto)
  // 同じ時間を別のカメラで映している所(足した区間はカメラも人が決めたものとして覚える)
  const anglesNow: CameraSeg[] = []
  for (const c of current) {
    const sameTime = auto.filter((a) => a.end > c.start + EPS && a.start < c.end - EPS)
    for (const a of sameTime) {
      if (a.cameraId === c.cameraId) continue
      const start = Math.max(a.start, c.start)
      const end = Math.min(a.end, c.end)
      if (end - start > EPS) anglesNow.push({ start, end, cameraId: c.cameraId })
    }
  }
  for (const r of addedNow)
    for (const c of current) {
      const start = Math.max(r.start, c.start)
      const end = Math.min(r.end, c.end)
      if (end - start > EPS) anglesNow.push({ start, end, cameraId: c.cameraId })
    }

  const removed = unionRanges([...subtractRanges(prev.removed, addedNow), ...removedNow])
  const added = unionRanges([...subtractRanges(prev.added, removedNow), ...addedNow])
  // 新しいカメラの判断が、同じ時間の前の判断に勝つ。削った時間の判断は捨てる
  const decided = unionRanges([...anglesNow, ...removedNow])
  const kept = prev.angles.flatMap((a) =>
    subtractRanges([a], decided).map((r) => ({ ...r, cameraId: a.cameraId }))
  )
  const angles = [...kept, ...anglesNow].sort((a, b) => a.start - b.start)
  return { removed, added, angles }
}

export function hasOverrides(o: CutOverrides | undefined): boolean {
  return Boolean(o && (o.removed.length || o.added.length || o.angles.length))
}

/** カットした区間に、人が削った区間・足した区間を当てる(足した区間は詰めずにそのまま残す) */
export function applyCutOverrides(pieces: readonly CutRange[], o: CutOverrides): CutRange[] {
  // 削った区間は1回だけまとめて並べ、頭で引く(区間ごとに全部を並べ直すと、2,000 × 2,000 で1秒かかっていた)
  const removed = unionRanges(o.removed)
  const starts = removed.map((r) => r.start)
  const firstEndingAfter = (t: number): number => {
    let lo = 0
    let hi = removed.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (removed[m].end <= t) lo = m + 1
      else hi = m
    }
    return lo
  }
  const kept: CutRange[] = pieces.flatMap((p) => {
    const from = firstEndingAfter(p.start)
    let to = from
    while (to < starts.length && starts[to] < p.end) to++
    return subtractRanges([p], removed.slice(from, to)).map((r) => ({ ...r, sceneId: p.sceneId }))
  })
  const add = subtractRanges(o.added, kept)
  return [...kept, ...add.map((r) => ({ ...r }))].sort((a, b) => a.start - b.start)
}

/** ショットに、人が替えたカメラを当てる(そのカメラが録っていない時間には当てない) */
export function applyAngleOverrides(
  shots: readonly Shot[],
  angles: readonly CameraSeg[],
  info: MulticamInfo
): Shot[] {
  let out: Shot[] = [...shots]
  for (const a of angles) {
    const next: Shot[] = []
    for (const s of out) {
      const start = Math.max(s.start, a.start)
      const end = Math.min(s.end, a.end)
      // 頭と終わりだけでなく途中も録っているか(録画を止めた間に掛かれば当てない)。
      // 分割ファイルのつなぎ目のごく短い隙間は続いているとみなす
      const covered = end - start > EPS && coversRange(info, a.cameraId, start, end)
      if (!covered || s.cameraId === a.cameraId) {
        next.push(s)
        continue
      }
      if (start > s.start + EPS) next.push({ ...s, end: start })
      next.push({ start, end, cameraId: a.cameraId, reason: 'manual' })
      if (end < s.end - EPS) next.push({ ...s, start: end })
    }
    out = next
  }
  return out
}

/**
 * 本編の1クリップを、同じ時間の別のカメラに替えるときの候補。
 * そのカメラがクリップの時間を全部録っていれば `clip` に置き換え後の値を入れる。
 */
export interface AngleClip {
  assetId: string
  inPoint: number
  outPoint: number
  speed: number
}

export function angleAlternatives(
  clip: { assetId: string; inPoint: number; outPoint: number },
  info: MulticamInfo
): {
  sourceId: string
  name: string
  current: boolean
  /** 1つのファイルで録っているときの替えた値 */
  clip?: AngleClip
  /**
   * 替えた値(ファイルの境目で分かれる)。録っていなければ無い。
   * 1つのファイルで見ていたので、ファイルが分かれて録られたカメラ(長回しの分割)は
   * 「この時間は録っていません」になっていた
   */
  clips?: AngleClip[]
}[] {
  const f = info.files.find((x) => x.assetId === clip.assetId)
  if (!f) return []
  const start = toCommon(f, clip.inPoint)
  const end = toCommon(f, clip.outPoint)
  return info.sources
    .filter((s) => s.kind === 'camera')
    .map((s) => {
      if (s.id === f.sourceId) return { sourceId: s.id, name: s.name, current: true }
      const clips = coversRange(info, s.id, start, end) ? anglePieces(info, s.id, start, end) : []
      return {
        sourceId: s.id,
        name: s.name,
        current: false,
        ...(clips.length > 0 ? { clips } : {}),
        ...(clips.length === 1 ? { clip: clips[0] } : {})
      }
    })
}

/** 共通の時刻 [start, end) を、そのカメラのファイルごとに分けた素材の時刻(短い隙間は前のファイルを延ばす) */
function anglePieces(
  info: MulticamInfo,
  sourceId: string,
  start: number,
  end: number
): AngleClip[] {
  const out: AngleClip[] = []
  let t = start
  /** 録っていない短い隙間の合計(ファイルに余りのあるクリップを延ばして長さを保つ) */
  let leadGap = 0
  while (t < end - 1e-6) {
    const g = fileAt(info, sourceId, t)
    if (!g) {
      // 録っていない短い隙間(`coversRange` が許す分)は、前のファイルを延ばして埋める
      const nextStart = info.files
        .filter((x) => x.sourceId === sourceId && x.start > t)
        .reduce((m, x) => Math.min(m, x.start), Infinity)
      const to = Math.min(end, nextStart)
      if (!Number.isFinite(to)) return []
      // 隙間の分は、あとでファイルに余りのあるクリップを延ばして埋める(前のファイルを延ばすと、
      // ファイルの終わりより先を指していた)
      leadGap += to - t
      t = to
      continue
    }
    const to = Math.min(end, g.start + g.duration / g.rate)
    out.push({
      assetId: g.assetId,
      // 素材の頭の丸めの残り(-5e-7 など)で、素材の外を指さないように
      inPoint: Math.max(0, (t - g.start) * g.rate),
      outPoint: (to - g.start) * g.rate,
      speed: g.rate
    })
    t = to
  }
  // 隙間の分は、ファイルに余りのあるクリップを延ばして長さを保つ(後ろから)。どのファイルにも余りが
  // 無ければ、そのカメラには替えない(ファイルの外を指すクリップを作らない)
  let rest = leadGap
  for (let i = out.length - 1; i >= 0 && rest > 1e-9; i--) {
    const p = out[i]
    const g = info.files.find((x) => x.assetId === p.assetId)
    if (!g) continue
    const room = Math.max(0, (g.duration - p.outPoint) / p.speed)
    const take = Math.min(room, rest)
    p.outPoint += take * p.speed
    rest -= take
  }
  if (rest > 1e-6) return []
  // 最後の切れ端が丸めの残りだけなら前に含める
  return out.filter((p, i) => i === 0 || (p.outPoint - p.inPoint) / p.speed > 1e-3)
}

/**
 * 作り直した本編(`rebuilt`)に、前の本編(`previous`)にあった収録素材以外のクリップを入れ直す。
 * 各クリップは、前の本編で直前にあった収録素材のクリップの終わり(共通の時刻)を目印に、
 * 作り直した本編でその時刻を含む(または直前の)クリップの後ろへ置く。目印が無ければ頭に置く
 */
export function reinsertExtraClips<
  C extends { assetId: string; inPoint: number; outPoint: number }
>(previous: readonly C[], rebuilt: readonly C[], info: MulticamInfo): C[] {
  const fileOf = new Map(info.files.map((f) => [f.assetId, f]))
  const extras: { clip: C; anchor: number }[] = []
  let anchor = -Infinity
  for (const c of previous) {
    const f = fileOf.get(c.assetId)
    if (f) anchor = toCommon(f, c.outPoint)
    else extras.push({ clip: c, anchor })
  }
  if (extras.length === 0) return [...rebuilt]
  // 作り直した本編の各クリップの始まり(共通の時刻)
  const starts = rebuilt.map((c) => {
    const f = fileOf.get(c.assetId)
    return f ? toCommon(f, c.inPoint) : -Infinity
  })
  const out: C[] = []
  const after = new Map<number, C[]>()
  for (const e of extras) {
    // 目印より前に始まる最後のクリップの後ろ(-1 なら頭)
    let idx = -1
    for (let i = 0; i < rebuilt.length; i++) if (starts[i] < e.anchor - EPS) idx = i
    const list = after.get(idx) ?? []
    list.push(e.clip)
    after.set(idx, list)
  }
  out.push(...(after.get(-1) ?? []))
  rebuilt.forEach((c, i) => {
    out.push(c)
    out.push(...(after.get(i) ?? []))
  })
  return out
}

/**
 * 場面を「残す」「落とす」と人がはっきり決めたら、その場面の中の本編の修正(削った・足した区間)より
 * その決定を優先する。残すと決めた場面の中で前に削った区間は戻し、落とすと決めた場面の中で足した区間は外す
 * (でないと、前に手で削った場面は「残す」にしても戻らない)
 */
export function releaseOverridesForScenes(
  o: CutOverrides | undefined,
  scenes: readonly { id: string; start: number; end: number }[],
  keep: Readonly<Record<string, boolean>>
): CutOverrides | undefined {
  if (!o) return o
  const kept = scenes.filter((sc) => keep[sc.id] === true)
  const dropped = scenes.filter((sc) => keep[sc.id] === false)
  if (kept.length === 0 && dropped.length === 0) return o
  return {
    removed: subtractRanges(o.removed, kept),
    added: subtractRanges(o.added, dropped),
    angles: o.angles
  }
}

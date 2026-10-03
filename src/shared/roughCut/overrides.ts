import type { CutRange } from '../cut/tighten'
import type { Shot } from '../angles/choose'
import { fileAt, toCommon, type MulticamInfo } from '../sync/multicam'

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
  const kept: CutRange[] = pieces.flatMap((p) =>
    subtractRanges([p], [...o.removed]).map((r) => ({ ...r, sceneId: p.sceneId }))
  )
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
      const covered =
        end - start > EPS &&
        fileAt(info, a.cameraId, start) !== null &&
        fileAt(info, a.cameraId, end - EPS / 2) !== null
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
export function angleAlternatives(
  clip: { assetId: string; inPoint: number; outPoint: number },
  info: MulticamInfo
): {
  sourceId: string
  name: string
  current: boolean
  clip?: { assetId: string; inPoint: number; outPoint: number; speed: number }
}[] {
  const f = info.files.find((x) => x.assetId === clip.assetId)
  if (!f) return []
  const start = toCommon(f, clip.inPoint)
  const end = toCommon(f, clip.outPoint)
  return info.sources
    .filter((s) => s.kind === 'camera')
    .map((s) => {
      if (s.id === f.sourceId) return { sourceId: s.id, name: s.name, current: true }
      const g = fileAt(info, s.id, start)
      const covers = g && g.start + g.duration / g.rate >= end - 1e-3
      return {
        sourceId: s.id,
        name: s.name,
        current: false,
        ...(g && covers
          ? {
              clip: {
                assetId: g.assetId,
                inPoint: (start - g.start) * g.rate,
                outPoint: (end - g.start) * g.rate,
                speed: g.rate
              }
            }
          : {})
      }
    })
}

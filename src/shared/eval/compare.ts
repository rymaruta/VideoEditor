import type { Fcp7Sequence } from '../import/fcp7'
import {
  coverageOfClips,
  subtractRanges,
  unionRanges,
  type CameraSeg,
  type Range
} from '../roughCut/overrides'
import { toCommon, type MulticamInfo } from '../sync/multicam'
import type { Project } from '../types'

/**
 * 自動編集と、人が仕上げた完成版(Premiere の XML)を比べる(計画書 §7 の評価)。
 * どちらも**共通の時間軸**(基準カメラの時計)に直してから比べる。完成版のクリップは、素材のファイル名で
 * この回の収録素材に結び付ける(Premiere でファイルを置き換えていても、名前が同じなら結び付く)。
 *
 * - 採用区間の一致度(IoU): 両方が残した時間 ÷ どちらかが残した時間
 * - カット点の一致: 人のカット点のうち、自動も ±0.5 秒以内で切っている割合(再現率)と、その逆(適合率)
 * - アングルの一致: 両方が残した時間のうち、同じカメラを映している割合
 */
export interface EditComparison {
  iou: number
  humanSec: number
  autoSec: number
  overlapSec: number
  cutRecall: number
  cutPrecision: number
  angleAgreement: number
  /** 完成版の本編のうち、この回の素材に結び付けられたクリップの数 / 全部の数 */
  matchedClips: number
  totalClips: number
  /** 結び付けられなかったファイル名 */
  unmatchedFiles: string[]
  /**
   * 完成版のうち、選んだカメラが XML から分からなかった時間(秒)。マルチカメラのまま書き出された所で、
   * アングルの一致の計算から外している(採用区間・カット点には使う)
   */
  angleUnknownSec: number
}

export const CUT_TOLERANCE_SEC = 0.5

/** 選んだカメラが分からない区間の印 */
const UNKNOWN_ANGLE = '?'

function total(ranges: readonly Range[]): number {
  return ranges.reduce((t, r) => t + (r.end - r.start), 0)
}

function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  return subtractRanges(a, subtractRanges(a, b))
}

/** カット点(共通の時刻): 区間の切れ目で、時間が飛ぶかカメラが替わる所。最初と最後は数えない */
export function cutPoints(segs: readonly CameraSeg[]): number[] {
  const out: number[] = []
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1]
    const b = segs[i]
    const jump = Math.abs(b.start - a.end) > 0.04
    if (jump) out.push(a.end, b.start)
    else if (a.cameraId !== b.cameraId) out.push(b.start)
  }
  return out
}

function matchRate(from: readonly number[], to: readonly number[], tol: number): number {
  if (from.length === 0) return NaN
  return from.filter((t) => to.some((u) => Math.abs(u - t) <= tol)).length / from.length
}

function cameraAt(segs: readonly CameraSeg[], t: number): string | undefined {
  return segs.find((s) => t >= s.start && t < s.end)?.cameraId
}

/** 完成版の本編(一番下の映像トラック)を、この回の共通の時刻とカメラにする */
export function humanCoverage(
  seq: Fcp7Sequence,
  project: Project,
  info: MulticamInfo
): { segs: CameraSeg[]; matched: number; total: number; unmatched: string[] } {
  const fileByName = new Map<string, (typeof info.files)[number]>()
  for (const f of info.files) {
    const asset = project.assets.find((a) => a.id === f.assetId)
    if (asset) fileByName.set(asset.fileName.toLowerCase(), f)
  }
  const main = [...(seq.video[0] ?? [])].sort((a, b) => a.start - b.start)
  const segs: CameraSeg[] = []
  const unmatched = new Set<string>()
  for (const c of main) {
    const f = fileByName.get(c.fileName.toLowerCase())
    if (!f) {
      unmatched.add(c.fileName)
      continue
    }
    segs.push({
      start: toCommon(f, c.in),
      end: toCommon(f, c.out),
      // カメラが分からない所は、親のクリップごとに別の印(境目がカット点になり、アングルの比較からは外れる)
      cameraId: c.angleUnknown !== undefined ? `${UNKNOWN_ANGLE}${c.angleUnknown}` : f.sourceId
    })
  }
  return { segs, matched: segs.length, total: main.length, unmatched: [...unmatched] }
}

export function compareEdits(
  seq: Fcp7Sequence,
  project: Project,
  info: MulticamInfo,
  tolerance = CUT_TOLERANCE_SEC
): EditComparison {
  const human = humanCoverage(seq, project, info)
  const auto = coverageOfClips(project.clips, info)
  const hU = unionRanges(human.segs)
  const aU = unionRanges(auto)
  const both = intersect(hU, aU)
  const overlap = total(both)
  const union = total(hU) + total(aU) - overlap
  // アングル: 両方が残した時間を 0.1 秒ごとに見る
  let same = 0
  let seen = 0
  let unknown = 0
  for (const r of both)
    for (let t = r.start + 0.05; t < r.end; t += 0.1) {
      const h = cameraAt(human.segs, t)
      if (h?.startsWith(UNKNOWN_ANGLE)) {
        unknown++
        continue
      }
      seen++
      if (h === cameraAt(auto, t)) same++
    }
  const hc = cutPoints(human.segs)
  const ac = cutPoints(auto)
  return {
    iou: union > 0 ? overlap / union : NaN,
    humanSec: total(hU),
    autoSec: total(aU),
    overlapSec: overlap,
    cutRecall: matchRate(hc, ac, tolerance),
    cutPrecision: matchRate(ac, hc, tolerance),
    angleAgreement: seen > 0 ? same / seen : NaN,
    matchedClips: human.matched,
    totalClips: human.total,
    unmatchedFiles: human.unmatched,
    angleUnknownSec: unknown * 0.1
  }
}

import type { Project } from '@shared/types'
import type { Range } from '@shared/roughCut/overrides'
import { clipTimes, type TimelineRange } from '@shared/roughCut/range'
import { autoTelopKey } from '@shared/telop/manual'

/**
 * 範囲の自動編集(選んだ範囲だけを自動で作り直す)の、選べること・確かめに出すもの。
 * 作り直しの計算は `pipelineStore.prepareRangedEdit`(企画は `projectStore.rangedEditProject`)
 */

export interface RangedEditSteps {
  /** カット・間詰め(切れば今の残し方のまま、ほかの工程だけやり直す) */
  cut: boolean
  /** アングル(切れば今のカメラのまま) */
  angles: boolean
  /** 発言テロップ */
  speech: boolean
  /** 演出テロップ(提案から置いたもの) */
  effects: boolean
  /** SE・CG(範囲の中に始まるものを置き直す) */
  se: boolean
  cg: boolean
  /** BGM(既定は本編に付いていかせるだけ。入れると範囲の中を入れ直し、境で1秒フェード) */
  bgm: boolean
}

export interface RangedEditOptions {
  steps: RangedEditSteps
  /** 範囲の長さを保つ(後ろを1フレームも動かさない)。false ならリップル(後ろを詰める・送る) */
  keepLength: boolean
  /** 範囲の中の手直し(削った・足した・替えたカメラ)を残す */
  keepInside: boolean
  /** 終わったら、その範囲を自動編集で触らないようにする(ロック) */
  lockAfter: boolean
}

export const DEFAULT_RANGED_OPTIONS: RangedEditOptions = {
  steps: { cut: true, angles: true, speech: true, effects: true, se: true, cg: true, bgm: false },
  keepLength: false,
  keepInside: false,
  lockAfter: false
}

/** 確かめに出す小さな帯の1本(範囲の頭からの秒) */
export interface StripPiece {
  start: number
  end: number
  kind: 'clip' | 'extra' | 'speed'
}

export interface RangedSummary {
  /** 範囲の長さ(前 → 後) */
  lengthBefore: number
  lengthAfter: number
  /** 本編全体の長さ(前 → 後) */
  totalBefore: number
  totalAfter: number
  /** 範囲の中の本編のクリップの数 */
  cutsBefore: number
  cutsAfter: number
  /** 範囲の中の自動テロップ(発言・演出)の数 */
  telopsBefore: number
  telopsAfter: number
  se: [number, number]
  bgm: [number, number]
  cg: [number, number]
  /** 一緒に動く手置きの数(リップル) */
  movedHand: number
  /** 範囲の中にあって、そのまま残る手置きの数 */
  insideHand: number
  /** 範囲の中の速さを変えたクリップ(作り直すと素材の速さに戻る) */
  speedChanged: number
  /** 範囲の外にある、範囲の中の時刻を映すクリップ(並べ替え・複製)の数 */
  outsideOverlap: number
  /** 手を入れた自動のトラックなので、範囲で置き直さなかった種類 */
  skipped: string[]
  stripBefore: StripPiece[]
  stripAfter: StripPiece[]
}

/** 範囲の自動編集の用意ができたもの(確かめてから当てる) */
export interface RangedPreview {
  /** 用意した時の企画(当てる時に、変わっていないかを確かめる) */
  base: Project
  after: Project
  /** 当てる前・後の本編の範囲(タイムラインの秒) */
  range: TimelineRange
  newRange: TimelineRange
  /** 範囲の共通の時刻の窓 */
  window: Range
  options: RangedEditOptions
  summary: RangedSummary
  /** 範囲の中で残した場面 */
  keptIds: string[]
  /** 範囲に掛かる場面 */
  sceneIds: string[]
  /** 範囲に丸ごと入る場面 */
  fullScenes: string[]
  /** この範囲の自動編集で使った付け直し(取り消しで戻す) */
  usedTouches: string[]
}

export type RangedPrepareResult =
  { ok: true; preview: RangedPreview } | { ok: false; reason: string; needsRipple?: boolean }

/** 範囲の中の時刻のもの(頭が範囲の中) */
const startsIn = (t: number, r: TimelineRange): boolean => t >= r.start - 1e-6 && t < r.end - 1e-6

/** 本編の範囲の中の小さな帯と、クリップの数 */
export function stripOf(project: Project, r: TimelineRange): StripPiece[] {
  const files = new Map((project.multicam?.files ?? []).map((f) => [f.assetId, f]))
  const times = clipTimes(project.clips)
  const out: StripPiece[] = []
  project.clips.forEach((c, i) => {
    const t = times[i]
    const a = Math.max(t.start, r.start)
    const b = Math.min(t.end, r.end)
    if (b - a <= 1e-6) return
    const f = files.get(c.assetId)
    out.push({
      start: a - r.start,
      end: b - r.start,
      kind: !f ? 'extra' : Math.abs((c.speed || 1) - f.rate) > 1e-9 ? 'speed' : 'clip'
    })
  })
  return out
}

function countIn(
  project: Project,
  r: TimelineRange
): { autoTelops: number; se: number; bgm: number; cg: number } {
  const autoTelops = project.textOverlays.filter(
    (o) => autoTelopKey(o) !== null && startsIn((o.startTime + o.endTime) / 2, r)
  ).length
  const role = (k: 'se' | 'bgm'): number =>
    project.audioTracks
      .filter((t) => t.autoRole === k)
      .reduce((n, t) => n + t.clips.filter((c) => startsIn(c.startTime, r)).length, 0)
  const cg = project.videoOverlayTracks
    .filter((t) => t.autoRole === 'cg')
    .reduce((n, t) => n + t.clips.filter((c) => startsIn(c.startTime, r)).length, 0)
  return { autoTelops, se: role('se'), bgm: role('bgm'), cg }
}

/** 本編の長さ */
export function mainLength(project: Pick<Project, 'clips'>): number {
  const t = clipTimes(project.clips)
  return t.length > 0 ? t[t.length - 1].end : 0
}

/** 当てる前と後の違いを数える */
export function summarizeRangedEdit(
  base: Project,
  after: Project,
  range: TimelineRange,
  newRange: TimelineRange,
  extra: Pick<
    RangedSummary,
    'movedHand' | 'insideHand' | 'speedChanged' | 'outsideOverlap' | 'skipped'
  >
): RangedSummary {
  const b = countIn(base, range)
  const a = countIn(after, newRange)
  const stripBefore = stripOf(base, range)
  const stripAfter = stripOf(after, newRange)
  return {
    lengthBefore: range.end - range.start,
    lengthAfter: newRange.end - newRange.start,
    totalBefore: mainLength(base),
    totalAfter: mainLength(after),
    cutsBefore: stripBefore.length,
    cutsAfter: stripAfter.length,
    telopsBefore: b.autoTelops,
    telopsAfter: a.autoTelops,
    se: [b.se, a.se],
    bgm: [b.bgm, a.bgm],
    cg: [b.cg, a.cg],
    stripBefore,
    stripAfter,
    ...extra
  }
}

/** 範囲の自動編集・ロックが使えない理由(使えれば null) */
export function rangedEditBlockedReason(
  project: Pick<Project, 'multicam' | 'clips'>,
  pipeline: { scenes: readonly unknown[]; restored: { legacy: boolean } | null; running: boolean }
): string | null {
  if (!project.multicam)
    return '同期した収録素材の企画で使えます(「新しい回を作る」で取り込んだ企画)'
  if (pipeline.scenes.length === 0)
    return '自動編集で場面に分けた後に使えます(自動編集の画面で構成まで進めてください)'
  if (pipeline.restored?.legacy)
    return '前の版で保存した企画です。自動編集の画面で一度「仮編集を作り直す」をしてから使えます'
  if (pipeline.running) return '自動編集が動いている間は使えません'
  if (project.clips.length === 0) return '本編にクリップがありません'
  return null
}

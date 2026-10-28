import { coverageOfClips } from '@shared/roughCut/overrides'
import type { Scene, SceneJudgement, SceneKind } from '@shared/structure/scenes'
import type { Clip, Project } from '@shared/types'

/**
 * インスペクタの「AI の判断」: 選んだ本編のクリップについて、自動編集がなぜそうしたかを
 * **今あるデータから**まとめる(新しく推測はしない)。
 *
 * - 場面: クリップが映している収録の時刻に重なる場面と、その判定(点数・種類・理由)
 * - 手の判断: 画面で「残す / 落とす」を決めた場面、手で替えたカメラ・足した区間、ロックの範囲
 * - カメラ: いま映しているカメラ(誰を映すカメラか)
 *
 * 同期した収録素材の企画でないクリップ(素材を手で並べた企画)には判断が無いので null。
 */

export const SCENE_KIND_LABEL: Record<SceneKind, string> = {
  highlight: '見どころ',
  normal: '普通',
  unneeded: '不要'
}

export interface SceneDecision {
  id: string
  title?: string
  kind: SceneKind | null
  score: number | null
  reason: string | null
  /** 画面で手で決めた「残す / 落とす」(決めていなければ undefined) */
  keep: boolean | undefined
  /** クリップと重なっている長さ(秒、収録の時刻) */
  overlap: number
}

export interface ClipDecision {
  scenes: SceneDecision[]
  camera: { name: string; subject?: string } | null
  /** 手でカメラを替えた区間に重なる */
  manualAngle: boolean
  /** 手で足した区間に重なる */
  manualAdded: boolean
  /** 自動編集で触らない範囲(ロック)に重なる */
  locked: boolean
  /** 判定が AI か簡易の点数か */
  judgeSource: 'ai' | 'heuristic' | null
}

const overlapOf = (a: { start: number; end: number }, b: { start: number; end: number }): number =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))

export function decisionForClip(
  clip: Pick<Clip, 'assetId' | 'inPoint' | 'outPoint'>,
  project: Pick<Project, 'multicam' | 'cutOverrides' | 'autoEditLocks' | 'roughCutAuto'>,
  analysis: {
    scenes: readonly Scene[]
    judgements: readonly SceneJudgement[]
    keep: Readonly<Record<string, boolean>>
    judgeSource: 'ai' | 'heuristic' | null
  }
): ClipDecision | null {
  const info = project.multicam
  if (!info) return null
  const segs = coverageOfClips([clip], info)
  if (segs.length === 0) return null
  const span = { start: segs[0].start, end: segs[segs.length - 1].end }
  const judgementOf = new Map(analysis.judgements.map((j) => [j.sceneId, j]))
  const scenes: SceneDecision[] = analysis.scenes
    .map((sc) => ({ sc, overlap: overlapOf(sc, span) }))
    .filter((x) => x.overlap > 0.02)
    .map(({ sc, overlap }) => {
      const j = judgementOf.get(sc.id)
      return {
        id: sc.id,
        title: j?.title,
        kind: j?.kind ?? null,
        score: j ? j.score : null,
        reason: j?.reason ?? null,
        keep: analysis.keep[sc.id],
        overlap
      }
    })
  const source = info.sources.find((s) => s.id === segs[0].cameraId)
  // 手の判断は今の本編のクリップから読む: 前に自動で組んだ本編(`roughCutAuto`)と比べ、
  // 同じ時間を別のカメラで組んでいたら「替えた」、自動で組んだ所の外なら「足した」。
  // 古い企画で自動の記録が無ければ、覚えている人の修正(`cutOverrides`)で見る
  const auto = project.roughCutAuto
  const ov = project.cutOverrides
  const camera = segs[0].cameraId
  const autoOverlap = auto
    ? segs.reduce((sum, seg) => sum + auto.reduce((x, a) => x + overlapOf(a, seg), 0), 0)
    : 0
  const clipLength = segs.reduce((sum, seg) => sum + (seg.end - seg.start), 0)
  return {
    scenes,
    camera: source ? { name: source.name, subject: source.subject } : null,
    manualAngle: auto
      ? auto.some((a) => a.cameraId !== camera && segs.some((seg) => overlapOf(a, seg) > 0.02))
      : Boolean(ov?.angles.some((a) => a.cameraId === camera && overlapOf(a, span) > 0.02)),
    manualAdded: auto
      ? clipLength - autoOverlap > 0.02
      : Boolean(ov?.added.some((a) => overlapOf(a, span) > 0.02)),
    locked: Boolean(project.autoEditLocks?.some((l) => overlapOf(l, span) > 0.02)),
    judgeSource: analysis.judgeSource
  }
}

/** カメラの呼び名(「カメラ C(手元)」の形。名前がもう「カメラ」で始まれば足さない) */
export function cameraLabel(name: string, subject?: string): string {
  const n = name.trim()
  const base = /^カメラ/.test(n) ? n : `カメラ ${n}`
  return subject ? `${base}(${subject})` : base
}

/**
 * 判定の理由の文(「発話 49% · 掛け合い 7回/分 · 声の重なり 1」)を、数の表(名前と値)と残りの文に分ける。
 * AI の理由(ふつうの文)は表にせず、そのまま残りの文にする
 */
export function reasonStats(reason: string | null | undefined): {
  stats: [string, string][]
  rest: string[]
} {
  const stats: [string, string][] = []
  const rest: string[] = []
  for (const part of (reason ?? '').split(/\s*·\s*/)) {
    const t = part.trim()
    if (!t) continue
    const m = t.match(/^(\S+?)\s+(\d[\d.,]*\s*(?:%|回\/分|秒|回)?)$/)
    if (m) stats.push([m[1], m[2]])
    else rest.push(t)
  }
  return { stats, rest }
}

/** 理由の表の値(数)を取り出す(無ければ null) */
function statValue(stats: readonly [string, string][], name: string): number | null {
  const hit = stats.find(([k]) => k === name)
  if (!hit) return null
  const v = parseFloat(hit[1])
  return Number.isFinite(v) ? v : null
}

/** いちばん長く重なる場面 */
export function mainScene(d: ClipDecision): SceneDecision | null {
  return [...d.scenes].sort((a, b) => b.overlap - a.overlap)[0] ?? null
}

/**
 * AI の判断の 1 行目: 結論の文(例「掛け合いが多く盛り上がる場面なので残しました」)。
 * いちばん長く重なる場面の判定・手の判断・理由の数から作る(新しく推測はしない)
 */
export function decisionConclusion(d: ClipDecision): string {
  const main = mainScene(d)
  if (!main) {
    if (d.manualAdded) return '手で足した所なので、そのまま残しています'
    return 'この所に重なる場面の判定はありません'
  }
  if (main.keep === true) return '画面で「残す」に決めた場面なので残しました'
  if (main.keep === false) return '画面で「落とす」に決めた場面ですが、この所は本編に残っています'
  const { stats } = reasonStats(main.reason)
  const turns = statValue(stats, '掛け合い')
  const laughs = (statValue(stats, '笑い') ?? 0) + (statValue(stats, '歓声') ?? 0)
  switch (main.kind) {
    case 'highlight':
      if (laughs > 0) return '笑いや歓声が起きた見どころの場面なので残しました'
      if (turns !== null && turns >= 6) return '掛け合いが多く盛り上がる場面なので残しました'
      return '見どころと判定した場面なので残しました'
    case 'normal':
      return '普通の場面として残しました(尺を詰めるときは先に削る候補です)'
    case 'unneeded':
      return '会話の少ない場面ですが、つなぎとして残っています'
    default:
      return '判定の記録がある場面です'
  }
}

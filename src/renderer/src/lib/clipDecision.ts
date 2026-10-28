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
  project: Pick<Project, 'multicam' | 'cutOverrides' | 'autoEditLocks'>,
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
  const ov = project.cutOverrides
  return {
    scenes,
    camera: source ? { name: source.name, subject: source.subject } : null,
    manualAngle: Boolean(
      ov?.angles.some((a) => a.cameraId === segs[0].cameraId && overlapOf(a, span) > 0.02)
    ),
    manualAdded: Boolean(ov?.added.some((a) => overlapOf(a, span) > 0.02)),
    locked: Boolean(project.autoEditLocks?.some((l) => overlapOf(l, span) > 0.02)),
    judgeSource: analysis.judgeSource
  }
}

import { useMemo } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { useProjectStore } from '../store/projectStore'
import { useQcStore } from '../store/qcStore'
import { buildReviewItems, type ReviewItem } from './reviewItems'
import { timelineRangeOf } from '@shared/finish/sound'
import { spansOfClips } from '@shared/roughCut/overrides'
import type { Project } from '@shared/types'

/**
 * 素材が今のタイムラインで最初に映る時刻。同期の位置(共通の時刻)は、仮編集で場面を
 * 削るとタイムラインの時刻と食い違うので、今の本編のクリップから換算する。
 * 仮編集の前(同期の並びのまま)も同じ換算で合う。本編に残っていなければ undefined
 */
function timelineStartOf(project: Project, path: string | undefined): number | undefined {
  const info = project.multicam
  if (!info || !path) return undefined
  const asset = project.assets.find((a) => a.filePath === path || a.denoisedFrom === path)
  const f = asset && info.files.find((x) => x.assetId === asset.id)
  if (!f) return undefined
  const range = timelineRangeOf(
    spansOfClips(project.clips, info),
    f.start,
    f.start + f.duration / f.rate
  )
  return range?.start
}

function baseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path
}

/** 要確認の一覧(自動編集の画面と、画面の下のバーで同じものを使う) */
export function useReviewItems(): { open: ReviewItem[]; done: ReviewItem[] } {
  const project = useProjectStore((s) => s.project)
  const report = usePipelineStore((s) => s.report)
  const sources = usePipelineStore((s) => s.sources)
  const syncedFiles = usePipelineStore((s) => s.syncedFiles)
  const telopReviews = usePipelineStore((s) => s.telopReviews)
  const colorIssues = usePipelineStore((s) => s.colorIssues)
  const denoiseFailures = usePipelineStore((s) => s.denoiseFailures)
  const effects = usePipelineStore((s) => s.effects)
  const effectChosen = usePipelineStore((s) => s.effectChosen)
  const qc = useQcStore((s) => s.report)

  return useMemo(() => {
    const sourceOf = new Map(syncedFiles.map((f) => [f.id, f.sourceId]))
    const pathOf = new Map(syncedFiles.map((f) => [f.id, f.path]))
    const placeOf = new Map((report?.placements ?? []).map((p) => [p.id, p]))
    const items = buildReviewItems({
      project,
      syncIssues: report?.issues ?? [],
      fileLabel: (id) =>
        `${sources.find((s) => s.id === sourceOf.get(id))?.name ?? ''} ${baseName(pathOf.get(id) ?? id)}`.trim(),
      placedStart: (id) =>
        project.multicam ? timelineStartOf(project, pathOf.get(id)) : placeOf.get(id)?.start,
      telopReviews,
      colorIssues,
      denoiseFailures,
      effects,
      effectChosen,
      qc
    })
    const done = new Set(project.reviewed ?? [])
    return {
      open: items.filter((i) => !done.has(i.key)),
      done: items.filter((i) => done.has(i.key))
    }
  }, [
    project,
    report,
    sources,
    syncedFiles,
    telopReviews,
    colorIssues,
    denoiseFailures,
    effects,
    effectChosen,
    qc
  ])
}

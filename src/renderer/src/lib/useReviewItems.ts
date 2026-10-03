import { useMemo } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { useProjectStore } from '../store/projectStore'
import { useQcStore } from '../store/qcStore'
import { buildReviewItems, type ReviewItem } from './reviewItems'

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
      placedStart: (id) => placeOf.get(id)?.start,
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

import { useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'
import { makeLightProxies, QUALITY_CHOICES, useProgramView, ZOOM_CHOICES } from '../lib/programView'
import { OverflowMenu } from './OverflowMenu'
import { CheckIcon } from './icons'

/** 選んでいる方の印(選んでいない方は同じ幅の空き) */
function mark(on: boolean): React.ReactNode {
  return on ? (
    <CheckIcon width={12} height={12} />
  ) : (
    <span className="ve-menu-check-space" aria-hidden="true" />
  )
}

/** プログラムの見出しの右: 「全体を表示 ▾」(表示の大きさ)と「画質 ▾」(プレビューの画質) */
export function ProgramHeadMenus(): React.JSX.Element {
  const zoom = useProgramView((s) => s.zoom)
  const setZoom = useProgramView((s) => s.setZoom)
  const quality = useProgramView((s) => s.quality)
  const setQuality = useProgramView((s) => s.setQuality)
  const progress = useProgramView((s) => s.lightProgress)
  const lightError = useProgramView((s) => s.lightError)
  // 画質「軽い」のまま開いた企画・あとから足した素材も、軽い版を作る
  const assets = useProjectStore((s) => s.project.assets)
  useEffect(() => {
    if (quality === 'light' && !useProgramView.getState().lightProgress)
      void makeLightProxies(assets)
  }, [quality, assets])
  const zoomLabel = ZOOM_CHOICES.find((z) => z.id === zoom)?.label ?? '全体を表示'
  const qualityLabel = QUALITY_CHOICES.find((q) => q.id === quality)?.label ?? '最高'
  return (
    <div className="ve-program-head-menus">
      {progress && (
        <span className="ve-program-head-note" role="status">
          軽い版を作成中… {progress.done}/{progress.total}
        </span>
      )}
      {!progress && lightError && (
        <span className="ve-program-head-note" role="status" title={lightError}>
          {lightError}
        </span>
      )}
      <OverflowMenu
        label={zoomLabel}
        menuLabel="プログラムの表示の大きさ"
        className="ve-program-head-menu"
        actions={ZOOM_CHOICES.map((z) => ({
          key: String(z.id),
          label: z.label,
          icon: mark(zoom === z.id),
          title:
            z.id === 'fit'
              ? '枠に収めて全体を表示'
              : `企画の画の実寸の ${z.label} で表示(収まらない分は送って見る)`,
          onSelect: () => setZoom(z.id)
        }))}
      />
      <OverflowMenu
        label={`画質: ${qualityLabel}`}
        menuLabel="プレビューの画質"
        className="ve-program-head-menu"
        actions={QUALITY_CHOICES.map((q) => ({
          key: q.id,
          label: q.label,
          icon: mark(quality === q.id),
          title: q.title,
          onSelect: () => void setQuality(q.id, useProjectStore.getState().project.assets)
        }))}
      />
    </div>
  )
}

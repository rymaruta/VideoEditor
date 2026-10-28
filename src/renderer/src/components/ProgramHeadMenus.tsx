import { useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'
import { makeLightProxies, QUALITY_CHOICES, useProgramView, ZOOM_CHOICES } from '../lib/programView'
import { OverflowMenu, type OverflowAction } from './OverflowMenu'
import { CheckIcon } from './icons'

/** 選んでいる方の印(選んでいない方は同じ幅の空き) */
function mark(on: boolean): React.ReactNode {
  return on ? (
    <CheckIcon width={12} height={12} />
  ) : (
    <span className="ve-menu-check-space" aria-hidden="true" />
  )
}

const currentAssets = (): ReturnType<typeof useProjectStore.getState>['project']['assets'] =>
  useProjectStore.getState().project.assets

/**
 * プログラムの見出しの右: 「全体を表示 ▾」(表示の大きさ)と「再生の解像度 ▾」(最高 / 軽い 540p)。
 * 軽い版を作っている途中の様子は、メニューの中(と素材のタイルの進み具合の帯)に出す
 */
export function ProgramHeadMenus(): React.JSX.Element {
  const zoom = useProgramView((s) => s.zoom)
  const setZoom = useProgramView((s) => s.setZoom)
  const quality = useProgramView((s) => s.quality)
  const setQuality = useProgramView((s) => s.setQuality)
  const progress = useProgramView((s) => s.lightProgress)
  const lightError = useProgramView((s) => s.lightError)
  // 「軽い」のまま開いた企画・あとから足した素材も、軽い版を作る(作っている途中なら残りを足して続ける)
  const assets = useProjectStore((s) => s.project.assets)
  useEffect(() => {
    if (quality === 'light') void makeLightProxies(currentAssets)
  }, [quality, assets])
  const zoomLabel = ZOOM_CHOICES.find((z) => z.id === zoom)?.label ?? '全体を表示'
  const qualityLabel = QUALITY_CHOICES.find((q) => q.id === quality)?.label ?? '最高'
  const status: OverflowAction[] = progress
    ? [
        {
          key: 'progress',
          label: `軽い版を作成中… ${progress.done}/${progress.total}`,
          disabled: true,
          onSelect: () => {}
        }
      ]
    : lightError
      ? [{ key: 'error', label: lightError, disabled: true, onSelect: () => {} }]
      : []
  return (
    <div className="ve-program-head-menus">
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
        label={`再生の解像度: ${qualityLabel}`}
        menuLabel="再生の解像度"
        className={`ve-program-head-menu ${progress ? 'is-busy' : ''}`}
        actions={[
          ...QUALITY_CHOICES.map((q) => ({
            key: q.id,
            label: q.label,
            icon: mark(quality === q.id),
            title: q.title,
            onSelect: () => setQuality(q.id)
          })),
          ...status
        ]}
      />
    </div>
  )
}

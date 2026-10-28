import { useSettingsStore } from '../store/settingsStore'
import { targetResolution } from '@shared/resolution'
import { useProjectStore } from '../store/projectStore'
import { ProjectMenu } from './ProjectMenu'
import { useAutoEditRunStore } from '../store/autoEditRunStore'

/**
 * 画面の一番下のステータスバー。出すのは「縦横比・解像度」「書き出しの方式」と、保存・失敗・処理中の
 * 知らせだけ(企画名と未保存の印は上の帯、クリップとテロップの数はタイムラインの帯、要確認の数は
 * 上の帯の「確認」にある。同じものを 2 か所に出さない)。操作のボタンは置かない。
 */
export function StatusBar(): React.JSX.Element {
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const resolution = useSettingsStore((s) => s.exportResolutionHeight)
  const engine = useSettingsStore((s) => s.exportEngine)
  // 全自動編集は画面を閉じても走り続けるので、走っていることをここに出す(開き直しはメニューから)
  const autoEditRunning = useAutoEditRunStore(
    (s) => s.status === 'running' || s.finishingId !== null
  )
  const { w, h } = targetResolution(aspectRatio, resolution)
  return (
    <footer className="status-bar">
      {/* 保存・読み込みの失敗の知らせ(閉じるまで出す) */}
      <ProjectMenu />
      {autoEditRunning && <span className="status-busy">AIおまかせ全自動編集: 生成中…</span>}
      <span className="status-spacer" />
      <span>
        {aspectRatio} · {w}×{h}
      </span>
      <span>書き出し: {engine === 'segmented' ? '長尺向け(区間並列)' : '標準'}</span>
    </footer>
  )
}

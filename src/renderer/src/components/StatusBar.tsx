import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { targetResolution } from '@shared/resolution'
import { ProjectMenu } from './ProjectMenu'
import { useAutoEditRunStore } from '../store/autoEditRunStore'
import { ProjectNameField } from './ProjectNameField'
import { usePipelineStore } from '../store/pipelineStore'
import { useReviewItems } from '../lib/useReviewItems'

/**
 * 画面の一番下のステータスバー(Windows の編集ソフトと同じ位置)。
 * プロジェクト名(クリックで変更)・保存の状態・失敗の知らせ・企画の規模・画角と書き出しの設定を出す。
 * 操作のボタンは置かない(操作はメニューバーとパネルにある)。
 */
export function StatusBar(): React.JSX.Element {
  const isDirty = useProjectStore((s) => s.isDirty)
  const clipCount = useProjectStore((s) => s.project.clips.length)
  const telopCount = useProjectStore((s) => s.project.textOverlays.length)
  const aspectRatio = useProjectStore((s) => s.project.aspectRatio)
  const resolution = useSettingsStore((s) => s.exportResolutionHeight)
  const engine = useSettingsStore((s) => s.exportEngine)
  // 全自動編集は画面を閉じても走り続けるので、走っていることをここに出す(開き直しはメニューから)
  const autoEditRunning = useAutoEditRunStore(
    (s) => s.status === 'running' || s.finishingId !== null
  )
  const { w, h } = targetResolution(aspectRatio, resolution)
  // 自動編集の要確認(自信の低い箇所)。押すと自動編集の画面の一覧を開く
  const reviewCount = useReviewItems().open.length
  return (
    <footer className="status-bar">
      <ProjectNameField />
      <span className={`status-save ${isDirty ? 'dirty' : ''}`}>
        {isDirty ? '未保存の変更あり' : '保存済み'}
      </span>
      <ProjectMenu />
      {autoEditRunning && <span className="status-busy">AIおまかせ全自動編集: 生成中…</span>}
      <span className="status-spacer" />
      {reviewCount > 0 && (
        <button
          className="status-review"
          title="自動編集で自信の低かった箇所の一覧を開く"
          onClick={() => usePipelineStore.getState().setScreenOpen(true)}
        >
          要確認 {reviewCount.toLocaleString()}
        </button>
      )}
      <span>
        クリップ {clipCount.toLocaleString()} · テロップ {telopCount.toLocaleString()}
      </span>
      <span>
        {aspectRatio} · {w}×{h}
      </span>
      <span>書き出し: {engine === 'segmented' ? '長尺向け(区間並列)' : '標準'}</span>
    </footer>
  )
}

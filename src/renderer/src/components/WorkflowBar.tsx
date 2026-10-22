import { useProjectStore } from '../store/projectStore'
import { emitMenuCommand } from '../lib/menuCommands'
import { useReviewItems } from '../lib/useReviewItems'

/**
 * 画面上部の帯(Graphite 2 のヘッダー)。作業の流れを左から右へ並べ、今いる所に印を付ける。
 *
 * 入口は**今のアプリにある画面・操作**だけにつなぐ(無い画面への入口は作らない):
 * - 自動編集 / 確認 → 自動編集の画面(メニューの「自動編集の画面」と同じ)。確認の件数は
 *   ステータスバーの「要確認」と同じ数
 * - 編集 → この画面(上段左のパネルをインスペクタへ戻す)
 * - テロップ → 上段左のパネルをテロップへ(メニューの「ウィンドウ > テキスト」と同じ)
 * - 書き出し → 書き出しの窓(メニューの「書き出し…」と同じ)
 * ショートの画面はまだ無いので並べない。
 */
export function WorkflowBar({
  telopOpen,
  onEdit,
  onTelop
}: {
  /** 上段左のパネルがテロップを出しているか */
  telopOpen: boolean
  onEdit: () => void
  onTelop: () => void
}): React.JSX.Element {
  const projectName = useProjectStore((s) => s.project.name)
  const isDirty = useProjectStore((s) => s.isDirty)
  const reviewCount = useReviewItems().open.length
  const openAutoEdit = (): void => emitMenuCommand('auto.screen')
  const openExport = (): void => emitMenuCommand('file.export')
  return (
    <header className="workflow-bar">
      <div className="workflow-bar-project">
        <svg
          className="workflow-bar-logo"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <rect
            x="2.5"
            y="4.5"
            width="19"
            height="15"
            rx="3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <circle cx="17.5" cy="8.5" r="1.6" fill="currentColor" />
          <path d="M9.5 9.2v5.6l4.6-2.8z" fill="var(--ve-text)" />
        </svg>
        <span className="workflow-bar-name" title={projectName}>
          {projectName}
        </span>
        {isDirty && <span className="dirty-dot" aria-label="未保存の変更あり" />}
      </div>
      <nav className="workflow-steps" aria-label="作業の流れ">
        <button type="button" className="workflow-step" onClick={openAutoEdit}>
          自動編集
        </button>
        <button type="button" className="workflow-step" onClick={openAutoEdit}>
          確認
          {reviewCount > 0 && (
            <span className="workflow-step-count">{reviewCount.toLocaleString()}</span>
          )}
        </button>
        <button
          type="button"
          className={`workflow-step ${telopOpen ? '' : 'current'}`}
          aria-current={telopOpen ? undefined : 'page'}
          onClick={onEdit}
        >
          {!telopOpen && <span className="workflow-step-dot" aria-hidden="true" />}
          編集
        </button>
        <button
          type="button"
          className={`workflow-step ${telopOpen ? 'current' : ''}`}
          aria-current={telopOpen ? 'page' : undefined}
          onClick={onTelop}
        >
          {telopOpen && <span className="workflow-step-dot" aria-hidden="true" />}
          テロップ
        </button>
        <button type="button" className="workflow-step" onClick={openExport}>
          書き出し
        </button>
      </nav>
      <div className="workflow-bar-actions">
        <button type="button" className="primary-button workflow-export" onClick={openExport}>
          書き出す
          <span className="workflow-export-key tc">Ctrl+M</span>
        </button>
      </div>
    </header>
  )
}

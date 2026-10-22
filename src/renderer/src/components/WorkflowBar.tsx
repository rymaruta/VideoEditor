import { useProjectStore } from '../store/projectStore'
import { emitMenuCommand } from '../lib/menuCommands'
import { useReviewItems } from '../lib/useReviewItems'
import { isModalOpen, isTypingTarget } from '../lib/useKeyboardShortcuts'
import { modifierLabel, performUndoRedo } from '../lib/undoAction'
import { useModalOpen } from '../lib/useModalOpen'
import { RedoIcon, UndoIcon, UploadIcon } from './icons'

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
  const canUndo = useProjectStore((s) => s.past.length > 0)
  const canRedo = useProjectStore((s) => s.future.length > 0)
  // メニューの「元に戻す / やり直す」と同じ: 文字を打っている欄なら欄の取り消し(文字単位)、
  // ダイアログの上では何もしない。ボタンは押してもフォーカスを奪わない(欄にフォーカスを残す)
  const run = (kind: 'undo' | 'redo'): void => {
    const store = useProjectStore.getState()
    performUndoRedo(kind, {
      typing: isTypingTarget(document.activeElement),
      modalOpen: isModalOpen(),
      execCommand: (cmd) => document.execCommand(cmd),
      undo: store.undo,
      redo: store.redo
    })
  }
  const undo = (): void => run('undo')
  const redo = (): void => run('redo')
  const mod = modifierLabel(navigator.userAgent)
  // ダイアログを開いている間は帯ごと inert(Tab でダイアログの裏のボタンに届かない)
  const modalOpen = useModalOpen()
  const openAutoEdit = (): void => emitMenuCommand('auto.screen')
  const openExport = (): void => emitMenuCommand('file.export')
  return (
    <header className="workflow-bar" inert={modalOpen || undefined}>
      <div className="workflow-bar-project">
        <span className="workflow-bar-logo" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24">
            <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
          </svg>
        </span>
        <span className="workflow-bar-name" title={projectName}>
          {projectName}
        </span>
        <span className={`workflow-bar-saved ${isDirty ? 'dirty' : ''}`}>
          <span className="workflow-bar-saved-dot" aria-hidden="true" />
          {isDirty ? '未保存の変更あり' : '保存済み'}
        </span>
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
        <button
          type="button"
          className="icon-button workflow-icon"
          title={`元に戻す (${mod}+Z)`}
          aria-label="元に戻す"
          disabled={!canUndo}
          // 押してもフォーカスを欄に残す(欄の取り消しにするため)
          onMouseDown={(e) => e.preventDefault()}
          onClick={undo}
        >
          <UndoIcon width={16} height={16} />
        </button>
        <button
          type="button"
          className="icon-button workflow-icon"
          title={`やり直す (${mod}+Shift+Z)`}
          aria-label="やり直す"
          disabled={!canRedo}
          // 押してもフォーカスを欄に残す(欄の取り消しにするため)
          onMouseDown={(e) => e.preventDefault()}
          onClick={redo}
        >
          <RedoIcon width={16} height={16} />
        </button>
        <span className="workflow-bar-sep" aria-hidden="true" />
        <button type="button" className="primary-button workflow-export" onClick={openExport}>
          <UploadIcon width={15} height={15} />
          書き出す
          <span className="workflow-export-key tc">{mod}+M</span>
        </button>
      </div>
    </header>
  )
}

import { useEffect, useRef } from 'react'
import { useProjectStore } from '../store/projectStore'
import { emitMenuCommand } from '../lib/menuCommands'
import { useReviewItems } from '../lib/useReviewItems'
import { isModalOpen } from '../lib/useKeyboardShortcuts'
import { modifierLabel, workflowBarUndo } from '../lib/undoAction'
import { useModalOpen } from '../lib/useModalOpen'
import { RedoIcon, UndoIcon, UploadIcon } from './icons'
import { needsMenuButton } from '@shared/windowChrome'
import { createAltTapDetector, menuMnemonicFor } from '../lib/altMenuKey'
import { topMenuMnemonics } from '@shared/appMenu'
import { editorActionFor, getEditorKeymap, getKeymap, matchesBinding } from '../lib/keymap'
import { useSettingsStore } from '../store/settingsStore'
import { usePipelineStore } from '../store/pipelineStore'

/** 動いている OS(preload から。試験・古い preload では空) */
const platform = (typeof window !== 'undefined' && window.api?.platform) || ''

/**
 * 画面上部の帯(Graphite 2 のヘッダー)。作業の流れを左から右へ並べ、今いる所に印を付ける。
 *
 * 入口は**今のアプリにある画面・操作**だけにつなぐ(無い画面への入口は作らない):
 * - 自動編集 → 自動編集の画面(メニューの「自動編集の画面」と同じ)。画面は帯の下に重なる
 * - 確認 → 自動編集の画面の要確認の一覧へ(最初の項目にフォーカス)。件数はステータスバーの「要確認」と同じ数
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
  // 帯のボタンは、フォーカスがどこにあっても**プロジェクト**の取り消し・やり直し
  // (欄の文字単位の取り消しはキーとメニューだけ。選択欄・数値欄にフォーカスがあるまま押すと、
  // 欄の取り消しに回って何も起きなかった)。ダイアログの上では何もしない
  const undo = (): void => {
    const store = useProjectStore.getState()
    workflowBarUndo('undo', { modalOpen: isModalOpen(), undo: store.undo, redo: store.redo })
  }
  const redo = (): void => {
    const store = useProjectStore.getState()
    workflowBarUndo('redo', { modalOpen: isModalOpen(), undo: store.undo, redo: store.redo })
  }
  const mod = modifierLabel(navigator.userAgent)
  // ダイアログを開いている間は帯ごと inert(Tab でダイアログの裏のボタンに届かない)
  const modalOpen = useModalOpen()
  // ダイアログを開いたボタン。閉じたら(inert が外れてから)そこへフォーカスを戻す
  // (inert のままだとダイアログが戻そうとしても戻らず、フォーカスが body に落ちていた)
  const openerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (modalOpen) return
    const opener = openerRef.current
    openerRef.current = null
    if (!opener || !opener.isConnected) return
    const active = document.activeElement
    if (!active || active === document.body) opener.focus()
  }, [modalOpen])
  const remember = (e: React.SyntheticEvent<HTMLElement>): void => {
    openerRef.current = e.currentTarget
  }
  // Windows / Linux は OS のメニューバーを出さない(帯 1 本にまとめる)。同じメニューを帯のボタンから出す
  const showMenuButton = needsMenuButton(platform)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const openMenu = (): void => {
    const b = menuButtonRef.current?.getBoundingClientRect()
    window.api.popupAppMenu(b ? { x: b.left, y: b.bottom + 2 } : { x: 8, y: 46 })
  }
  // Alt を単独で押して離したら、メニューボタンへ(Windows のメニューバーと同じ入り方)。
  // ダイアログの間は帯ごと inert なので移さない
  useEffect(() => {
    if (!showMenuButton) return
    const alt = createAltTapDetector()
    const mnemonics = topMenuMnemonics()
    const onDown = (e: KeyboardEvent): void => {
      alt.keydown(e)
      // Alt+F などのニーモニックで、上の段のそのメニューを直接開く(OS のメニューバーがあった頃と同じ)。
      // キー操作の設定にある Alt の組(Alt+X・Alt+Backspace など)は、そちらを先にする
      const letter = menuMnemonicFor(e, mnemonics)
      if (!letter || e.repeat || isModalOpen()) return
      const scheme = useSettingsStore.getState().keymapScheme
      if (editorActionFor(e, getEditorKeymap(scheme)) !== null) return
      if (Object.values(getKeymap(scheme)).some((b) => matchesBinding(e, b))) return
      e.preventDefault()
      e.stopPropagation()
      const b = menuButtonRef.current?.getBoundingClientRect()
      window.api.popupTopMenu(letter, b ? { x: b.left, y: b.bottom + 2 } : { x: 8, y: 46 })
    }
    const onUp = (e: KeyboardEvent): void => {
      if (!alt.keyup(e) || isModalOpen()) return
      const btn = menuButtonRef.current
      if (!btn) return
      e.preventDefault()
      if (document.activeElement === btn) btn.blur()
      else btn.focus()
    }
    const onCancel = (): void => alt.cancel()
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('pointerdown', onCancel, true)
    window.addEventListener('blur', onCancel)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('pointerdown', onCancel, true)
      window.removeEventListener('blur', onCancel)
    }
  }, [showMenuButton])
  // 自動編集の画面を開いている間は、帯の「自動編集」を今いる所にする(画面は帯の下に重なる)
  const screenOpen = usePipelineStore((s) => s.screenOpen)
  const reviewView = usePipelineStore((s) => s.screenView === 'review')
  const autoOpen = screenOpen && !reviewView
  const reviewOpen = screenOpen && reviewView
  const closeAutoEdit = (): void => usePipelineStore.getState().setScreenOpen(false)
  const openAutoEdit = (): void => emitMenuCommand('auto.screen')
  const openExport = (e: React.MouseEvent<HTMLElement>): void => {
    remember(e)
    emitMenuCommand('file.export')
  }
  return (
    <header
      className={`workflow-bar ${platform === 'darwin' ? 'mac-inset' : ''}`}
      inert={modalOpen || undefined}
    >
      <div className="workflow-bar-project">
        {showMenuButton && (
          <button
            ref={menuButtonRef}
            type="button"
            className="icon-button workflow-menu-button"
            aria-label="メニュー"
            aria-haspopup="menu"
            title="メニュー(ファイル・編集・表示…)  Alt"
            onClick={openMenu}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                openMenu()
              }
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        )}
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
        <button
          type="button"
          className={`workflow-step ${autoOpen ? 'current' : ''}`}
          aria-current={autoOpen ? 'page' : undefined}
          onClick={openAutoEdit}
        >
          {autoOpen && <span className="workflow-step-dot" aria-hidden="true" />}
          自動編集
        </button>
        <button
          type="button"
          className={`workflow-step ${reviewOpen ? 'current' : ''}`}
          aria-current={reviewOpen ? 'page' : undefined}
          onClick={() => emitMenuCommand('auto.review')}
        >
          {reviewOpen && <span className="workflow-step-dot" aria-hidden="true" />}
          確認
          {reviewCount > 0 && (
            <span className="workflow-step-count">{reviewCount.toLocaleString()}</span>
          )}
        </button>
        <button
          type="button"
          className={`workflow-step ${telopOpen || screenOpen ? '' : 'current'}`}
          aria-current={telopOpen || screenOpen ? undefined : 'page'}
          onClick={() => {
            closeAutoEdit()
            onEdit()
          }}
        >
          {!telopOpen && !screenOpen && <span className="workflow-step-dot" aria-hidden="true" />}
          編集
        </button>
        <button
          type="button"
          className={`workflow-step ${telopOpen && !screenOpen ? 'current' : ''}`}
          aria-current={telopOpen && !screenOpen ? 'page' : undefined}
          onClick={() => {
            closeAutoEdit()
            onTelop()
          }}
        >
          {telopOpen && !screenOpen && <span className="workflow-step-dot" aria-hidden="true" />}
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

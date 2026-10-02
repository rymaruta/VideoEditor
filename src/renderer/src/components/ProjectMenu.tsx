import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useAutosaveStore } from '../store/autosaveStore'
import { useRecentProjectsStore, projectFileName } from '../store/recentProjectsStore'
import { formatIpcError } from '../lib/ipcError'
import {
  saveProject,
  openProject,
  openRecentProject,
  saveProjectAs,
  startNewProject
} from '../lib/projectFileActions'
import { useMenuCommand } from '../lib/menuCommands'
import { checkMissingAssets } from '../lib/projectFileActions'

/**
 * プロジェクトのファイル操作(新規・開く・最近使った・保存・名前を付けて保存・自動保存の復元)。
 *
 * 操作の入口は**メニューバーの「ファイル」**(Windows の編集ソフトと同じ)。ここはその受け手で、
 * 画面にはステータスバーに失敗の知らせだけを出す。最近使ったプロジェクトと「破棄した自動保存
 * データを戻す」の有無は、メニューの中身として main へ渡す。
 */
export function ProjectMenu(): React.JSX.Element | null {
  const saveError = useProjectStore((s) => s.saveError)
  const setSaveError = useProjectStore((s) => s.setSaveError)
  const isDirty = useProjectStore((s) => s.isDirty)
  const restoreAutosave = useProjectStore((s) => s.restoreAutosave)
  const discardedAutosave = useAutosaveStore((s) => s.discarded)
  const recentProjects = useRecentProjectsStore((s) => s.recentProjects)
  const [error, setError] = useState<string | null>(null)
  const recentRef = useRef<string[]>([])

  // メニューの「最近使ったプロジェクト」を作り直す。移動・削除されたものには印を付ける
  // (黙って一覧から消すことはしない)
  useEffect(() => {
    let canceled = false
    const paths = recentProjects.map((e) => e.filePath)
    const send = (missing: string[]): void => {
      if (canceled) return
      recentRef.current = paths
      void window.api
        .updateMenu({
          file: {
            recent: paths.map(
              (p) => `${projectFileName(p)}${missing.includes(p) ? '(見つかりません)' : ''}`
            ),
            canRestoreDiscarded: Boolean(discardedAutosave)
          }
        })
        .catch(() => {})
    }
    if (paths.length === 0) send([])
    else window.api.checkFilesExist(paths).then(send, () => send([]))
    return () => {
      canceled = true
    }
  }, [recentProjects, discardedAutosave])

  async function handleSave(): Promise<void> {
    setError(null)
    try {
      await saveProject()
    } catch (e) {
      setSaveError(formatIpcError(e))
    }
  }

  async function handleOpen(): Promise<void> {
    setError(null)
    try {
      await openProject()
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  // 起動時の確認で「破棄する」を選んだデータを戻す。破棄は退避なので中身は残っている。
  async function handleRestoreDiscarded(): Promise<void> {
    setError(null)
    if (isDirty && !confirm('保存されていない変更があります。破棄して自動保存データを戻しますか?'))
      return
    try {
      const project = await window.api.loadDiscardedAutosave()
      restoreAutosave(project)
      await checkMissingAssets()
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  async function handleOpenRecent(filePath: string): Promise<void> {
    setError(null)
    try {
      await openRecentProject(filePath)
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  // メニューバー(ファイル)から来る操作
  useMenuCommand((id) => {
    if (id === 'file.new') void startNewProject()
    else if (id === 'file.open') void handleOpen()
    else if (id === 'file.save') void handleSave()
    else if (id === 'file.saveAs') {
      setError(null)
      saveProjectAs().catch((e) => setSaveError(formatIpcError(e)))
    } else if (id === 'file.restoreDiscarded') void handleRestoreDiscarded()
    else if (id.startsWith('file.recent.')) {
      const path = recentRef.current[Number(id.slice('file.recent.'.length))]
      if (path) void handleOpenRecent(path)
    }
  })

  const message = error ?? saveError
  if (!message) return null
  return (
    <span className="status-error" role="alert">
      {message}
      <button
        type="button"
        className="status-error-close"
        aria-label="閉じる"
        onClick={() => {
          setError(null)
          setSaveError(null)
        }}
      >
        ×
      </button>
    </span>
  )
}

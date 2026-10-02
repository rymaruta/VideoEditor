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
import {
  SaveIcon,
  FolderOpenIcon,
  FilePlusIcon,
  ChevronDownIcon,
  TrashIcon,
  UndoIcon
} from './icons'

export function ProjectMenu(): React.JSX.Element {
  const currentFilePath = useProjectStore((s) => s.currentFilePath)
  const isDirty = useProjectStore((s) => s.isDirty)
  const saveError = useProjectStore((s) => s.saveError)
  const setSaveError = useProjectStore((s) => s.setSaveError)
  const restoreAutosave = useProjectStore((s) => s.restoreAutosave)
  const discardedAutosave = useAutosaveStore((s) => s.discarded)
  const recentProjects = useRecentProjectsStore((s) => s.recentProjects)
  const forgetProject = useRecentProjectsStore((s) => s.forgetProject)
  const [error, setError] = useState<string | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const [missingPaths, setMissingPaths] = useState<string[]>([])
  const recentRef = useRef<HTMLDivElement>(null)

  // 一覧を開いたときだけ、実ファイルの有無を確かめる。移動・削除されたものに
  // 印を付けるのが目的で、黙って一覧から消すことはしない(利用者が消す)。
  useEffect(() => {
    if (!recentOpen || recentProjects.length === 0) return
    let canceled = false
    window.api
      .checkFilesExist(recentProjects.map((e) => e.filePath))
      .then((missing) => {
        if (!canceled) setMissingPaths(missing)
      })
      .catch(() => {
        if (!canceled) setMissingPaths([])
      })
    return () => {
      canceled = true
    }
  }, [recentOpen, recentProjects])

  useEffect(() => {
    if (!recentOpen) return
    function handleOutside(e: MouseEvent): void {
      if (!recentRef.current?.contains(e.target as Node)) setRecentOpen(false)
    }
    window.addEventListener('mousedown', handleOutside)
    return () => window.removeEventListener('mousedown', handleOutside)
  }, [recentOpen])

  async function handleSave(): Promise<void> {
    setError(null)
    try {
      await saveProject()
    } catch (e) {
      setSaveError(formatIpcError(e))
    }
  }

  // メニューバー(ファイル)から来る操作。失敗の出し方はボタンと同じ
  useMenuCommand((id) => {
    if (id === 'file.new') void startNewProject()
    else if (id === 'file.open') void handleOpen()
    else if (id === 'file.save') void handleSave()
    else if (id === 'file.saveAs') {
      setError(null)
      saveProjectAs().catch((e) => setSaveError(formatIpcError(e)))
    }
  })

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
      setRecentOpen(false)
    } catch (e) {
      setError(formatIpcError(e))
    }
  }

  return (
    <div className="project-menu">
      <div className="project-menu-buttons">
        <button className="icon-button" title="新規プロジェクト" onClick={startNewProject}>
          <FilePlusIcon width={14} height={14} />
        </button>
        <button className="icon-button" title="プロジェクトを開く" onClick={handleOpen}>
          <FolderOpenIcon width={14} height={14} />
        </button>
        <div className="recent-projects" ref={recentRef}>
          <button
            className="icon-button"
            title="最近使ったプロジェクト"
            disabled={recentProjects.length === 0}
            onClick={() => setRecentOpen((v) => !v)}
          >
            <ChevronDownIcon width={14} height={14} />
          </button>
          {recentOpen && (
            <div className="recent-projects-list">
              {recentProjects.map((entry) => {
                const missing = missingPaths.includes(entry.filePath)
                return (
                  <div
                    key={entry.filePath}
                    className={`recent-project-item ${missing ? 'missing' : ''}`}
                  >
                    <button
                      className="recent-project-open"
                      title={missing ? `見つかりません: ${entry.filePath}` : entry.filePath}
                      onClick={() => handleOpenRecent(entry.filePath)}
                    >
                      <span className="recent-project-name">{projectFileName(entry.filePath)}</span>
                      {missing && <span className="recent-project-missing">見つかりません</span>}
                    </button>
                    <button
                      className="icon-button danger"
                      title="この項目を一覧から削除"
                      onClick={() => forgetProject(entry.filePath)}
                    >
                      <TrashIcon width={12} height={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {discardedAutosave && (
          <button
            className="icon-button"
            title="破棄した自動保存データを戻す"
            onClick={handleRestoreDiscarded}
          >
            <UndoIcon width={14} height={14} />
          </button>
        )}
        <button
          className="icon-button"
          title="保存 (Ctrl+S)"
          onClick={handleSave}
          disabled={!isDirty && Boolean(currentFilePath)}
        >
          <SaveIcon width={14} height={14} />
        </button>
      </div>
      {(error ?? saveError) && <span className="project-menu-error">{error ?? saveError}</span>}
    </div>
  )
}

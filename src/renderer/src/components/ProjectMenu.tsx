import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import { saveProject, openProject, startNewProject } from '../lib/projectFileActions'
import { SaveIcon, FolderOpenIcon, FilePlusIcon } from './icons'

export function ProjectMenu(): React.JSX.Element {
  const currentFilePath = useProjectStore((s) => s.currentFilePath)
  const isDirty = useProjectStore((s) => s.isDirty)
  const [error, setError] = useState<string | null>(null)

  async function handleSave(): Promise<void> {
    setError(null)
    try {
      await saveProject()
    } catch (e) {
      setError(formatIpcError(e))
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

  return (
    <div className="project-menu">
      <div className="project-menu-buttons">
        <button className="icon-button" title="新規プロジェクト" onClick={startNewProject}>
          <FilePlusIcon width={14} height={14} />
        </button>
        <button className="icon-button" title="プロジェクトを開く" onClick={handleOpen}>
          <FolderOpenIcon width={14} height={14} />
        </button>
        <button
          className="icon-button"
          title="保存 (Ctrl+S)"
          onClick={handleSave}
          disabled={!isDirty && Boolean(currentFilePath)}
        >
          <SaveIcon width={14} height={14} />
        </button>
      </div>
      {error && <span className="project-menu-error">{error}</span>}
    </div>
  )
}

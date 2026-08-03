import { useProjectStore } from '../store/projectStore'

export async function saveProjectAs(): Promise<void> {
  const { project, markSaved } = useProjectStore.getState()
  const filePath = await window.api.selectProjectSavePath(`${project.name}.veproj`)
  if (!filePath) return
  await window.api.saveProject(filePath, project)
  markSaved(filePath)
}

export async function saveProject(): Promise<void> {
  const { project, currentFilePath, markSaved } = useProjectStore.getState()
  if (!currentFilePath) {
    await saveProjectAs()
    return
  }
  await window.api.saveProject(currentFilePath, project)
  markSaved(currentFilePath)
}

export async function openProject(): Promise<void> {
  const { isDirty, loadProject } = useProjectStore.getState()
  if (isDirty && !confirm('保存されていない変更があります。破棄して開きますか?')) return
  const filePath = await window.api.selectProjectOpenPath()
  if (!filePath) return
  const loaded = await window.api.loadProject(filePath)
  loadProject(loaded, filePath)
}

export function startNewProject(): void {
  const { isDirty, newProject } = useProjectStore.getState()
  if (isDirty && !confirm('保存されていない変更があります。破棄して新規作成しますか?')) return
  newProject()
}

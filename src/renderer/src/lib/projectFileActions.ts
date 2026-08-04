import { useProjectStore } from '../store/projectStore'

export async function checkMissingAssets(): Promise<void> {
  const { project, setMissingAssetIds } = useProjectStore.getState()
  if (project.assets.length === 0) {
    setMissingAssetIds([])
    return
  }
  const missingPaths = await window.api.checkFilesExist(project.assets.map((a) => a.filePath))
  const missingSet = new Set(missingPaths)
  setMissingAssetIds(project.assets.filter((a) => missingSet.has(a.filePath)).map((a) => a.id))
}

export async function saveProjectAs(): Promise<void> {
  const { project, markSaved } = useProjectStore.getState()
  const filePath = await window.api.selectProjectSavePath(`${project.name}.veproj`)
  if (!filePath) return
  await window.api.saveProject(filePath, project)
  markSaved(filePath)
  await window.api.clearAutosave()
}

export async function saveProject(): Promise<void> {
  const { project, currentFilePath, markSaved } = useProjectStore.getState()
  if (!currentFilePath) {
    await saveProjectAs()
    return
  }
  await window.api.saveProject(currentFilePath, project)
  markSaved(currentFilePath)
  await window.api.clearAutosave()
}

export async function openProject(): Promise<void> {
  const { isDirty, loadProject } = useProjectStore.getState()
  if (isDirty && !confirm('保存されていない変更があります。破棄して開きますか?')) return
  const filePath = await window.api.selectProjectOpenPath()
  if (!filePath) return
  const loaded = await window.api.loadProject(filePath)
  loadProject(loaded, filePath)
  await window.api.clearAutosave()
  await checkMissingAssets()
}

export async function startNewProject(): Promise<void> {
  const { isDirty, newProject } = useProjectStore.getState()
  if (isDirty && !confirm('保存されていない変更があります。破棄して新規作成しますか?')) return
  newProject()
  await window.api.clearAutosave()
}

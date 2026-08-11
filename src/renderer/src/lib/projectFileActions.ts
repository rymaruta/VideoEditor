import { useProjectStore } from '../store/projectStore'
import { useRecentProjectsStore } from '../store/recentProjectsStore'
import { safeFileBaseName } from '@shared/fileName'

// 開く/保存の成功時にだけ記録する。ここに置いておけば、ボタン経由でも
// Ctrl+S のショートカット経由でも同じように残る。
function remember(filePath: string): void {
  useRecentProjectsStore.getState().rememberProject(filePath, Date.now())
}

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
  const filePath = await window.api.selectProjectSavePath(
    `${safeFileBaseName(project.name)}.veproj`
  )
  if (!filePath) return
  await window.api.saveProject(filePath, project)
  markSaved(filePath)
  remember(filePath)
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
  remember(currentFilePath)
  await window.api.clearAutosave()
}

// ダイアログで選ぶ経路と最近使った一覧から選ぶ経路で、確認・読み込み・後始末を
// 共有する。分けると片方だけ直す事故が起きる(確認を出し忘れる、など)。
async function openProjectPath(filePath: string): Promise<void> {
  const { loadProject } = useProjectStore.getState()
  const loaded = await window.api.loadProject(filePath)
  loadProject(loaded, filePath)
  remember(filePath)
  await window.api.clearAutosave()
  await checkMissingAssets()
}

function confirmDiscardForOpen(): boolean {
  const { isDirty } = useProjectStore.getState()
  return !isDirty || confirm('保存されていない変更があります。破棄して開きますか?')
}

export async function openProject(): Promise<void> {
  if (!confirmDiscardForOpen()) return
  const filePath = await window.api.selectProjectOpenPath()
  if (!filePath) return
  await openProjectPath(filePath)
}

/** 最近使ったプロジェクト一覧から開く。確認と後始末はダイアログ経由と同じ */
export async function openRecentProject(filePath: string): Promise<void> {
  if (!confirmDiscardForOpen()) return
  await openProjectPath(filePath)
}

export async function startNewProject(): Promise<void> {
  const { isDirty, newProject } = useProjectStore.getState()
  if (isDirty && !confirm('保存されていない変更があります。破棄して新規作成しますか?')) return
  newProject()
  await window.api.clearAutosave()
}

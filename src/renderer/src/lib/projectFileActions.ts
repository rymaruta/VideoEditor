import { useProjectStore } from '../store/projectStore'
import { useRecentProjectsStore } from '../store/recentProjectsStore'
import { useAutosaveStore } from '../store/autosaveStore'
import { safeFileBaseName } from '@shared/fileName'

/**
 * 自動保存を退避してから、上部バーの「破棄した自動保存データを戻す」に反映する。
 *
 * 退避しただけで読み直さないと、**ファイルは残っているのにボタンが出ない**ため、
 * 再起動するまで戻せない(モーダルの「破棄する」も同じ理由で refresh している)。
 */
async function setAsideAutosave(): Promise<void> {
  await window.api.discardAutosave()
  await useAutosaveStore.getState().refresh()
}

// 開く/保存の成功時にだけ記録する。ここに置いておけば、ボタン経由でも
// Ctrl+S のショートカット経由でも同じように残る。
function remember(filePath: string): void {
  useRecentProjectsStore.getState().rememberProject(filePath, Date.now())
}

export async function checkMissingAssets(): Promise<void> {
  const { project, setMissingAssetPaths } = useProjectStore.getState()
  if (project.assets.length === 0) {
    setMissingAssetPaths([])
    return
  }
  // 見つからなかった**パス**をそのまま渡す。ID への変換はストア側でそのつど行う
  // (IDで覚えると、取り消しでパスが戻っても印が戻らない)。
  setMissingAssetPaths(await window.api.checkFilesExist(project.assets.map((a) => a.filePath)))
}

export async function saveProjectAs(): Promise<void> {
  const { project, markSaved } = useProjectStore.getState()
  const filePath = await window.api.selectProjectSavePath(
    `${safeFileBaseName(project.name)}.veproj`
  )
  if (!filePath) return
  await window.api.saveProject(filePath, project)
  // 書いたのは `project`。保存中に編集が入っていたら未保存のままにする(markSaved の理由)。
  markSaved(filePath, project)
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
  markSaved(currentFilePath, project)
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
  // 消さずに退避する。ここで残っている自動保存は、起動時の確認を「あとで決める」で
  // 見送ったぶん、つまり**まだどのファイルにもなっていない前回の作業**。保存後の
  // 後始末(saveProject)と違って中身は他のどこにも無いので、消すと戻せない。
  // 開く前は未変更(isDirty=false)なので確認も出ず、0クリックで失われていた。
  await setAsideAutosave()
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
  // 開くときと同じ理由で退避に留める(見送った自動保存がここで消えると戻せない)
  await setAsideAutosave()
}

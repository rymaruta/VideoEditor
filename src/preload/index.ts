import type { FaceBox } from '@shared/telop/avoidFaces'
import type { AsrJob, AsrJobResult, AsrWorkerMessage } from '@shared/transcript'
type AsrProgressMessage = Exclude<AsrWorkerMessage, { type: 'result' | 'done' | 'error' }>
import type { FootageScan } from '@shared/ingest/classify'
import type { SyncInputFile, SyncReport } from '@shared/sync/report'
import type { LoudnessTarget } from '@shared/loudness'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type { TelopLayerPayload } from '@shared/telop/layer'
import type { LibraryFile, LibraryState } from '@shared/library'
import type { MenuFileState, MenuShortcuts } from '@shared/appMenu'
import type {
  AspectRatio,
  BpmAnalysisResult,
  EnvApiKeys,
  ExportEngine,
  ExportProgress,
  HighlightCandidate,
  HighlightSensitivity,
  MediaProbeResult,
  Project,
  QualityPreset,
  ReferenceStyleAnalysis,
  ResolutionHeight,
  SilenceRange,
  TranscriptSegment,
  VoicevoxSpeaker,
  LongFormWindow
} from '@shared/types'

// Custom APIs for renderer
const api = {
  /**
   * ドロップされた File の実ファイルパス。
   *
   * Electron 32 で `File.path` が廃止されたため、これを経由しないとドロップされた素材の
   * 場所が分からない(ffmpeg も probe も絶対パスしか受け取らない)。実ファイルに紐づかない
   * ドラッグ(ブラウザからの画像など)では空文字が返る。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  selectMediaFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.selectMediaFiles),
  selectAudioFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.selectAudioFiles),
  selectRelinkFile: (): Promise<string | null> => ipcRenderer.invoke(IPC.selectRelinkFile),
  checkFilesExist: (filePaths: string[]): Promise<string[]> =>
    ipcRenderer.invoke(IPC.checkFilesExist, filePaths),
  probeMedia: (filePath: string): Promise<MediaProbeResult> =>
    ipcRenderer.invoke(IPC.probeMedia, filePath),
  generateThumbnail: (filePath: string, atSeconds: number): Promise<string> =>
    ipcRenderer.invoke(IPC.generateThumbnail, filePath, atSeconds),
  scanLongFormWindows: (
    filePath: string,
    duration: number,
    maxWindows: number,
    visualWeight: number
  ): Promise<LongFormWindow[]> =>
    ipcRenderer.invoke(IPC.scanLongFormWindows, filePath, duration, maxWindows, visualWeight),
  ensurePreviewProxy: (filePath: string, assetId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.ensurePreviewProxy, filePath, assetId),
  onPreviewProxyProgress: (
    callback: (payload: { assetId: string; percent: number }) => void
  ): (() => void) => {
    const listener = (_e: unknown, payload: { assetId: string; percent: number }): void =>
      callback(payload)
    ipcRenderer.on(IPC.previewProxyProgress, listener)
    return () => ipcRenderer.removeListener(IPC.previewProxyProgress, listener)
  },
  generateFrame: (
    filePath: string,
    atSeconds: number,
    width: number,
    height: number,
    fillCrop?: boolean,
    cropCenter?: { x: number; y: number },
    blurBackground?: boolean
  ): Promise<string> =>
    ipcRenderer.invoke(
      IPC.generateFrame,
      filePath,
      atSeconds,
      width,
      height,
      fillCrop,
      cropCenter,
      blurBackground
    ),
  generateWaveform: (
    filePath: string,
    rangeStart: number,
    rangeEnd: number,
    width: number,
    height: number
  ): Promise<string> =>
    ipcRenderer.invoke(IPC.generateWaveform, filePath, rangeStart, rangeEnd, width, height),
  detectSilence: (
    filePath: string,
    rangeStart: number,
    rangeEnd: number
  ): Promise<SilenceRange[]> =>
    ipcRenderer.invoke(IPC.detectSilence, filePath, rangeStart, rangeEnd),
  detectHighlights: (
    filePath: string,
    assetDuration: number,
    /** 省略時は従来の固定しきい値と同じ */
    sensitivity?: HighlightSensitivity
  ): Promise<HighlightCandidate[]> =>
    ipcRenderer.invoke(IPC.detectHighlights, filePath, assetDuration, sensitivity),
  analyzeBpm: (filePath: string, start: number, duration: number): Promise<BpmAnalysisResult> =>
    ipcRenderer.invoke(IPC.analyzeBpm, filePath, start, duration),
  analyzeReferenceStyle: (filePath: string): Promise<ReferenceStyleAnalysis> =>
    ipcRenderer.invoke(IPC.analyzeReferenceStyle, filePath),
  transcribe: (
    filePath: string,
    rangeStart: number,
    rangeEnd: number,
    language?: string
  ): Promise<TranscriptSegment[]> =>
    ipcRenderer.invoke(IPC.transcribe, filePath, rangeStart, rangeEnd, language),
  transcribeWords: (
    filePath: string,
    rangeStart: number,
    rangeEnd: number,
    language?: string
  ): Promise<TranscriptSegment[]> =>
    ipcRenderer.invoke(IPC.transcribeWords, filePath, rangeStart, rangeEnd, language),
  analyzeSmartCrop: (
    filePath: string,
    rangeStart: number,
    rangeEnd: number,
    sourceWidth: number,
    sourceHeight: number,
    targetAspect: number
  ): Promise<{ x: number; y: number }> =>
    ipcRenderer.invoke(
      IPC.analyzeSmartCrop,
      filePath,
      rangeStart,
      rangeEnd,
      sourceWidth,
      sourceHeight,
      targetAspect
    ),
  selectExportPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.selectExportPath, defaultName),
  selectExportFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.selectExportFolder),
  exportProject: (payload: {
    project: Project
    aspectRatio: AspectRatio
    resolutionHeight: ResolutionHeight
    quality: QualityPreset
    outputPath: string
    loudnessNormalization?: boolean
    loudnessTarget?: LoudnessTarget
    engine?: ExportEngine
    telopLayer?: TelopLayerPayload | null
  }): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC.exportProject, payload),
  onExportProgress: (callback: (progress: ExportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: ExportProgress): void =>
      callback(progress)
    ipcRenderer.on(IPC.exportProgress, listener)
    return () => ipcRenderer.removeListener(IPC.exportProgress, listener)
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url),
  showItemInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke(IPC.showItemInFolder, filePath),
  openPath: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.openPath, filePath),
  voicevoxListSpeakers: (): Promise<VoicevoxSpeaker[]> =>
    ipcRenderer.invoke(IPC.voicevoxListSpeakers),
  voicevoxSynthesize: (text: string, speakerId: number): Promise<string> =>
    ipcRenderer.invoke(IPC.voicevoxSynthesize, text, speakerId),
  selectProjectSavePath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.selectProjectSavePath, defaultName),
  selectProjectOpenPath: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.selectProjectOpenPath),
  saveProject: (filePath: string, project: Project): Promise<void> =>
    ipcRenderer.invoke(IPC.saveProject, filePath, project),
  loadProject: (filePath: string): Promise<Project> =>
    ipcRenderer.invoke(IPC.loadProject, filePath),
  downloadAudioAsset: (
    url: string,
    suggestedName: string
  ): Promise<{ filePath: string; duration: number }> =>
    ipcRenderer.invoke(IPC.downloadAudioAsset, url, suggestedName),
  getEnvApiKeys: (): Promise<EnvApiKeys> => ipcRenderer.invoke(IPC.getEnvApiKeys),
  setDirtyState: (dirty: boolean): void => ipcRenderer.send(IPC.setDirtyState, dirty),
  checkAutosave: (): Promise<{
    exists: boolean
    mtimeMs?: number
    discardedExists: boolean
    discardedMtimeMs?: number
  }> => ipcRenderer.invoke(IPC.checkAutosave),
  loadAutosave: (): Promise<Project> => ipcRenderer.invoke(IPC.loadAutosave),
  /** 戻り値は「居座っていた前回の自動保存を退避したか」(退避したら復元ボタンを出し直す) */
  autosaveProject: (project: Project): Promise<boolean> =>
    ipcRenderer.invoke(IPC.autosaveProject, project),
  /**
   * 保存後の後始末。**前回のぶんが居座っているときは消さずに退避する。**
   * 戻り値は退避したかどうか(退避したら復元ボタンを出し直す)
   */
  clearAutosave: (): Promise<boolean> => ipcRenderer.invoke(IPC.clearAutosave),
  /** 消さずに退避する。戻り値は退避したかどうか */
  discardAutosave: (): Promise<boolean> => ipcRenderer.invoke(IPC.discardAutosave),
  loadDiscardedAutosave: (): Promise<Project> => ipcRenderer.invoke(IPC.loadDiscardedAutosave),
  cancelExport: (): Promise<void> => ipcRenderer.invoke(IPC.cancelExport),
  detectExportEncoder: (): Promise<'libx264' | 'h264_nvenc'> =>
    ipcRenderer.invoke(IPC.detectExportEncoder),
  libraryOverview: (): Promise<{ state: LibraryState; missing: string[] }> =>
    ipcRenderer.invoke(IPC.libraryOverview),
  libraryRemember: (filePaths: string[]): Promise<LibraryState> =>
    ipcRenderer.invoke(IPC.libraryRemember, filePaths),
  libraryAddFolder: (): Promise<LibraryState | null> => ipcRenderer.invoke(IPC.libraryAddFolder),
  libraryForget: (folderPath: string): Promise<LibraryState> =>
    ipcRenderer.invoke(IPC.libraryForget, folderPath),
  libraryFiles: (folderPath: string): Promise<LibraryFile[]> =>
    ipcRenderer.invoke(IPC.libraryFiles, folderPath),
  libraryToggleFavorite: (filePath: string): Promise<LibraryState> =>
    ipcRenderer.invoke(IPC.libraryToggleFavorite, filePath),
  onMenuCommand: (callback: (id: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, id: string): void => callback(id)
    ipcRenderer.on(IPC.menuCommand, listener)
    return () => ipcRenderer.removeListener(IPC.menuCommand, listener)
  },
  updateMenu: (next: {
    shortcuts?: MenuShortcuts
    windows?: { id: string; label: string }[]
    file?: MenuFileState
  }): Promise<void> => ipcRenderer.invoke(IPC.menuUpdate, next),
  onLibraryChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.libraryChanged, listener)
    return () => ipcRenderer.removeListener(IPC.libraryChanged, listener)
  },
  footageSelectFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.footageSelectFolder),
  footageScan: (root: string): Promise<FootageScan> => ipcRenderer.invoke(IPC.footageScan, root),
  onFootageScanProgress: (callback: (p: { done: number; total: number }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { done: number; total: number }): void =>
      callback(p)
    ipcRenderer.on(IPC.footageScanProgress, listener)
    return () => ipcRenderer.removeListener(IPC.footageScanProgress, listener)
  },
  syncRun: (files: SyncInputFile[]): Promise<SyncReport> => ipcRenderer.invoke(IPC.syncRun, files),
  syncCancel: (): Promise<void> => ipcRenderer.invoke(IPC.syncCancel),
  footageEnvelopes: (paths: string[]): Promise<Float32Array[]> =>
    ipcRenderer.invoke(IPC.footageEnvelopes, paths),
  asrRun: (jobs: AsrJob[]): Promise<AsrJobResult[]> => ipcRenderer.invoke(IPC.asrRun, jobs),
  asrCancel: (): Promise<void> => ipcRenderer.invoke(IPC.asrCancel),
  faceDetect: (
    requests: { path: string; time: number; width: number; height: number }[]
  ): Promise<(FaceBox[] | null)[]> => ipcRenderer.invoke(IPC.faceDetect, requests),
  onFaceProgress: (callback: (p: { done: number; total: number }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { done: number; total: number }): void =>
      callback(p)
    ipcRenderer.on(IPC.faceProgress, listener)
    return () => ipcRenderer.removeListener(IPC.faceProgress, listener)
  },
  onAsrProgress: (callback: (m: AsrProgressMessage) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, m: AsrProgressMessage): void => callback(m)
    ipcRenderer.on(IPC.asrProgress, listener)
    return () => ipcRenderer.removeListener(IPC.asrProgress, listener)
  },
  onSyncProgress: (callback: (p: { percent: number; stage: string }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { percent: number; stage: string }): void =>
      callback(p)
    ipcRenderer.on(IPC.syncProgress, listener)
    return () => ipcRenderer.removeListener(IPC.syncProgress, listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type Api = typeof api

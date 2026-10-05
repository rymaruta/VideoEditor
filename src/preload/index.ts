import type { AudioEventWindow } from '@shared/events/audioEvents'
import type { SystemInfo } from '@shared/systemInfo'
import type { ShowKit } from '@shared/finish/sound'
import type { DenoiseResult } from '@shared/denoise'
import type { QcMeasurement } from '@shared/qc/media'
import type { LlmRequest, LlmWorkerMessage } from '@shared/llm'
type LlmProgressMessage = Exclude<LlmWorkerMessage, { type: 'done' | 'error' }>
import type { FaceBox } from '@shared/telop/avoidFaces'
import type { AsrJob, AsrJobResult, AsrWorkerMessage } from '@shared/transcript'
type AsrProgressMessage = Exclude<AsrWorkerMessage, { type: 'result' | 'done' | 'error' }>
import type { FootageScan } from '@shared/ingest/classify'
import type { SyncInputFile, SyncReport } from '@shared/sync/report'
import type { LoudnessTarget } from '@shared/loudness'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type { TelopLayerPayload, TelopLayerStageApi } from '@shared/telop/layer'
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
  /** 書き出しのテロップの層の画像を、描きながら少しずつ main へ送る(`telopLayerStage`) */
  telopLayer: {
    begin: (width: number, height: number): Promise<string> =>
      ipcRenderer.invoke(IPC.telopLayerBegin, width, height),
    append: (id: string, firstIndex: number, images: Uint8Array[]): Promise<void> =>
      ipcRenderer.invoke(IPC.telopLayerAppend, id, firstIndex, images),
    release: (id: string): Promise<void> => ipcRenderer.invoke(IPC.telopLayerRelease, id)
  } satisfies TelopLayerStageApi,
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
  /** 長い処理の最中か(スリープさせない・タスクバーに進み具合・閉じる前に確かめる)。終わったら null */
  setBusyState: (state: { label: string; percent?: number } | null): void =>
    ipcRenderer.send(IPC.setBusyState, state),
  /** 長い処理が終わったことを知らせる(アプリを見ていないときだけ通知) */
  notifyDone: (title: string, body: string): void => ipcRenderer.send(IPC.notifyDone, title, body),
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
  llmRun: (requests: LlmRequest[]): Promise<(unknown | null)[]> =>
    ipcRenderer.invoke(IPC.llmRun, requests),
  llmCancel: (): Promise<void> => ipcRenderer.invoke(IPC.llmCancel),
  qcMeasure: (filePath: string): Promise<QcMeasurement> =>
    ipcRenderer.invoke(IPC.qcMeasure, filePath),
  qcCancel: (): Promise<void> => ipcRenderer.invoke(IPC.qcCancel),
  denoiseRun: (sources: string[]): Promise<DenoiseResult[]> =>
    ipcRenderer.invoke(IPC.denoiseRun, sources),
  denoiseCancel: (): Promise<void> => ipcRenderer.invoke(IPC.denoiseCancel),
  showKitScan: (root: string): Promise<ShowKit> => ipcRenderer.invoke(IPC.showKitScan, root),
  selectProjectFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.selectProjectFiles),
  selectEditXml: (): Promise<string | null> => ipcRenderer.invoke(IPC.selectEditXml),
  readEditXml: (filePath: string): Promise<string> => ipcRenderer.invoke(IPC.readEditXml, filePath),
  systemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke(IPC.systemInfo),
  eventsRun: (
    files: { path: string; start: number; rate: number; duration: number }[]
  ): Promise<AudioEventWindow[]> => ipcRenderer.invoke(IPC.eventsRun, files),
  eventsCancel: (): Promise<void> => ipcRenderer.invoke(IPC.eventsCancel),
  onEventsProgress: (
    callback: (m: {
      type: string
      note?: string
      done?: number
      total?: number
      device?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      m: { type: string; note?: string; done?: number; total?: number; device?: string }
    ): void => callback(m)
    ipcRenderer.on(IPC.eventsProgress, listener)
    return () => ipcRenderer.removeListener(IPC.eventsProgress, listener)
  },
  saveRunReport: (defaultName: string, text: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.saveRunReport, defaultName, text),
  /** 字幕(SRT)・テロップスタイル(JSON)を保存する。選んだ場所を返す(やめたら null) */
  saveSubtitleFile: (
    defaultName: string,
    text: string,
    kind: 'srt' | 'json'
  ): Promise<string | null> => ipcRenderer.invoke(IPC.saveSubtitleFile, defaultName, text, kind),
  /** 字幕(SRT)・テロップスタイル(JSON)を選んで読む(やめたら null) */
  openSubtitleFile: (kind: 'srt' | 'json'): Promise<{ path: string; text: string } | null> =>
    ipcRenderer.invoke(IPC.openSubtitleFile, kind),
  showKitSelectFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.showKitSelectFolder),
  onDenoiseProgress: (
    callback: (p: { done: number; total: number; percent: number }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: { done: number; total: number; percent: number }
    ): void => callback(p)
    ipcRenderer.on(IPC.denoiseProgress, listener)
    return () => ipcRenderer.removeListener(IPC.denoiseProgress, listener)
  },
  framesRgb: (
    requests: { path: string; time: number }[],
    size: { w: number; h: number }
  ): Promise<(Uint8Array | null)[]> => ipcRenderer.invoke(IPC.framesRgb, requests, size),
  onFramesProgress: (callback: (p: { done: number; total: number }) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { done: number; total: number }): void =>
      callback(p)
    ipcRenderer.on(IPC.framesProgress, listener)
    return () => ipcRenderer.removeListener(IPC.framesProgress, listener)
  },
  onQcProgress: (callback: (percent: number) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: number): void => callback(p)
    ipcRenderer.on(IPC.qcProgress, listener)
    return () => ipcRenderer.removeListener(IPC.qcProgress, listener)
  },
  onLlmProgress: (callback: (m: LlmProgressMessage) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, m: LlmProgressMessage): void => callback(m)
    ipcRenderer.on(IPC.llmProgress, listener)
    return () => ipcRenderer.removeListener(IPC.llmProgress, listener)
  },
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

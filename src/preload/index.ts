import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type {
  AspectRatio,
  ExportProgress,
  HighlightCandidate,
  MediaProbeResult,
  Project,
  QualityPreset,
  ResolutionHeight,
  SilenceRange,
  TranscriptSegment,
  VoicevoxSpeaker
} from '@shared/types'

// Custom APIs for renderer
const api = {
  selectMediaFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.selectMediaFiles),
  selectAudioFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.selectAudioFiles),
  probeMedia: (filePath: string): Promise<MediaProbeResult> =>
    ipcRenderer.invoke(IPC.probeMedia, filePath),
  generateThumbnail: (filePath: string, atSeconds: number): Promise<string> =>
    ipcRenderer.invoke(IPC.generateThumbnail, filePath, atSeconds),
  generateFrame: (
    filePath: string,
    atSeconds: number,
    width: number,
    height: number
  ): Promise<string> => ipcRenderer.invoke(IPC.generateFrame, filePath, atSeconds, width, height),
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
  detectHighlights: (filePath: string, assetDuration: number): Promise<HighlightCandidate[]> =>
    ipcRenderer.invoke(IPC.detectHighlights, filePath, assetDuration),
  transcribe: (
    filePath: string,
    rangeStart: number,
    rangeEnd: number
  ): Promise<TranscriptSegment[]> =>
    ipcRenderer.invoke(IPC.transcribe, filePath, rangeStart, rangeEnd),
  selectExportPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.selectExportPath, defaultName),
  exportProject: (payload: {
    project: Project
    aspectRatio: AspectRatio
    resolutionHeight: ResolutionHeight
    quality: QualityPreset
    outputPath: string
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
  loadProject: (filePath: string): Promise<Project> => ipcRenderer.invoke(IPC.loadProject, filePath)
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

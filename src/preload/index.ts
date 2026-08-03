import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type { AspectRatio, ExportProgress, MediaProbeResult, Project } from '@shared/types'

// Custom APIs for renderer
const api = {
  selectMediaFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.selectMediaFiles),
  probeMedia: (filePath: string): Promise<MediaProbeResult> =>
    ipcRenderer.invoke(IPC.probeMedia, filePath),
  generateThumbnail: (filePath: string, atSeconds: number): Promise<string> =>
    ipcRenderer.invoke(IPC.generateThumbnail, filePath, atSeconds),
  selectExportPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.selectExportPath, defaultName),
  exportProject: (payload: {
    project: Project
    aspectRatio: AspectRatio
    resolutionHeight: 720 | 1080
    outputPath: string
  }): Promise<{ success: boolean }> => ipcRenderer.invoke(IPC.exportProject, payload),
  onExportProgress: (callback: (progress: ExportProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: ExportProgress): void =>
      callback(progress)
    ipcRenderer.on(IPC.exportProgress, listener)
    return () => ipcRenderer.removeListener(IPC.exportProgress, listener)
  },
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(IPC.openExternal, url)
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

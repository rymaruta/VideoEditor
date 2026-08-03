import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import {
  probeMedia,
  generateThumbnailDataUrl,
  generateFrameDataUrl,
  generateWaveformDataUrl,
  exportProject,
  detectSilence
} from './ffmpegService'
import { transcribeRange } from './whisperService'
import { listSpeakers, synthesizeSpeech } from './voicevoxService'
import { saveProjectFile, loadProjectFile } from './projectFileService'
import { detectHighlights } from './highlightService'
import { downloadAudioAsset } from './audioLibraryService'
import type { AspectRatio, Project, QualityPreset, ResolutionHeight } from '@shared/types'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  ipcMain.handle(IPC.selectMediaFiles, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '動画ファイル', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectAudioFiles, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音声ファイル', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectExportPath, async (_e, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'MP4動画', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(IPC.selectProjectSavePath, async (_e, defaultName: string) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName,
      filters: [{ name: 'VideoEditorプロジェクト', extensions: ['veproj'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(IPC.selectProjectOpenPath, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'VideoEditorプロジェクト', extensions: ['veproj'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC.exportProject,
    async (
      event,
      payload: {
        project: Project
        aspectRatio: AspectRatio
        resolutionHeight: ResolutionHeight
        quality: QualityPreset
        outputPath: string
      }
    ) => {
      await exportProject({
        project: payload.project,
        aspectRatio: payload.aspectRatio,
        resolutionHeight: payload.resolutionHeight,
        quality: payload.quality,
        outputPath: payload.outputPath,
        onProgress: (percent, stage) => {
          event.sender.send(IPC.exportProgress, { percent, stage })
        }
      })
      return { success: true }
    }
  )
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.videoeditor.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle(IPC.probeMedia, async (_e, filePath: string) => probeMedia(filePath))
  ipcMain.handle(IPC.generateThumbnail, async (_e, filePath: string, atSeconds: number) =>
    generateThumbnailDataUrl(filePath, atSeconds)
  )
  ipcMain.handle(
    IPC.generateFrame,
    async (_e, filePath: string, atSeconds: number, width: number, height: number) =>
      generateFrameDataUrl(filePath, atSeconds, width, height)
  )
  ipcMain.handle(
    IPC.generateWaveform,
    async (
      _e,
      filePath: string,
      rangeStart: number,
      rangeEnd: number,
      width: number,
      height: number
    ) => generateWaveformDataUrl(filePath, rangeStart, rangeEnd, width, height)
  )
  ipcMain.handle(
    IPC.detectSilence,
    async (_e, filePath: string, rangeStart: number, rangeEnd: number) =>
      detectSilence(filePath, rangeStart, rangeEnd)
  )
  ipcMain.handle(IPC.detectHighlights, async (_e, filePath: string, assetDuration: number) =>
    detectHighlights(filePath, assetDuration)
  )
  ipcMain.handle(
    IPC.transcribe,
    async (_e, filePath: string, rangeStart: number, rangeEnd: number) =>
      transcribeRange(filePath, rangeStart, rangeEnd)
  )
  ipcMain.handle(IPC.voicevoxListSpeakers, async () => listSpeakers())
  ipcMain.handle(IPC.voicevoxSynthesize, async (_e, text: string, speakerId: number) =>
    synthesizeSpeech(text, speakerId)
  )
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    await shell.openExternal(url)
  })
  ipcMain.handle(IPC.showItemInFolder, (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
  ipcMain.handle(IPC.openPath, async (_e, filePath: string) => {
    const errorMessage = await shell.openPath(filePath)
    if (errorMessage) throw new Error(errorMessage)
  })
  ipcMain.handle(IPC.saveProject, (_e, filePath: string, project: Project) => {
    saveProjectFile(filePath, project)
  })
  ipcMain.handle(IPC.loadProject, (_e, filePath: string) => loadProjectFile(filePath))
  ipcMain.handle(IPC.downloadAudioAsset, async (_e, url: string, suggestedName: string) =>
    downloadAudioAsset(url, suggestedName)
  )

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

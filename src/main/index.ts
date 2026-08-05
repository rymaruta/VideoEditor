import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import { ensurePreviewProxy } from './previewProxyService'
import {
  probeMedia,
  generateThumbnailDataUrl,
  generateFrameDataUrl,
  generateWaveformDataUrl,
  exportProject,
  cancelExport,
  detectSilence
} from './ffmpegService'
import { transcribeRange, transcribeWordsRange } from './whisperService'
import { analyzeSmartCropCenter } from './smartCropService'
import { listSpeakers, synthesizeSpeech } from './voicevoxService'
import { saveProjectFile, loadProjectFile } from './projectFileService'
import { detectHighlights, analyzeReferenceStyle } from './highlightService'
import { analyzeBpm } from './bpmService'
import { downloadAudioAsset } from './audioLibraryService'
import { loadEnvFile, getEnvApiKeys } from './envConfig'
import type { AspectRatio, Project, QualityPreset, ResolutionHeight } from '@shared/types'

loadEnvFile()

let hasUnsavedChanges = false
let autosavePath = ''
let windowStatePath = ''

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
}

function loadWindowState(): WindowState | null {
  try {
    if (!windowStatePath || !existsSync(windowStatePath)) return null
    return JSON.parse(readFileSync(windowStatePath, 'utf-8'))
  } catch {
    return null
  }
}

function saveWindowState(mainWindow: BrowserWindow): void {
  if (!windowStatePath) return
  const isMaximized = mainWindow.isMaximized()
  const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds()
  const state: WindowState = { ...bounds, isMaximized }
  try {
    writeFileSync(windowStatePath, JSON.stringify(state))
  } catch {
    // Best-effort only; losing the remembered size/position isn't worth surfacing an error.
  }
}

function createWindow(): void {
  windowStatePath = join(app.getPath('userData'), 'window-state.json')
  const savedState = loadWindowState()

  const mainWindow = new BrowserWindow({
    width: savedState?.width ?? 1360,
    height: savedState?.height ?? 860,
    x: savedState?.x,
    y: savedState?.y,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Dev mode serves the renderer from http://localhost (Vite dev server), and
      // Chromium blocks file:// resource loads (local video/audio assets) from an
      // http(s) origin by default. The packaged app loads the renderer via file://
      // and is unaffected, so this only relaxes the dev-only workflow.
      webSecurity: !is.dev
    }
  })

  // Fill the screen on first launch (no remembered state yet); afterwards, whatever
  // size/position/maximized-state the user leaves the window in is remembered and
  // restored next time, instead of always reopening at a fixed 1360x860.
  if (!savedState || savedState.isMaximized) {
    mainWindow.maximize()
  }

  let saveStateTimer: NodeJS.Timeout | null = null
  function scheduleSaveWindowState(): void {
    if (saveStateTimer) clearTimeout(saveStateTimer)
    saveStateTimer = setTimeout(() => saveWindowState(mainWindow), 500)
  }
  mainWindow.on('resize', scheduleSaveWindowState)
  mainWindow.on('move', scheduleSaveWindowState)

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.on('close', (e) => {
    saveWindowState(mainWindow)
    if (!hasUnsavedChanges) {
      if (autosavePath && existsSync(autosavePath)) rmSync(autosavePath, { force: true })
      return
    }
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['保存せずに終了', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '保存されていない変更があります',
      detail: '変更を保存せずに終了しますか?'
    })
    if (choice === 0) {
      hasUnsavedChanges = false
      mainWindow.close()
    }
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
}

// Dialog helpers parented to the window that sent the IPC request. Handlers must
// NOT be registered inside createWindow(): on macOS the app keeps running with all
// windows closed, and reopening via the dock calls createWindow() again — a second
// ipcMain.handle() for the same channel throws and crashes the main process.
function showOpenDialogForSender(
  event: Electron.IpcMainInvokeEvent,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function showSaveDialogForSender(
  event: Electron.IpcMainInvokeEvent,
  options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function registerWindowScopedIpcHandlers(): void {
  ipcMain.handle(IPC.selectMediaFiles, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '動画ファイル', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectAudioFiles, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音声ファイル', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectRelinkFile, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile'],
      filters: [
        {
          name: 'メディアファイル',
          extensions: [
            'mp4',
            'mov',
            'mkv',
            'avi',
            'webm',
            'm4v',
            'mp3',
            'wav',
            'm4a',
            'aac',
            'ogg',
            'flac'
          ]
        }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.selectExportPath, async (event, defaultName: string) => {
    const result = await showSaveDialogForSender(event, {
      defaultPath: defaultName,
      filters: [{ name: 'MP4動画', extensions: ['mp4'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(IPC.selectExportFolder, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.selectProjectSavePath, async (event, defaultName: string) => {
    const result = await showSaveDialogForSender(event, {
      defaultPath: defaultName,
      filters: [{ name: 'VideoEditorプロジェクト', extensions: ['veproj'] }]
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })

  ipcMain.handle(IPC.selectProjectOpenPath, async (event) => {
    const result = await showOpenDialogForSender(event, {
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
        loudnessNormalization?: boolean
      }
    ) => {
      await exportProject({
        project: payload.project,
        aspectRatio: payload.aspectRatio,
        resolutionHeight: payload.resolutionHeight,
        quality: payload.quality,
        outputPath: payload.outputPath,
        loudnessNormalization: payload.loudnessNormalization,
        onProgress: (percent, stage) => {
          event.sender.send(IPC.exportProgress, { percent, stage })
        }
      })
      return { success: true }
    }
  )
}

// Chromium ships without an HEVC decoder of its own, but can use the OS one on
// macOS/Windows when this is enabled. It is the difference between previewing a
// game capture directly and having to transcode a proxy copy of every file first.
// Must be set before the app is ready; a machine without platform support simply
// keeps reporting HEVC as unplayable and falls back to the proxy.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.videoeditor.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle(IPC.probeMedia, async (_e, filePath: string) => probeMedia(filePath))
  ipcMain.handle(IPC.ensurePreviewProxy, async (event, filePath: string, assetId: string) =>
    ensurePreviewProxy(filePath, (percent) => {
      // Sent back to the window that asked, so an import in one window can't
      // drive a progress bar in another.
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.previewProxyProgress, { assetId, percent })
      }
    })
  )
  ipcMain.handle(IPC.checkFilesExist, (_e, filePaths: string[]) =>
    filePaths.filter((p) => !existsSync(p))
  )
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
  ipcMain.handle(IPC.analyzeBpm, async (_e, filePath: string, start: number, duration: number) =>
    analyzeBpm(filePath, start, duration)
  )
  ipcMain.handle(IPC.analyzeReferenceStyle, async (_e, filePath: string) =>
    analyzeReferenceStyle(filePath)
  )
  ipcMain.handle(
    IPC.transcribe,
    async (_e, filePath: string, rangeStart: number, rangeEnd: number, language?: string) =>
      transcribeRange(filePath, rangeStart, rangeEnd, language)
  )
  ipcMain.handle(
    IPC.transcribeWords,
    async (_e, filePath: string, rangeStart: number, rangeEnd: number, language?: string) =>
      transcribeWordsRange(filePath, rangeStart, rangeEnd, language)
  )
  ipcMain.handle(
    IPC.analyzeSmartCrop,
    async (
      _e,
      filePath: string,
      rangeStart: number,
      rangeEnd: number,
      sourceWidth: number,
      sourceHeight: number,
      targetAspect: number
    ) =>
      analyzeSmartCropCenter(
        filePath,
        rangeStart,
        rangeEnd,
        sourceWidth,
        sourceHeight,
        targetAspect
      )
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
  ipcMain.handle(IPC.getEnvApiKeys, () => getEnvApiKeys())

  autosavePath = join(app.getPath('userData'), 'autosave.veproj')
  ipcMain.on(IPC.setDirtyState, (_e, dirty: boolean) => {
    hasUnsavedChanges = dirty
  })
  ipcMain.handle(IPC.checkAutosave, () => {
    if (!existsSync(autosavePath)) return { exists: false }
    return { exists: true, mtimeMs: statSync(autosavePath).mtimeMs }
  })
  ipcMain.handle(IPC.loadAutosave, () => loadProjectFile(autosavePath))
  ipcMain.handle(IPC.autosaveProject, (_e, project: Project) =>
    saveProjectFile(autosavePath, project)
  )
  ipcMain.handle(IPC.clearAutosave, () => {
    if (existsSync(autosavePath)) rmSync(autosavePath, { force: true })
  })
  ipcMain.handle(IPC.cancelExport, () => cancelExport())

  registerWindowScopedIpcHandlers()

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

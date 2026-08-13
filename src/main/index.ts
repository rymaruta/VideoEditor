import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import { ensurePreviewProxy } from './previewProxyService'
import { scanLongFormWindows } from './longFormService'
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
import {
  autosaveStatus,
  discardAutosaveFile,
  discardedPathFor,
  writeAutosaveFile
} from './autosaveFiles'
import { detectHighlights, analyzeReferenceStyle } from './highlightService'
import { analyzeBpm } from './bpmService'
import { downloadAudioAsset } from './audioLibraryService'
import { loadEnvFile, getEnvApiKeys } from './envConfig'
import type {
  AspectRatio,
  HighlightSensitivity,
  Project,
  QualityPreset,
  ResolutionHeight
} from '@shared/types'

loadEnvFile()

let hasUnsavedChanges = false
let autosavePath = ''
/** このセッションで自動保存を1回でも書いたか(前回のぶんを退避するのは最初の1回だけ) */
let autosaveOverwrittenThisSession = false
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
      // ここでファイルが残っているのは、前回の復元確認を「あとで決める」で見送った
      // ぶんだけ(保存・開く・新規では clearAutosave が消している)。消してしまうと
      // 見送っただけのつもりが、閉じた瞬間に確認もなく永久に失われる。退避に留める。
      if (autosavePath) discardAutosaveFile(autosavePath)
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

/**
 * 進捗などの通知を、その処理を頼んできたウィンドウにだけ返す。
 * (別のウィンドウの進捗バーを動かさないため、`webContents.send` の直呼びはしない)
 *
 * `send` は**破棄済みの相手に送ると `TypeError: Object has been destroyed` を投げる**。
 * ここは ffmpeg のイベントハンドラから呼ばれるので、投げてもどこにも捕まらず
 * **main プロセスごと落ちる**。送り先が居なくなっただけで、進行中の処理を
 * 道連れにしてはいけない。
 * (実測: 1080p・40秒の書き出しの途中でウィンドウを閉じると、次の進捗で
 * アプリが異常終了し、書き出し先には**48バイトの再生できないファイル**が残った。
 * ウィンドウを閉じてもアプリが残る macOS では、そのまま利用者が踏む)
 *
 * **通知は必ずこの関数を通すこと。** 生の `sender.send` を書くと、その経路だけが
 * 同じ落ち方に戻る(実際、プレビュープロキシ側にだけガードがあり、書き出し側は
 * 無防備なままだった)。
 */
function notifySender(event: Electron.IpcMainInvokeEvent, channel: string, payload: unknown): void {
  if (event.sender.isDestroyed()) return
  event.sender.send(channel, payload)
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
          notifySender(event, IPC.exportProgress, { percent, stage })
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
  ipcMain.handle(
    IPC.scanLongFormWindows,
    async (_e, filePath: string, duration: number, maxWindows: number, visualWeight: number) =>
      scanLongFormWindows(filePath, duration, maxWindows, visualWeight)
  )
  ipcMain.handle(IPC.ensurePreviewProxy, async (event, filePath: string, assetId: string) =>
    ensurePreviewProxy(filePath, (percent) => {
      notifySender(event, IPC.previewProxyProgress, { assetId, percent })
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
    async (
      _e,
      filePath: string,
      atSeconds: number,
      width: number,
      height: number,
      fillCrop?: boolean,
      cropCenter?: { x: number; y: number },
      blurBackground?: boolean
    ) =>
      generateFrameDataUrl(filePath, atSeconds, width, height, fillCrop, cropCenter, blurBackground)
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
  ipcMain.handle(
    IPC.detectHighlights,
    async (_e, filePath: string, assetDuration: number, sensitivity?: HighlightSensitivity) =>
      detectHighlights(filePath, assetDuration, sensitivity)
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
  ipcMain.handle(IPC.checkAutosave, () => autosaveStatus(autosavePath))
  ipcMain.handle(IPC.loadAutosave, () => loadProjectFile(autosavePath))
  /**
   * 60秒ごとの自動保存。**このセッションが初めて書くときだけ、居座っている自動保存を
   * 退避してから上書きする。**
   *
   * 起動時の確認で「あとで決める」を選ぶと `autosave.veproj` はそのまま残る。ところが
   * その後に何か編集すると、60秒後のタイマーが**前回の作業をそのまま上書き**していた。
   * 見送ったぶんは**まだどのファイルにもなっていない前回の作業**で、消えると戻す手段が
   * どこにも無い(確認モーダルは「あとで復元できます」と案内しているのに、実際には
   * 退避も作られていなかった)。実測: 「前回の作業(クリップ3本)」の自動保存を残して
   * 「あとで決める」を押し、新しい作業を1つすると、**60秒後に「新しい作業(1本)」で
   * 上書きされ、退避も復元ボタンも無かった**。
   *
   * 退避先は「破棄する」と同じ1つ。**退避は1セッションに1回だけ**——毎回退避すると
   * 2回目以降は「1分前の自分」で上書きされて、結局前回のぶんが消える。
   *
   * @returns 退避したら true(呼び出し側は上部バーの復元ボタンを出し直す)
   */
  ipcMain.handle(IPC.autosaveProject, (_e, project: Project) => {
    const setAside = writeAutosaveFile(autosavePath, project, !autosaveOverwrittenThisSession)
    autosaveOverwrittenThisSession = true
    return setAside
  })
  ipcMain.handle(IPC.clearAutosave, () => {
    if (existsSync(autosavePath)) rmSync(autosavePath, { force: true })
  })
  // 起動時の確認で「破棄する」を選んだときはこちら。消さずに退避するので、
  // 押し間違えても上部バーから戻せる。
  ipcMain.handle(IPC.discardAutosave, () => discardAutosaveFile(autosavePath))
  ipcMain.handle(IPC.loadDiscardedAutosave, () => loadProjectFile(discardedPathFor(autosavePath)))
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

import { cachedEnvelope } from './audioPcm'
import { readFile, stat, writeFile } from 'fs/promises'
import os from 'os'
import { cancelAsr, runAsr } from './asrService'
import { detectFaces } from './faceService'
import { cancelLlm, runLlm } from './llmService'
import { cancelMeasureExport, measureExport } from './qcService'
import { readFramesRgb } from './frameService'
import { cancelDenoise, denoiseFiles } from './audioCleanService'
import { scanShowKit } from './showKitService'
import { cancelAudioEvents, detectAudioEvents } from './eventService'
import type { LlmRequest } from '@shared/llm'
import type { AsrJob } from '@shared/transcript'
import { cancelSync, runSync, scanFootage } from './footageService'
import type { SyncInputFile } from '@shared/sync/report'
import { normalizeLoudnessTarget, type LoudnessTarget } from '@shared/loudness'
import { app, shell, BrowserWindow, ipcMain, dialog, screen } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { describeOpenPathFailure, missingFileError } from './openPathError'
import {
  LINUX_OPENER_COMMAND,
  describeOpenExternalFailure,
  openExternalProblem
} from './externalLink'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '@shared/ipc'
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS
} from '@shared/mediaExtensions'
import { ensurePreviewProxy } from './previewProxyService'
import { MediaJobQueue } from './mediaJobQueue'
import { scanLongFormWindows } from './longFormService'
import {
  probeMedia,
  generateThumbnailDataUrl,
  generateFrameDataUrl,
  generateWaveformDataUrl,
  exportProject,
  cancelExport,
  runExclusiveExport,
  detectSilence,
  ffmpegPath
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
import { fitWindowStateToDisplays, type WindowState } from './windowState'
import { detectVideoEncoder, exportSequenceSegmented } from './segmentRenderer'
import { installAppMenu, updateAppMenu } from './appMenu'
import {
  forgetLibraryFolder,
  libraryOverview,
  listLibraryFiles,
  rememberFolder,
  rememberImportedFiles,
  startLibraryWatchers,
  stopLibraryWatchers,
  toggleLibraryFavorite
} from './libraryService'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { TelopLayerPayload } from '@shared/telop/layer'
import type {
  AspectRatio,
  ExportEngine,
  HighlightSensitivity,
  Project,
  QualityPreset,
  ResolutionHeight
} from '@shared/types'

/** タイムラインの波形・サムネイル。同時に走らせる ffmpeg を抑え、結果を覚える(理由は mediaJobQueue) */
const timelineImages = new MediaJobQueue<string>(2)

loadEnvFile()

let hasUnsavedChanges = false
let autosavePath = ''
/** このセッションで自動保存を1回でも書いたか(前回のぶんを退避するのは最初の1回だけ) */
let autosaveOverwrittenThisSession = false
let windowStatePath = ''

function loadWindowState(): WindowState | null {
  try {
    if (!windowStatePath || !existsSync(windowStatePath)) return null
    // 保存した座標は「前回のディスプレイ構成」の座標。副ディスプレイを外して起動すると
    // 実在しない場所に開き、**画面のどこにも見えない**まま動く(理由は windowState.ts)。
    // `screen` は `app.whenReady()` の後だけ使える——`createWindow()` はその中から呼ばれる。
    return fitWindowStateToDisplays(
      JSON.parse(readFileSync(windowStatePath, 'utf-8')),
      screen.getAllDisplays().map((d) => d.workArea)
    )
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
    // メニューバー(ファイル / 編集 / …)を常に出す。Windows の編集ソフトと同じ作り
    autoHideMenuBar: false,
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

/**
 * このセッションの自動保存を片付ける。**退避先は1つしかないので、より取り返しの
 * つかないほうで埋めておく。**
 *
 * - **まだこのセッションが1回も書いていない**なら、そこに居るのは*前回の作業*。
 *   まだどのファイルにもなっていないので、消さずに退避する。
 * - **もう書いたあと**なら、そこに居るのは*今回の作業*。保存済みか、利用者が
 *   「破棄して開く/新規作成」で捨てると答えたぶんなので、**消してよい**。
 *   ここで退避すると、前回のぶんを取っておいた退避先を**1分前の自分で上書き**して
 *   しまう(`writeAutosaveFile` が「退避は1セッションに1回だけ」にしているのと同じ理由)。
 *
 * 終了時(`close`)はこの関門を通さない。あちらは**その回の作業をこれから失う**場面で、
 * 退避しておかないと次回の起動で戻せなくなる。
 *
 * @returns 退避したら true(呼び出し側は上部バーの復元ボタンを出し直す)
 */
function releaseAutosave(): boolean {
  if (!existsSync(autosavePath)) return false
  if (autosaveOverwrittenThisSession) {
    rmSync(autosavePath, { force: true })
    return false
  }
  return discardAutosaveFile(autosavePath)
}

function registerWindowScopedIpcHandlers(): void {
  ipcMain.handle(IPC.selectMediaFiles, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '動画・静止画', extensions: [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS] },
        { name: '動画ファイル', extensions: [...VIDEO_EXTENSIONS] },
        { name: '静止画(ワイプ・CG 用)', extensions: [...IMAGE_EXTENSIONS] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectAudioFiles, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音声ファイル', extensions: [...AUDIO_EXTENSIONS] }]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(IPC.selectRelinkFile, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile'],
      filters: [{ name: 'メディアファイル', extensions: [...MEDIA_EXTENSIONS] }]
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
        loudnessTarget?: LoudnessTarget
        engine?: ExportEngine
        /** 長尺向けの書き出しで使う、画面のプロセスが描いたテロップの層 */
        telopLayer?: TelopLayerPayload | null
      }
    ) => {
      const onProgress = (percent: number, stage: string): void => {
        notifySender(event, IPC.exportProgress, { percent, stage })
      }
      if (payload.engine === 'segmented') {
        // 一括書き出しは企画と違う縦横比で書き出すことがあるので、縦横比は引数のほうを使う
        const v2 = projectV1ToV2(
          { ...payload.project, aspectRatio: payload.aspectRatio },
          { resolution: payload.resolutionHeight }
        )
        await runExclusiveExport((signal) =>
          exportSequenceSegmented({
            project: v2,
            outputPath: payload.outputPath,
            quality: payload.quality,
            loudnessNormalization: payload.loudnessNormalization,
            loudnessTarget: normalizeLoudnessTarget(payload.loudnessTarget),
            telopLayer: payload.telopLayer,
            onProgress,
            signal
          })
        )
        return { success: true }
      }
      await exportProject({
        project: payload.project,
        aspectRatio: payload.aspectRatio,
        resolutionHeight: payload.resolutionHeight,
        quality: payload.quality,
        outputPath: payload.outputPath,
        loudnessNormalization: payload.loudnessNormalization,
        loudnessTarget: normalizeLoudnessTarget(payload.loudnessTarget),
        onProgress
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

/**
 * Linux でブラウザを起こせるか(`xdg-open` が PATH に居るか)。
 *
 * 一度調べたら覚えておく。**PATH は起動中に変わらない**うえ、リンクを押すたびに
 * ディレクトリを舐めると押し心地が悪くなる。Linux 以外は OS 自身が開くので調べない。
 */
let linuxOpenerFound: boolean | null = null
function hasLinuxOpener(): boolean {
  if (process.platform !== 'linux') return true
  if (linuxOpenerFound === null) {
    const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
    linuxOpenerFound = dirs.some((dir) => existsSync(join(dir, LINUX_OPENER_COMMAND)))
  }
  return linuxOpenerFound
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.videoeditor.app')
  startLibraryWatchers()
  installAppMenu(is.dev)
  ipcMain.handle(IPC.menuUpdate, (_e, next: Parameters<typeof updateAppMenu>[0]) =>
    updateAppMenu(next ?? {}, is.dev)
  )

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
    timelineImages.request(`thumb|${filePath}|${atSeconds}`, () =>
      generateThumbnailDataUrl(filePath, atSeconds)
    )
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
      timelineImages.request(
        `frame|${filePath}|${atSeconds}|${width}x${height}|${fillCrop}|${cropCenter?.x},${cropCenter?.y}|${blurBackground}`,
        () =>
          generateFrameDataUrl(
            filePath,
            atSeconds,
            width,
            height,
            fillCrop,
            cropCenter,
            blurBackground
          )
      )
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
    ) =>
      timelineImages.request(`wave|${filePath}|${rangeStart}|${rangeEnd}|${width}x${height}`, () =>
        generateWaveformDataUrl(filePath, rangeStart, rangeEnd, width, height)
      )
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
    // 開く前に分かる問題(URLの形・開く手立ての有無)は、ここで日本語にして返す。
    // `shell.openExternal` は**開けなくても成功を返す**ので、呼んでからでは分からない
    // (理由と実測は externalLink.ts)。
    const problem = openExternalProblem(url, process.platform, hasLinuxOpener())
    if (problem) throw new Error(problem)
    try {
      await shell.openExternal(url)
    } catch (e) {
      throw describeOpenExternalFailure(url, e)
    }
  })
  ipcMain.handle(IPC.showItemInFolder, (_e, filePath: string) => {
    // `showItemInFolder` は**戻り値も例外も無い**ので、失敗しても何も起きない
    // (書き出したファイルを消したあとに押すと、押した手応えすら無かった)。
    // こちらで実在だけ確かめて、他の経路と同じ文言で知らせる。
    if (!existsSync(filePath)) throw missingFileError()
    shell.showItemInFolder(filePath)
  })
  ipcMain.handle(IPC.openPath, async (_e, filePath: string) => {
    // 「無い」の判定は**呼ぶ前に自分でやる**。`openPath` の戻り値は OS が作った英語で、
    // 版によって文言が変わるため当てにできない(理由は describeOpenPathFailure)。
    const exists = existsSync(filePath)
    const errorMessage = exists ? await shell.openPath(filePath) : ''
    if (!exists || errorMessage) throw describeOpenPathFailure(exists, errorMessage)
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
  /**
   * 保存・開く・新規のあとの後始末。**「このセッションが書いたぶん」だけ消す。**
   *
   * 保存が済めば復元用の控えは要らない——という理屈が成り立つのは、そこに入って
   * いるのが**いま保存した内容**のときだけ。起動時の確認を「あとで決める」で見送ると
   * `autosave.veproj` は**前回の作業のまま**残るので、そこから1回も自動保存が走らない
   * うちに保存すると、**まだどのファイルにもなっていない前回の作業を、確認もなく
   * 消していた**。60秒のタイマーが一度でも回れば退避されるので、
   * **保存が早かったときだけ**失われる。
   * (実測: 「前回の作業(クリップ3本)」を残して「あとで決める」→ 新しい企画を保存。
   *  自動保存あり **true → false**、退避あり **false のまま**、上部バーの
   *  「破棄した自動保存データを戻す」も**出ない**。ディスクにも `.veproj` は0件)
   *
   * `close` ハンドラは同じ理由で既に「消さずに退避」へ直してあり、ここだけが
   * `rmSync` のまま残っていた。
   *
   * **このセッションが書いたぶんは消してよい**——中身はいま保存したものと同じで、
   * ここで退避すると、以前「破棄する」で取っておいたぶんを**冗長な控えで上書き**して
   * しまう(退避先は1つしかない)。
   *
   * @returns 退避したら true(呼び出し側は上部バーの復元ボタンを出し直す)
   */
  ipcMain.handle(IPC.clearAutosave, () => releaseAutosave())
  /**
   * 起動時の確認で「破棄する」を選んだとき、および**開く・新規作成**の前始末。
   * 消さずに退避するので、押し間違えても上部バーから戻せる。
   *
   * **上の `clearAutosave` と同じ関門を通す。** ここだけ素の `discardAutosaveFile` を
   * 呼んでいたので、**このセッションの自動保存が、前回の作業を取っておいた退避先を
   * 上書きしていた**。退避先は1つしかないので、上書きされた前回のぶんは戻せない。
   * (実測: 「前回の作業」の自動保存を残して起動 →「あとで決める」→ 編集して60秒の
   *  自動保存が1回走る。ここまでは正しく、退避先は **「前回の作業」**。
   *  その状態で「新規作成」を押すと退避先が **「今回の作業」** に変わり、
   *  **前回の作業はディスクのどこにも残らなかった**)
   */
  ipcMain.handle(IPC.discardAutosave, () => releaseAutosave())
  ipcMain.handle(IPC.loadDiscardedAutosave, () => loadProjectFile(discardedPathFor(autosavePath)))
  ipcMain.handle(IPC.cancelExport, () => cancelExport())
  // 長尺向けの書き出しで使う映像エンコーダ(GPU が使えるか)。1回試し書きして結果を覚える
  ipcMain.handle(IPC.detectExportEncoder, () => detectVideoEncoder())

  // --- 共通ライブラリ(一度読み込んだフォルダを覚えて、次の回からも使う) ---
  ipcMain.handle(IPC.libraryOverview, () => libraryOverview())
  ipcMain.handle(IPC.libraryRemember, (_e, filePaths: string[]) =>
    rememberImportedFiles(Array.isArray(filePaths) ? filePaths : [])
  )
  ipcMain.handle(IPC.libraryForget, (_e, folderPath: string) => forgetLibraryFolder(folderPath))
  ipcMain.handle(IPC.libraryToggleFavorite, (_e, filePath: string) =>
    toggleLibraryFavorite(filePath)
  )
  ipcMain.handle(IPC.libraryFiles, (_e, folderPath: string) => listLibraryFiles(folderPath))
  ipcMain.handle(IPC.libraryAddFolder, async (event) => {
    const result = await showOpenDialogForSender(event, {
      title: 'ライブラリに加えるフォルダ',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return rememberFolder(result.filePaths[0])
  })

  ipcMain.handle(IPC.footageSelectFolder, async (event) => {
    const result = await showOpenDialogForSender(event, {
      title: '収録フォルダ',
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.footageScan, (event, root: string) =>
    scanFootage(root, (done, total) =>
      notifySender(event, IPC.footageScanProgress, { done, total })
    )
  )
  ipcMain.handle(IPC.syncRun, (event, files: SyncInputFile[]) =>
    runSync(files, (percent, stage) => notifySender(event, IPC.syncProgress, { percent, stage }))
  )
  ipcMain.handle(IPC.syncCancel, () => cancelSync())
  // 素材の音の大きさ(10ms ごと)。同期のときに作ったものがキャッシュにあれば、それを返す
  ipcMain.handle(IPC.footageEnvelopes, (_e, paths: string[]) =>
    Promise.all(
      paths.map(async (path) => {
        const st = await stat(path)
        return cachedEnvelope(ffmpegPath, join(app.getPath('userData'), 'analysis-cache'), {
          path,
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      })
    )
  )
  ipcMain.handle(IPC.asrRun, (event, jobs: AsrJob[]) =>
    runAsr(jobs, (m) => notifySender(event, IPC.asrProgress, m))
  )
  ipcMain.handle(IPC.asrCancel, () => cancelAsr())
  ipcMain.handle(IPC.llmRun, (event, requests: LlmRequest[]) =>
    runLlm(requests, (m) => notifySender(event, IPC.llmProgress, m))
  )
  ipcMain.handle(IPC.llmCancel, () => cancelLlm())
  ipcMain.handle(IPC.qcMeasure, (event, filePath: string) =>
    measureExport(filePath, (percent) => notifySender(event, IPC.qcProgress, percent))
  )
  ipcMain.handle(IPC.qcCancel, () => cancelMeasureExport())
  ipcMain.handle(IPC.denoiseRun, (event, sources: string[]) =>
    denoiseFiles(sources, (done, total, percent) =>
      notifySender(event, IPC.denoiseProgress, { done, total, percent })
    )
  )
  ipcMain.handle(IPC.denoiseCancel, () => cancelDenoise())
  ipcMain.handle(IPC.showKitScan, (_e, root: string) => scanShowKit(root))
  ipcMain.handle(
    IPC.eventsRun,
    (event, files: { path: string; start: number; rate: number; duration: number }[]) =>
      detectAudioEvents(files, (m) => notifySender(event, IPC.eventsProgress, m))
  )
  ipcMain.handle(IPC.eventsCancel, () => cancelAudioEvents())
  ipcMain.handle(IPC.selectProjectFiles, async (event) => {
    const result = await showOpenDialogForSender(event, {
      title:
        '学ばせる過去回を選ぶ(人が仕上げたもの・複数可。このアプリのプロジェクトか Premiere の XML)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'プロジェクト・XML', extensions: ['veproj', 'xml'] },
        { name: 'VideoEditorプロジェクト', extensions: ['veproj'] },
        { name: 'Premiere の XML(FCP7)', extensions: ['xml'] }
      ]
    })
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle(IPC.selectEditXml, async (event) => {
    const result = await showOpenDialogForSender(event, {
      title: '人が仕上げた完成版の XML を選ぶ(Premiere: ファイル > 書き出し > Final Cut Pro XML)',
      properties: ['openFile'],
      filters: [{ name: 'Premiere の XML(FCP7)', extensions: ['xml'] }]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  // 処理の記録に載せる PC の構成
  ipcMain.handle(IPC.systemInfo, async () => {
    const cpus = os.cpus()
    let gpu: string[] = []
    try {
      const info = (await app.getGPUInfo('complete')) as {
        gpuDevice?: {
          vendorId?: number
          deviceId?: number
          active?: boolean
          driverVersion?: string
        }[]
        auxAttributes?: { glRenderer?: string }
      }
      gpu = [
        ...(info.auxAttributes?.glRenderer ? [info.auxAttributes.glRenderer] : []),
        ...(info.gpuDevice ?? []).map(
          (d) =>
            `vendor 0x${(d.vendorId ?? 0).toString(16)} device 0x${(d.deviceId ?? 0).toString(16)}${d.driverVersion ? ` driver ${d.driverVersion}` : ''}${d.active ? '(使用中)' : ''}`
        )
      ]
    } catch {
      gpu = []
    }
    return {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: cpus[0]?.model?.trim() ?? '不明',
      cores: cpus.length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
      gpu,
      app: `${app.getName()} ${app.getVersion()} / Electron ${process.versions.electron}`
    }
  })
  ipcMain.handle(IPC.saveRunReport, async (event, defaultName: string, text: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {
      title: '処理の記録を保存',
      defaultPath: defaultName,
      filters: [{ name: 'テキスト', extensions: ['txt'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, text, 'utf-8')
    return r.filePath
  })
  // XML だけを読む(任意のファイルを読めないよう、拡張子と大きさを確かめる)
  ipcMain.handle(IPC.readEditXml, async (_e, filePath: string) => {
    if (!/\.xml$/i.test(filePath)) throw new Error('XML ファイルではありません')
    const st = await stat(filePath)
    if (st.size > 200 * 1024 * 1024) throw new Error('XML が大きすぎます(200MB まで)')
    return readFile(filePath, 'utf-8')
  })
  ipcMain.handle(IPC.showKitSelectFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '番組素材フォルダを選ぶ(中に SE / BGM / CG のフォルダ)',
      properties: ['openDirectory']
    }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(
    IPC.framesRgb,
    (event, requests: { path: string; time: number }[], size: { w: number; h: number }) =>
      readFramesRgb(requests, size, (done, total) =>
        notifySender(event, IPC.framesProgress, { done, total })
      )
  )
  ipcMain.handle(
    IPC.faceDetect,
    (event, requests: { path: string; time: number; width: number; height: number }[]) =>
      detectFaces(requests, (done, total) => notifySender(event, IPC.faceProgress, { done, total }))
  )

  registerWindowScopedIpcHandlers()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => stopLibraryWatchers())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

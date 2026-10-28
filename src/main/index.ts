import { standardExportFits } from '@shared/exportLimits'
import { cachedEnvelope } from './audioPcm'
import { readFile, stat, writeFile } from 'fs/promises'
import { cancelAsr, runAsr, setAsrLanguage } from './asrService'
import { detectFaces } from './faceService'
import { cancelLlm, clearLlmLoadFailures, listLlmLoadFailures, runLlm } from './llmService'
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
import { withExtension, withVeprojExtension } from './partialOutput'
import {
  exportOutputConflict,
  projectSourcePaths,
  writeExportGuarded,
  type ProtectedPath
} from './exportOutputGuard'
import {
  existingPremiereSidecars,
  exportPremiereXml,
  premiereSidecarPaths,
  type PremiereExportPayload
} from './premiereExportService'
import { basename, extname, join } from 'path'
import { existsSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'fs'
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
  APP_ID,
  PRODUCT_NAME,
  PRODUCT_VENDOR,
  PRODUCT_VENDOR_EMAIL,
  SOURCE_OFFER_URL
} from '@shared/product'
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  VIDEO_EXTENSIONS
} from '@shared/mediaExtensions'
import { checkPreviewProxy, ensurePreviewProxy } from './previewProxyService'
import { MediaJobQueue } from './mediaJobQueue'
import { createWaveformPeaksService, type WaveformPeaksService } from './waveformPeaks'
import { killLiveProcesses } from './liveProcesses'
import { currentBusy, notifyDone, setBusy, type BusyState } from './busyState'
import { scanLongFormWindows } from './longFormService'
import {
  probeMedia,
  generateThumbnailDataUrl,
  generateFrameDataUrl,
  generateWaveformDataUrl,
  exportProject,
  cancelExport,
  runExclusiveExport,
  probeAudioChannels,
  detectSilence,
  ffmpegPath,
  ffprobePath
} from './ffmpegService'
import { transcribeRange, transcribeWordsRange } from './whisperService'
import { analyzeSmartCropCenter } from './smartCropService'
import { listSpeakers, synthesizeSpeech } from './voicevoxService'
import { saveProjectFile, loadProjectFile } from './projectFileService'
import {
  autosaveStatus,
  discardedPathFor,
  writeAutosaveFile,
  setAsideAutosaveFile
} from './autosaveFiles'
import { detectHighlights, analyzeReferenceStyle } from './highlightService'
import { analyzeBpm } from './bpmService'
import { downloadAudioAsset } from './audioLibraryService'
import { loadEnvFile, getEnvApiKeys } from './envConfig'
import { SecretStore } from './secretStore'
import { safeStorageCipher } from './safeStorageCipher'
import { fitWindowStateToDisplays, type WindowState } from './windowState'
import {
  cleanupStaleSegmentDirs,
  detectVideoEncoder,
  exportSequenceSegmented
} from './segmentRenderer'
import { installAppMenu, installMenuPopupIpc, updateAppMenu } from './appMenu'
import { openChromiumLicenses, openThirdPartyNotices } from './aboutWindow'
import { isLicenseDoc, type AboutInfo } from '@shared/about'
import { windowChromeOptions } from '@shared/windowChrome'
import { RendererCrashGuard } from './rendererRecovery'
import { collectSystemInfo, installCrashLogging, logRendererError } from './diagnostics'
import { installEnvCheckIpc } from './envCheckService'
import {
  readBuildKind,
  startAutoUpdate,
  updateCheckPlan,
  type AutoUpdateHandle,
  type UpdaterLike
} from './autoUpdate'
import {
  appendTelopLayerImages,
  beginTelopLayer,
  releaseAllTelopLayers,
  releaseTelopLayer,
  withTelopLayer
} from './telopLayerStage'
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
import { projectV1ToV2, timelineRangeToExportFrames } from '@shared/sequence/fromV1'
import { projectForOutput } from '@shared/trackVisibility'
import type { TelopLayerPayload } from '@shared/telop/layer'
import {
  EXPORT_FORMAT_EXT,
  type AspectRatio,
  type ExportEngine,
  type ExportFormat,
  type HighlightSensitivity,
  type Project,
  type QualityPreset,
  type ResolutionHeight
} from '@shared/types'

/**
 * タイムラインの波形。同時に走らせる ffmpeg を抑え、結果を覚える(理由は mediaJobQueue)。
 * スクロールで通り過ぎた分は捨ててよいので、待ちが溢れたら古い頼みから落とす
 */
const timelineImages = new MediaJobQueue<string>(2)
/**
 * タイムラインの細かい波形の値。素材ごとの素の値を 1 回だけ作ってディスクに覚え、そこから集計する
 * (waveformPeaks)。userData は起動後に決まるので、最初の頼みで作る
 */
let wavePeaks: WaveformPeaksService | null = null
function wavePeaksService(): WaveformPeaksService {
  wavePeaks ??= createWaveformPeaksService({
    ffmpegPath,
    ffprobePath,
    cacheDir: join(app.getPath('userData'), 'analysis-cache', 'waveform')
  })
  return wavePeaks
}
/** 止められる頼み(画面の頼みの番号 → 止める合図)。画面が要らなくなった頼みを止める */
const wavePeakRequests = new Map<string, AbortController>()
/** サムネイル・フレーム。1回きりの頼み(素材の読み込み・サムネイル作り)なので、落とさない */
const stillImages = new MediaJobQueue<string>(2, Number.POSITIVE_INFINITY)

/** 結果を覚える鍵に、ファイルの中身の目印(大きさ・更新時刻)を入れる。同じ名前で置き換えた素材に古い絵を出さない */
function fileStamp(filePath: string): string {
  try {
    const st = statSync(filePath)
    // 変更時刻(ctime)も入れる。同じ大きさ・同じ更新時刻のファイルへ差し替えても、書き込めば変わる
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`
  } catch {
    return 'missing'
  }
}

loadEnvFile()

let hasUnsavedChanges = false
/** 処理の途中でも閉じると決めた(保存の確認で戻ったら取り消す) */
let quitWhileBusy = false
let autosavePath = ''
/**
 * このセッションで保存・読み込みした企画ファイル。書き出し先がこれと同じなら止める
 * (`exportOutputGuard`。main は「いま開いている企画のパス」を持っていないので、通ったものを覚える)
 */
const knownProjectPaths = new Set<string>()
/** このセッションで自動保存を1回でも書いたか(前回のぶんを退避するのは最初の1回だけ) */
let autosaveOverwrittenThisSession = false
/**
 * このセッションで、前回の作業(「あとで決める」で見送った自動保存)を退避先へ移したか。
 * 移したなら、退避先に居るのは前回の作業。終了時に今回のぶんで上書きしない
 */
let previousDraftSetAside = false
/** 次に自動保存を退避するとき、退避先にある前のものを日時付きの名前で残す(画面が落ちて読み込み直したとき) */
let keepDiscardedOnNextSetAside = false
let windowStatePath = ''
/** 画面のプロセスが落ちたら読み込み直す(続けて落ちるときは止める) */
const rendererCrashGuard = new RendererCrashGuard()

/**
 * 「中止して終了」で閉じたとき、main 側で動いている処理を止める。
 * 画面が消えても文字起こし・同期・ffmpeg は動き続ける(macOS ではアプリも残る)。
 */
function abortBackgroundWork(): void {
  for (const cancel of [
    cancelAsr,
    cancelSync,
    cancelAudioEvents,
    cancelDenoise,
    cancelLlm,
    cancelMeasureExport,
    cancelExport
  ]) {
    try {
      cancel()
    } catch {
      // すでに終わっている
    }
  }
  killLiveProcesses()
}

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
  // 閉じた後に遅れて呼ばれたら何もしない(壊れた窓に触ると main が落ちる)
  if (!windowStatePath || mainWindow.isDestroyed()) return
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
    // OS のタイトルバーとメニューバーを出さず、アプリの上の帯 1 本にまとめる(Premiere・DaVinci・
    // VS Code と同じ)。Windows / Linux は最小化・最大化・閉じるを帯の右端に重ね、メニューは帯の
    // 「メニュー」ボタンから出す。macOS は信号のボタンを帯の左に重ねる(`@shared/windowChrome`)
    ...windowChromeOptions(process.platform),
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
    // 動かした直後に閉じたとき、遅れて走る保存を止める(閉じた窓に触って main が落ちていた。macOS)
    if (saveStateTimer) clearTimeout(saveStateTimer)
    saveStateTimer = null
    saveWindowState(mainWindow)
    // 長い処理の最中なら、まず確かめる(閉じると途中までの処理が失われる)
    const running = currentBusy()
    if (running && !quitWhileBusy) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['中止して終了', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: `${running.label}の途中です`,
        detail: '終了すると、途中までの処理は失われます。終了しますか?'
      })
      if (choice !== 0) {
        e.preventDefault()
        return
      }
      quitWhileBusy = true
    }
    if (!hasUnsavedChanges) {
      // ここでファイルが残っているのは、前回の復元確認を「あとで決める」で見送った
      // ぶんだけ(保存・開く・新規では clearAutosave が消している)。消してしまうと
      // 見送っただけのつもりが、閉じた瞬間に確認もなく永久に失われる。退避に留める。
      settleAutosaveOnClose()
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
    } else quitWhileBusy = false
  })

  mainWindow.on('closed', () => {
    // 閉じた画面の「処理中」が残ると、スリープ防止が外れず、次の窓(macOS)で閉じるたびに確かめられる
    const aborted = quitWhileBusy
    quitWhileBusy = false
    setBusy(null, null)
    if (!aborted) return
    abortBackgroundWork()
    // macOS は窓を閉じてもアプリが残る。中止すると決めたのだから終わらせる(止めた処理の後始末も兼ねる)
    if (process.platform === 'darwin') app.quit()
  })

  // 画面が落ちると「処理中」を解く人がいなくなる。残すとスリープ防止と閉じる前の確認が続く
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    quitWhileBusy = false
    setBusy(mainWindow.isDestroyed() ? null : mainWindow, null)
    if (mainWindow.isDestroyed()) return
    // 白いまま残さず読み込み直す(起動時と同じく、自動保存から戻せる)。理由は rendererRecovery
    if (rendererCrashGuard.shouldReload(details.reason)) {
      // 落ちる前の作業は自動保存にしか無い。読み込み直した画面の最初の自動保存で上書きせず、
      // 起動時と同じく退避してから書く(「あとで決める」を選んでも失われない)
      autosaveOverwrittenThisSession = false
      // 前回のセッションの作業をもう退避してあれば、それは消さずに残す(退避先は1つなので、
      // 落ちる前の作業を退避すると前回の作業が上書きされていた)
      keepDiscardedOnNextSetAside = previousDraftSetAside
      mainWindow.webContents.reload()
      return
    }
    if (details.reason !== 'clean-exit') {
      dialog.showErrorBox(
        '画面が続けて異常終了しました',
        `画面のプロセスが短い間に何度も終了したため、自動での再読み込みを止めました(${details.reason})。\n` +
          'アプリを起動し直すと、自動保存から作業を戻せます。'
      )
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
 * 保存ダイアログで選んだ名前に拡張子を足したとき、その名前のファイルがあれば上書きしてよいか確かめる
 * (足した名前は、保存ダイアログの上書きの確認を通っていない)。やめたら null
 */
async function confirmExtendedPath(
  event: Electron.IpcMainInvokeEvent,
  chosen: string,
  extended: string
): Promise<string | null> {
  if (extended === chosen || !existsSync(extended)) return extended
  const win = BrowserWindow.fromWebContents(event.sender)
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['上書きする', 'キャンセル'],
    defaultId: 1,
    cancelId: 1,
    message: `「${basename(extended)}」はすでにあります`,
    detail: '上書きしますか?'
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 0 ? extended : null
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
  const setAside = setAsideAutosaveFile(autosavePath, takeKeepDiscarded())
  if (setAside) previousDraftSetAside = true
  return setAside
}

/** 次の退避で、前に退避したもの(前回の作業)を残すか(1回だけ。画面が落ちて読み込み直したとき) */
function takeKeepDiscarded(): boolean {
  const keep = keepDiscardedOnNextSetAside
  keepDiscardedOnNextSetAside = false
  return keep
}

/**
 * 終了時の自動保存の後始末。ふつうは今回の作業を退避先へ移す(次回の起動で戻せる)。
 * ただし退避先に前回の作業(見送ったぶん)が居て、今回のぶんが自動保存にあるなら、
 * 今回のぶん(利用者が「保存せずに終了」で捨てると答えた、または保存済みのぶん)は消す。
 * 移すと、見送っただけの前回の作業が、捨てると答えた今回の作業で上書きされて消えていた
 */
function settleAutosaveOnClose(): void {
  if (!autosavePath || !existsSync(autosavePath)) return
  if (previousDraftSetAside && autosaveOverwrittenThisSession) {
    rmSync(autosavePath, { force: true })
    return
  }
  setAsideAutosaveFile(autosavePath, takeKeepDiscarded())
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
      // 静止画の素材もつなぎ直せるように(画像を外すと、動かした PNG を選べなかった)
      filters: [
        { name: 'メディアファイル', extensions: [...MEDIA_EXTENSIONS, ...IMAGE_EXTENSIONS] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    IPC.selectExportPath,
    async (event, defaultName: string, format: ExportFormat = 'mp4') => {
      const ext = EXPORT_FORMAT_EXT[format] ?? 'mp4'
      const result = await showSaveDialogForSender(event, {
        defaultPath: defaultName,
        filters: [{ name: EXPORT_FILTER_NAME[format] ?? 'MP4動画', extensions: [ext] }]
      })
      if (result.canceled || !result.filePath) return null
      return confirmExtendedPath(event, result.filePath, withExtension(result.filePath, ext))
    }
  )

  // 書き出し先のドライブの空き(書き出しの画面の「空き容量」)。フォルダが無い・測れなければ null
  ipcMain.handle(IPC.exportDiskFree, (_event, folder: string) => {
    try {
      if (typeof folder !== 'string' || !folder) return null
      const s = statfsSync(folder)
      const free = Number(s.bavail) * Number(s.bsize)
      return Number.isFinite(free) ? free : null
    } catch {
      return null
    }
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
      filters: [{ name: `${PRODUCT_NAME}プロジェクト`, extensions: ['veproj'] }]
    })
    if (result.canceled || !result.filePath) return null
    return confirmExtendedPath(event, result.filePath, withVeprojExtension(result.filePath))
  })

  ipcMain.handle(IPC.selectProjectOpenPath, async (event) => {
    const result = await showOpenDialogForSender(event, {
      properties: ['openFile'],
      filters: [{ name: `${PRODUCT_NAME}プロジェクト`, extensions: ['veproj'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.exportProject, async (event, payload: ExportPayload) => {
    const onProgress = (percent: number, stage: string): void => {
      notifySender(event, IPC.exportProgress, { percent, stage })
    }
    // 層の画像の置き場は、書き出しが終わったら(成功・失敗・中止のどれでも)片付ける。
    // 隠したテロップ(T1 の「目」)は書き出さない
    const output = { ...payload, project: projectForOutput(payload.project) }
    return withTelopLayer(payload.telopLayer, () => runExport(output, onProgress))
  })
  // Premiere 用 XML(FCP7 xmeml)。XML・SRT・(選べば)見た目どおりのテロップを並べて書く
  ipcMain.handle(IPC.selectPremiereXmlPath, async (event, defaultName: string) => {
    const result = await showSaveDialogForSender(event, {
      defaultPath: defaultName,
      filters: [{ name: 'Premiere 用 XML(Final Cut Pro 7 XML)', extensions: ['xml'] }]
    })
    if (result.canceled || !result.filePath) return null
    const withXml =
      extname(result.filePath).toLowerCase() === '.xml' ? result.filePath : `${result.filePath}.xml`
    const chosen = await confirmExtendedPath(event, result.filePath, withXml)
    if (!chosen) return null
    // XML と同じ名前で並べて書く字幕・テロップ(PNG のフォルダ・ProRes)が既にあれば、上書きしてよいか確かめる
    // (保存ダイアログの上書きの確認は XML のファイルにしか効かない)
    const existing = existingPremiereSidecars(chosen)
    if (existing.length === 0) return chosen
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['上書きする', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '同じ名前で並べて書くファイルがすでにあります',
      detail:
        existing.map((p) => `・${basename(p)}`).join('\n') +
        '\n\n上書きしますか?(テロップの PNG のフォルダは、前回の telop_*.png を消してから書きます)'
    }
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return response === 0 ? chosen : null
  })
  ipcMain.handle(IPC.exportPremiereXml, async (event, payload: PremiereExportPayload) => {
    const onProgress = (percent: number, stage: string): void => {
      notifySender(event, IPC.exportProgress, { percent, stage })
    }
    const protectedPaths = exportProtectedPaths(payload.project)
    // 並べて書く字幕・テロップの動画も、素材・企画ファイルを上書きしないか確かめる
    const sidecars = premiereSidecarPaths(payload.outputPath)
    for (const sidecar of [sidecars.srt, sidecars.telopMov, sidecars.telopDir]) {
      const conflict = exportOutputConflict(sidecar, protectedPaths)
      if (conflict) throw new Error(conflict)
    }
    return withTelopLayer(payload.telopLayer, () =>
      runExclusiveExport((signal) =>
        writeExportGuarded(payload.outputPath, protectedPaths, (xmlWritePath) =>
          // 隠したテロップ(T1 の「目」)の扱いは exportPremiereXml の中で(章・コーナーのマーカーは残す)
          exportPremiereXml(payload, xmlWritePath, {
            ffmpegPath,
            onProgress,
            signal,
            probeChannels: probeAudioChannels
          })
        )
      )
    )
  })
  // テロップの層の画像は、描きながら少しずつ受け取ってディスクへ書く(`telopLayerStage`)
  ipcMain.handle(IPC.telopLayerBegin, (_e, width: number, height: number) =>
    beginTelopLayer(width, height)
  )
  ipcMain.handle(IPC.telopLayerAppend, (_e, id: string, firstIndex: number, images: Uint8Array[]) =>
    appendTelopLayerImages(id, firstIndex, images)
  )
  ipcMain.handle(IPC.telopLayerRelease, (_e, id: string) => releaseTelopLayer(id))
}

/** 保存のダイアログの種類の名前(形式ごと) */
const EXPORT_FILTER_NAME: Record<ExportFormat, string> = {
  mp4: 'MP4動画',
  prores: 'QuickTime(ProRes 422)',
  wav: 'WAV 音声'
}

interface ExportPayload {
  project: Project
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
  outputPath: string
  loudnessNormalization?: boolean
  loudnessTarget?: LoudnessTarget
  engine?: ExportEngine
  /** 形式(既定は MP4)。MP4 以外は区間に分けて書き出す方式で作る */
  format?: ExportFormat
  /** 書き出す範囲(タイムラインの秒)。省略は全体。範囲は区間に分けて書き出す方式で作る */
  range?: { start: number; end: number }
  /**
   * 画面のプロセスが共通レンダラで描いたテロップの層(どちらの書き出し方式でも使う)。
   * `null` は「出すテロップが無い」、省略は「層が無いので ASS で焼く」
   */
  telopLayer?: TelopLayerPayload | null
}

async function runExport(
  payload: ExportPayload,
  onProgress: (percent: number, stage: string) => void
): Promise<{ success: boolean; rangeStartSec?: number }> {
  // 失敗・中止で、壊れた動画が完成品の名前で残らないように(`writeViaPartial`)。
  // 書き出し先が素材・企画ファイル・自動保存なら、始める前に止める(最後の置き換えで
  // 素材が書き出した動画に差し替わり、元の撮影データが消えていた。`exportOutputGuard`)
  return writeExportGuarded(
    payload.outputPath,
    exportProtectedPaths(payload.project),
    (outputPath) => runExportTo({ ...payload, outputPath }, onProgress)
  )
}

/** 書き出しで上書きしてはいけないファイル(企画の素材と、企画ファイル・自動保存) */
function exportProtectedPaths(project: Project): ProtectedPath[] {
  const out = projectSourcePaths(project)
  for (const path of knownProjectPaths) out.push({ path, label: '企画ファイル' })
  if (autosavePath) {
    out.push({ path: autosavePath, label: '自動保存のファイル' })
    out.push({ path: discardedPathFor(autosavePath), label: '退避した自動保存のファイル' })
  }
  return out
}

async function runExportTo(
  payload: ExportPayload,
  onProgress: (percent: number, stage: string) => void
): Promise<{ success: boolean; rangeStartSec?: number }> {
  // 標準の書き出しが OS の決まり(コマンドラインの長さ・一度に開く入力の数)に収まらなければ、
  // 区間ごとの書き出しを使う(収まらないまま起こすと、Windows では main プロセスごと落ちる)
  const format: ExportFormat =
    payload.format === 'prores' || payload.format === 'wav' ? payload.format : 'mp4'
  // ProRes・音声だけ・範囲は、区間に分けて書き出す方式だけが受ける(入れ物と範囲をそこで扱う)
  const range = payload.range
    ? timelineRangeToExportFrames(payload.project, payload.range.start, payload.range.end)
    : null
  if (payload.range && !range) throw new Error('書き出す範囲に、タイムラインのクリップがありません')
  const engine =
    payload.engine === 'segmented' ||
    format !== 'mp4' ||
    range !== null ||
    !standardExportFits(payload.project, process.platform).fits
      ? 'segmented'
      : payload.engine
  if (engine === 'segmented') {
    // 一括書き出しは企画と違う縦横比で書き出すことがあるので、縦横比は引数のほうを使う
    const v2 = projectV1ToV2(
      { ...payload.project, aspectRatio: payload.aspectRatio },
      { resolution: payload.resolutionHeight }
    )
    const done = await runExclusiveExport((signal) =>
      exportSequenceSegmented({
        project: v2,
        outputPath: payload.outputPath,
        quality: payload.quality,
        loudnessNormalization: payload.loudnessNormalization,
        loudnessTarget: normalizeLoudnessTarget(payload.loudnessTarget),
        telopLayer: payload.telopLayer,
        onProgress,
        signal,
        format,
        ...(range ? { range: { startFrame: range.startFrame, endFrame: range.endFrame } } : {})
      })
    )
    // 範囲のときは、実際に書き出した範囲の始まり(書き出しの秒)を返す(点検の時刻を合わせる)
    const fps = v2.sequence.fps.num / v2.sequence.fps.den
    return range ? { success: true, rangeStartSec: done.startFrame / fps } : { success: true }
  }
  await exportProject({
    project: payload.project,
    aspectRatio: payload.aspectRatio,
    resolutionHeight: payload.resolutionHeight,
    quality: payload.quality,
    outputPath: payload.outputPath,
    loudnessNormalization: payload.loudnessNormalization,
    loudnessTarget: normalizeLoudnessTarget(payload.loudnessTarget),
    telopLayer: payload.telopLayer,
    onProgress
  })
  return { success: true }
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

/**
 * 起動は1つだけ。2つ目を開くと、その起動の片付け(`cleanupStaleSegmentDirs`)が、1つ目で書き出し中の
 * 一時フォルダを消しうる。保存も同じファイルへ2つから書き合うことになる。2つ目は1つ目の窓を前に出して閉じる
 */
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
} else {
  // 未処理の例外・拒否、画面や解析のプロセスが落ちたことを userData/logs に残す(diagnostics)
  installCrashLogging()
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

app.whenReady().then(() => {
  if (!hasInstanceLock) return
  electronApp.setAppUserModelId(APP_ID)
  startLibraryWatchers()
  // 前回、書き出しの途中で閉じた・落ちたときの一時フォルダ(数 GB になる)を片付ける
  setTimeout(cleanupStaleSegmentDirs, 5000)
  installAppMenu(is.dev)
  ipcMain.handle(IPC.menuUpdate, (_e, next: Parameters<typeof updateAppMenu>[0]) =>
    updateAppMenu(next ?? {}, is.dev)
  )
  installMenuPopupIpc(ipcMain)
  // ヘルプ > 環境チェック…(GPU・ハードウェアのエンコーダ・ローカル AI の構成を調べる)
  installEnvCheckIpc(ipcMain)
  // バージョン情報(アプリの中のダイアログ)の中身と、そこから開くライセンスの文書
  ipcMain.handle(IPC.appAbout, (): AboutInfo => ({
    product: PRODUCT_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sourceOffer: {
      vendor: PRODUCT_VENDOR,
      vendorEmail: PRODUCT_VENDOR_EMAIL,
      url: SOURCE_OFFER_URL
    }
  }))
  ipcMain.on(IPC.openLicense, (e, doc: unknown) => {
    if (!isLicenseDoc(doc)) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (doc === 'notices') openThirdPartyNotices(win)
    else openChromiumLicenses(win)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle(
    IPC.probeMedia,
    async (_e, filePath: string, options?: { skipDurationScan?: boolean }) =>
      probeMedia(filePath, { skipDurationScan: options?.skipDurationScan === true })
  )
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
  ipcMain.handle(IPC.checkPreviewProxy, (_e, filePath: string, proxyPath: string) =>
    checkPreviewProxy(filePath, proxyPath)
  )
  ipcMain.handle(IPC.checkFilesExist, (_e, filePaths: string[]) =>
    filePaths.filter((p) => !existsSync(p))
  )
  ipcMain.handle(IPC.generateThumbnail, async (_e, filePath: string, atSeconds: number) =>
    stillImages.request(`thumb|${filePath}|${fileStamp(filePath)}|${atSeconds}`, () =>
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
      stillImages.request(
        `frame|${filePath}|${fileStamp(filePath)}|${atSeconds}|${width}x${height}|${fillCrop}|${cropCenter?.x},${cropCenter?.y}|${blurBackground}`,
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
      timelineImages.request(
        `wave|${filePath}|${fileStamp(filePath)}|${rangeStart}|${rangeEnd}|${width}x${height}`,
        () => generateWaveformDataUrl(filePath, rangeStart, rangeEnd, width, height)
      )
  )
  ipcMain.handle(
    IPC.generateWaveformPeaks,
    async (
      e,
      filePath: string,
      rangeStart: number,
      rangeEnd: number,
      columns: number,
      requestId?: string
    ) => {
      const key = requestId ? `${e.sender.id}:${requestId}` : null
      const ac = new AbortController()
      if (key) wavePeakRequests.set(key, ac)
      try {
        return await wavePeaksService().get(filePath, rangeStart, rangeEnd, columns, ac.signal)
      } finally {
        if (key && wavePeakRequests.get(key) === ac) wavePeakRequests.delete(key)
      }
    }
  )
  ipcMain.handle(IPC.cancelWaveformPeaks, (e, requestId: string) => {
    wavePeakRequests.get(`${e.sender.id}:${requestId}`)?.abort()
  })
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
    knownProjectPaths.add(filePath)
    saveProjectFile(filePath, project)
  })
  ipcMain.handle(IPC.loadProject, (_e, filePath: string) => {
    knownProjectPaths.add(filePath)
    return loadProjectFile(filePath)
  })
  ipcMain.handle(IPC.downloadAudioAsset, async (_e, url: string, suggestedName: string) =>
    downloadAudioAsset(url, suggestedName)
  )
  ipcMain.handle(IPC.getEnvApiKeys, () => getEnvApiKeys())
  // API キーは OS の仕組みで暗号化して userData/secrets.json に置く(secretStore。前の版の平文は画面が移す)
  const secretStore = new SecretStore(
    join(app.getPath('userData'), 'secrets.json'),
    safeStorageCipher
  )
  ipcMain.handle(IPC.secretsLoad, () => secretStore.load())
  ipcMain.handle(IPC.secretsSet, (_e, name: unknown, value: unknown) =>
    secretStore.set(name, value)
  )

  autosavePath = join(app.getPath('userData'), 'autosave.veproj')
  ipcMain.on(IPC.setDirtyState, (_e, dirty: boolean) => {
    hasUnsavedChanges = dirty
  })
  ipcMain.on(IPC.setBusyState, (e, state: BusyState | null) =>
    setBusy(BrowserWindow.fromWebContents(e.sender), state)
  )
  ipcMain.on(IPC.notifyDone, (e, title: string, body: string) =>
    notifyDone(BrowserWindow.fromWebContents(e.sender), String(title), String(body))
  )
  ipcMain.handle(IPC.checkAutosave, () => autosaveStatus(autosavePath))
  ipcMain.handle(IPC.loadAutosave, () => {
    const project = loadProjectFile(autosavePath)
    // 復元したら、この自動保存はこのセッションのもの(中身はもう画面にある)。最初の自動保存で
    // これを退避すると、退避先に残っていた前の破棄したデータが、この控えの写しで上書きされて消えていた
    autosaveOverwrittenThisSession = true
    return project
  })
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
    const first = !autosaveOverwrittenThisSession
    // 書き込みの前に「このセッションは書いた」にする。書き込みが失敗しても、次の自動保存が
    // もう一度退避して、退避した前回の作業を上書きしないように
    autosaveOverwrittenThisSession = true
    const keepPreviousDiscarded = first ? takeKeepDiscarded() : false
    return writeAutosaveFile(autosavePath, project, first, {
      onSetAside: () => {
        previousDraftSetAside = true
      },
      keepPreviousDiscarded
    })
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
  ipcMain.handle(IPC.footageScan, (event, root: string, options?: { tracks?: boolean }) =>
    scanFootage(
      root,
      (done, total) => notifySender(event, IPC.footageScanProgress, { done, total }),
      options
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
        // 見つからないファイルは英語の「ENOENT: no such file …」ではなく、ほかと同じ日本語で
        const st = await stat(path).catch((e: NodeJS.ErrnoException) => {
          throw e?.code === 'ENOENT' ? missingFileError() : e
        })
        return cachedEnvelope(ffmpegPath, join(app.getPath('userData'), 'analysis-cache'), {
          path,
          size: st.size,
          mtimeMs: st.mtimeMs
        })
      })
    )
  )
  ipcMain.handle(IPC.asrRun, (event, jobs: AsrJob[], options?: { language?: unknown }) =>
    runAsr(jobs, (m) => notifySender(event, IPC.asrProgress, m), options)
  )
  ipcMain.handle(IPC.asrSetLanguage, (_e, language: unknown) => setAsrLanguage(language))
  ipcMain.handle(IPC.asrCancel, () => cancelAsr())
  ipcMain.handle(IPC.llmRun, (event, requests: LlmRequest[]) =>
    runLlm(requests, (m) => notifySender(event, IPC.llmProgress, m))
  )
  ipcMain.handle(IPC.llmCancel, () => cancelLlm())
  // 読み込めなかったモデルの記録(次から試さない)と、「このPCの AI をもう一度試す」
  ipcMain.handle(IPC.llmLoadFailures, () => listLlmLoadFailures())
  ipcMain.handle(IPC.llmClearLoadFailures, () => clearLlmLoadFailures())
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
        { name: `${PRODUCT_NAME}プロジェクト`, extensions: ['veproj'] },
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
  ipcMain.handle(IPC.systemInfo, () => collectSystemInfo())
  // 画面の未処理のエラーを記録に残す(diagnostics。返事は要らない)
  ipcMain.on(IPC.logRendererError, (_e, payload: unknown) => logRendererError(payload))
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
  // 字幕(SRT)とテロップスタイル(JSON)。拡張子を決めて、選んだファイルだけを読み書きする
  const SUBTITLE_FILTERS: Record<'srt' | 'json', Electron.FileFilter> = {
    srt: { name: '字幕(SRT)', extensions: ['srt'] },
    json: { name: 'テロップスタイル', extensions: ['json'] }
  }
  ipcMain.handle(
    IPC.saveSubtitleFile,
    async (event, defaultName: string, text: string, kind: 'srt' | 'json') => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.SaveDialogOptions = {
        title: kind === 'srt' ? '字幕を書き出す' : 'テロップスタイルを書き出す',
        defaultPath: defaultName,
        filters: [SUBTITLE_FILTERS[kind] ?? SUBTITLE_FILTERS.srt]
      }
      const r = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (r.canceled || !r.filePath) return null
      // Windows のメモ帳・Premiere でも文字化けしないよう、SRT は BOM 付き UTF-8
      await writeFile(r.filePath, (kind === 'srt' ? '\ufeff' : '') + text, 'utf-8')
      return r.filePath
    }
  )
  ipcMain.handle(IPC.openSubtitleFile, async (event, kind: 'srt' | 'json') => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: kind === 'srt' ? '字幕を読み込む' : 'テロップスタイルを読み込む',
      properties: ['openFile'],
      filters: [SUBTITLE_FILTERS[kind] ?? SUBTITLE_FILTERS.srt]
    }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const filePath = r.filePaths[0]
    if (r.canceled || !filePath) return null
    const st = await stat(filePath)
    if (st.size > 20 * 1024 * 1024) throw new Error('ファイルが大きすぎます(20MB まで)')
    const text = (await readFile(filePath, 'utf-8')).replace(/^\ufeff/, '')
    return { path: filePath, text }
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
  autoUpdate = startAppAutoUpdate()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/** 製品に入った package.json(electron-builder.cjs が正式版・持ち主が試す版の印を書く) */
function packagedPackageJson(): unknown {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf-8'))
  } catch {
    return null
  }
}

/** 自動更新(正式版の Windows だけ。autoUpdate) */
let autoUpdate: AutoUpdateHandle | null = null
function startAppAutoUpdate(): AutoUpdateHandle | null {
  const plan = updateCheckPlan({
    isPackaged: app.isPackaged,
    platform: process.platform,
    buildKind: readBuildKind(packagedPackageJson()),
    env: process.env
  })
  return startAutoUpdate(plan, {
    loadUpdater: async () => {
      const m = (await import('electron-updater')) as unknown as {
        autoUpdater?: UpdaterLike
        default?: { autoUpdater?: UpdaterLike }
      }
      const u = m.autoUpdater ?? m.default?.autoUpdater
      if (!u) throw new Error('electron-updater の autoUpdater がありません')
      return u
    },
    ask: async (version) => {
      const win = BrowserWindow.getAllWindows()[0]
      const options: Electron.MessageBoxOptions = {
        type: 'info',
        buttons: ['再起動して更新', 'あとで'],
        defaultId: 1,
        cancelId: 1,
        message: `新しい版(${version})の準備ができました`,
        detail:
          '「あとで」を選ぶと、次にアプリを終了したときに更新します。書き出しなどの途中なら「あとで」を選んでください。'
      }
      const r = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options)
      return r.response === 0 ? 'restart' : 'later'
    },
    log: (message, error) =>
      error === undefined ? console.log(message) : console.warn(message, error),
    requestQuit: () => app.quit()
  })
}

app.on('will-quit', () => {
  autoUpdate?.onWillQuit()
  autoUpdate?.stop()
  stopLibraryWatchers()
  // 動いている ffmpeg(ノイズ除去・試聴用素材・自動確認)を止める。macOS・Linux では親が終わっても残る
  killLiveProcesses()
  // 書き出しのテロップの層の画像(長尺の 4K だと数 GB)を残さない
  releaseAllTelopLayers()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

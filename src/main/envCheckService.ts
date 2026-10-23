import { app, BrowserWindow, dialog, shell, type IpcMain } from 'electron'
import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'
import os from 'os'
import { join } from 'path'
import envCheckWorkerPath from './envCheckWorker?modulePath'
import { runChild } from './childRunner'
import { ffmpegPath, isExportInProgress } from './ffmpegService'
import { listLlmLoadFailures } from './llmService'
import { EnvCheckBusyError, redactResult, runEnvCheck, spawnFfmpeg } from './envCheck'
import type { EnvCheckWorkerDone } from './envCheckWorker'
import { sanitizeLogText } from './crashLog'
import { crashLog } from './diagnostics'
import { IPC } from '@shared/ipc'
import { PRODUCT_NAME } from '@shared/product'
import { ASR_MODEL_ID, asrDeviceOrder } from '@shared/transcript'
import {
  buildEnvCheckReport,
  envCheckFileName,
  type EnvCheckResult,
  type LocalAiCheck
} from '@shared/envCheck'

/**
 * ヘルプ > 環境チェック… の main 側。画面のダイアログ(EnvCheckDialog)から走らせ、結果を返し、
 * テキストで保存する。**どこにも自動では送らない。**
 */

let running: AbortController | null = null

/** ローカル AI の判定と onnxruntime の装置(別プロセス。60 秒で答えなければ止める) */
function probeNative(signal?: AbortSignal): Promise<{
  localAi: LocalAiCheck
  backends: string[]
  backendsError?: string
}> {
  // 止めた後なら別プロセスを立ち上げない
  if (signal?.aborted)
    return Promise.resolve({ localAi: { ok: false, error: '止めました' }, backends: [] })
  return new Promise((resolve) => {
    let done = false
    const finish = (v: {
      localAi: LocalAiCheck
      backends: string[]
      backendsError?: string
    }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const child = runChild(
      envCheckWorkerPath,
      { appVersion: app.getVersion(), failures: listLlmLoadFailures() },
      (m) => {
        if (m.type === 'done') {
          const d = m as unknown as EnvCheckWorkerDone
          finish({ localAi: d.localAi, backends: d.backends, backendsError: d.backendsError })
          return true
        }
        if (m.type === 'error') {
          finish({ localAi: { ok: false, error: String(m.message) }, backends: [] })
          return true
        }
        return false
      },
      (code, stderr) =>
        finish({
          localAi: {
            ok: false,
            error: `調べるプロセスが終わりました(終了コード ${code})${stderr ? `: ${stderr}` : ''}`
          },
          backends: []
        })
    )
    const timer = setTimeout(() => {
      child.kill()
      finish({ localAi: { ok: false, error: '60 秒で答えがなかったので止めました' }, backends: [] })
    }, 60_000)
    signal?.addEventListener('abort', () => {
      child.kill()
      finish({ localAi: { ok: false, error: '止めました' }, backends: [] })
    })
  })
}

/** 文字起こしのモデルをダウンロード済みか(transformers.js の置き場 userData/models) */
function asrModelDownloaded(): boolean {
  return existsSync(join(app.getPath('userData'), 'models', ...ASR_MODEL_ID.split('/')))
}

export async function runEnvCheckNow(onProgress: (p: unknown) => void): Promise<EnvCheckResult> {
  if (running) running.abort()
  const controller = new AbortController()
  running = controller
  // ローカル AI の判定と onnxruntime の装置は 1 回の別プロセスで調べる
  let native: ReturnType<typeof probeNative> | null = null
  const nativeOnce = (): ReturnType<typeof probeNative> =>
    (native ??= probeNative(controller.signal))
  try {
    return await runEnvCheck({
      run: spawnFfmpeg(ffmpegPath),
      app: {
        product: PRODUCT_NAME,
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome
      },
      gpuInfo: () => app.getGPUInfo('complete'),
      gpuInfoBasic: () => app.getGPUInfo('basic'),
      // 書き出しと試し書き出し・速さの測定が取り合わないよう、書き出し中は断る
      busyReason: () =>
        isExportInProgress()
          ? '書き出し中は環境チェックをできません(試し書き出しが本物の書き出しと取り合うため)。書き出しが終わってから調べてください'
          : null,
      gpuFeatures: () => app.getGPUFeatureStatus() as unknown as Record<string, string>,
      localAi: async () => (await nativeOnce()).localAi,
      whisper: async () => {
        const n = await nativeOnce()
        return {
          order: asrDeviceOrder(process.platform),
          backends: n.backends,
          platform: process.platform,
          model: ASR_MODEL_ID,
          downloaded: asrModelDownloaded(),
          error: n.backendsError
        }
      },
      home: os.homedir(),
      onProgress,
      signal: controller.signal
    })
  } finally {
    if (running === controller) running = null
  }
}

export function cancelEnvCheck(): void {
  running?.abort()
  running = null
}

/** 結果をテキストで保存する(保存先は利用者が選ぶ)。保存したパス、やめたら null */
export async function saveEnvCheck(
  win: BrowserWindow | null,
  result: EnvCheckResult
): Promise<string | null> {
  // 画面から戻ってきた値なので、もう一度伏せる
  const safe = redactResult(result, os.homedir())
  const text = sanitizeLogText(buildEnvCheckReport(safe), os.homedir(), {
    maxChars: Number.POSITIVE_INFINITY
  })
  const options: Electron.SaveDialogOptions = {
    title: '環境チェックの結果を保存',
    defaultPath: join(app.getPath('desktop'), envCheckFileName(PRODUCT_NAME, new Date())),
    filters: [{ name: 'テキスト', extensions: ['txt'] }]
  }
  const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (r.canceled || !r.filePath) return null
  await writeFile(r.filePath, '﻿' + text, 'utf-8')
  shell.showItemInFolder(r.filePath)
  return r.filePath
}

function isResult(v: unknown): v is EnvCheckResult {
  const r = v as EnvCheckResult
  return Boolean(r && typeof r === 'object' && r.app && r.ffmpeg && Array.isArray(r.speed))
}

export function installEnvCheckIpc(ipc: Pick<IpcMain, 'handle' | 'on'>): void {
  ipc.handle(IPC.envCheckRun, async (e) => {
    try {
      return await runEnvCheckNow((p) => {
        if (!e.sender.isDestroyed()) e.sender.send(IPC.envCheckProgress, p)
      })
    } catch (err) {
      if (!(err instanceof EnvCheckBusyError))
        crashLog()?.write('main', '環境チェックに失敗しました', err)
      throw err
    }
  })
  ipc.on(IPC.envCheckCancel, () => cancelEnvCheck())
  ipc.handle(IPC.envCheckSave, async (e, result: unknown) => {
    if (!isResult(result)) return null
    return saveEnvCheck(BrowserWindow.fromWebContents(e.sender), result)
  })
}

import { app, BrowserWindow, dialog, shell } from 'electron'
import { mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import os from 'os'
import { join } from 'path'
import type { SystemInfo } from '@shared/systemInfo'
import { PRODUCT_NAME } from '@shared/product'
import { buildBugReport, CrashLog, describeError, RateLimiter } from './crashLog'

/**
 * 不具合の記録と、報告用の情報のまとめ(ヘルプ > ログのフォルダを開く / 不具合の報告用に情報をまとめる)。
 * 記録の決まり(何を書き、何を書かないか)は crashLog.ts。**どこにも自動では送らない。**
 */

let log: CrashLog | null = null
/** 画面から届く記録は 1 分に 30 件まで(同じエラーが描画のたびに出て記録を埋めない) */
const rendererLimit = new RateLimiter(30, 60_000)

export function crashLog(): CrashLog | null {
  return log
}

/** 起動の最初に1回。main の未処理の例外・拒否と、プロセスが落ちたことを記録する */
export function installCrashLogging(): void {
  if (log) return
  log = new CrashLog({ dir: join(app.getPath('userData'), 'logs'), home: os.homedir() })
  log.write(
    'main',
    `起動 ${PRODUCT_NAME} ${app.getVersion()} / Electron ${process.versions.electron} / ${os.type()} ${os.release()} (${os.arch()})`
  )
  // Monitor は見るだけ(既定の動き = Electron のエラーの表示・終了を変えない)
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    log?.write('main', origin === 'unhandledRejection' ? '未処理の拒否' : '未処理の例外', error)
  })
  process.on('unhandledRejection', (reason) => {
    log?.write('main', '未処理の拒否', reason)
    // 今までどおり開発者の画面にも出す
    console.error('Unhandled rejection:', reason)
  })
  // 画面のプロセスが落ちた(読み込み直しは rendererRecovery が決める。ここは記録だけ)
  app.on('render-process-gone', (_e, _contents, details) => {
    log?.write('process', `画面のプロセスが終了: ${details.reason}(終了コード ${details.exitCode})`)
  })
  // GPU・解析(文字起こし・AI など)のプロセスが終わった。正常な終了は書かない
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    const name = details.serviceName || details.name || ''
    log?.write(
      'process',
      `${details.type}${name ? ` ${name}` : ''} のプロセスが終了: ${details.reason}(終了コード ${details.exitCode})`
    )
  })
}

/** 画面からの記録(window の error・unhandledrejection・描画の失敗) */
export function logRendererError(payload: unknown): void {
  if (!log || !rendererLimit.take()) return
  const p = (payload ?? {}) as { kind?: unknown; message?: unknown; stack?: unknown }
  const kind = typeof p.kind === 'string' ? p.kind.slice(0, 80) : '画面のエラー'
  const message = typeof p.message === 'string' ? p.message : ''
  const stack = typeof p.stack === 'string' ? p.stack : ''
  log.write('renderer', kind, [message, stack].filter(Boolean).join('\n') || undefined)
}

/** 処理の記録・報告に載せる PC の構成 */
export async function collectSystemInfo(): Promise<SystemInfo> {
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
}

/** ヘルプ > ログのフォルダを開く */
export async function openLogFolder(win: BrowserWindow | null): Promise<void> {
  const dir = log?.dir ?? join(app.getPath('userData'), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // 開けなければ下で知らせる
  }
  const error = await shell.openPath(dir)
  if (error) {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'ログのフォルダ',
      message: 'ログのフォルダを開けませんでした',
      detail: `${dir}\n${error}`
    }
    await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  }
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** ヘルプ > 不具合の報告用に情報をまとめる。保存先は利用者が選ぶ(自動では送らない) */
export async function saveBugReport(win: BrowserWindow | null): Promise<void> {
  try {
    const info = await collectSystemInfo()
    const features = (() => {
      try {
        return app.getGPUFeatureStatus() as unknown as Record<string, string>
      } catch {
        return {}
      }
    })()
    const text = buildBugReport(
      info,
      { productName: PRODUCT_NAME, version: app.getVersion(), versions: process.versions },
      log?.recent() ?? '',
      os.freemem() / 1024 ** 3,
      features,
      os.homedir()
    )
    const options: Electron.SaveDialogOptions = {
      title: '不具合の報告用の情報を保存',
      defaultPath: join(
        app.getPath('desktop'),
        `${PRODUCT_NAME}-不具合の報告-${stamp(new Date())}.txt`
      ),
      filters: [{ name: 'テキスト', extensions: ['txt'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return
    await writeFile(r.filePath, '﻿' + text, 'utf-8')
    shell.showItemInFolder(r.filePath)
  } catch (e) {
    log?.write('main', '報告用の情報を作れませんでした', e)
    const options: Electron.MessageBoxOptions = {
      type: 'error',
      title: '不具合の報告',
      message: '報告用の情報を保存できませんでした',
      detail: describeError(e).split('\n')[0]
    }
    await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
  }
}

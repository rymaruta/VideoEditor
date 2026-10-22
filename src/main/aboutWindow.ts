import { app, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { PRODUCT_NAME } from '@shared/product'

/**
 * バージョン情報と、サードパーティのライセンス表記(resources/THIRD_PARTY_NOTICES.txt)。
 * 表記はインストーラを作るときに `npm run licenses`(scripts/third-party-notices.mjs)が作る。
 */

const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'

/** 表記のファイルの場所(製品では asar の外 = app.asar.unpacked/resources。開発中はプロジェクトの resources) */
export function noticesPath(): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', NOTICES_FILE).replace('app.asar', 'app.asar.unpacked'),
    join(app.getAppPath(), 'resources', NOTICES_FILE),
    join(process.resourcesPath ?? '', NOTICES_FILE)
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

let noticesWindow: BrowserWindow | null = null

/** ライセンス表記を別の窓で見せる(文字だけ。スクリプトは動かさない) */
export function openThirdPartyNotices(parent?: BrowserWindow | null): void {
  const path = noticesPath()
  if (!path) {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: 'サードパーティのライセンス',
      message: 'ライセンス表記のファイルが見つかりません',
      detail: '製品版ではインストール先に入っています。開発中は「npm run licenses」で作れます。'
    }
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    return
  }
  if (noticesWindow && !noticesWindow.isDestroyed()) {
    noticesWindow.focus()
    return
  }
  noticesWindow = new BrowserWindow({
    width: 860,
    height: 720,
    title: `サードパーティのライセンス — ${PRODUCT_NAME}`,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false
    }
  })
  noticesWindow.removeMenu()
  // 文書の中の題名で窓の題名を上書きさせない
  noticesWindow.on('page-title-updated', (e) => e.preventDefault())
  noticesWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  noticesWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  noticesWindow.on('closed', () => (noticesWindow = null))
  void noticesWindow.loadFile(path)
}

/** ヘルプ > バージョン情報 */
export async function showAboutDialog(win: BrowserWindow): Promise<void> {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: 'バージョン情報',
    message: `${PRODUCT_NAME} ${app.getVersion()}`,
    detail:
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / Node.js ${process.versions.node}\n\n` +
      'この製品は FFmpeg(GPL)などのオープンソースのソフトウェア・フォント・AI のモデルを使っています。' +
      '著作権と各ライセンスは「サードパーティのライセンス」で読めます。',
    buttons: ['OK', 'サードパーティのライセンス…'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (response === 1) openThirdPartyNotices(win)
}

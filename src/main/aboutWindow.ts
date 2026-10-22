import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { PRODUCT_NAME } from '@shared/product'
import { docNavigation } from './docNavigation'

/**
 * バージョン情報と、サードパーティのライセンス表記。
 * - resources/THIRD_PARTY_NOTICES.txt: インストーラを作るときに `npm run licenses`
 *   (scripts/third-party-notices.mjs)が作る
 * - resources/LICENSES.chromium.html: 同じスクリプトが Electron から写す(electron-builder は macOS・snap で
 *   インストール先の LICENSES.chromium.html を消すため、どの OS でも resources に同梱する)
 */

const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'
const CHROMIUM_FILE = 'LICENSES.chromium.html'

/** 同梱の文書の場所(製品では asar の外 = app.asar.unpacked/resources。開発中はプロジェクトの resources) */
function bundledDocPath(file: string): string | null {
  const candidates = [
    join(app.getAppPath(), 'resources', file).replace('app.asar', 'app.asar.unpacked'),
    join(app.getAppPath(), 'resources', file),
    join(process.resourcesPath ?? '', file)
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

export function noticesPath(): string | null {
  return bundledDocPath(NOTICES_FILE)
}

const docWindows = new Map<string, BrowserWindow>()

/** 同梱の文書を別の窓で見せる(スクリプトは動かさない・外へ移らない) */
function openDocWindow(file: string, title: string, parent?: BrowserWindow | null): void {
  const path = bundledDocPath(file)
  if (!path) {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title,
      message: `${title}のファイルが見つかりません`,
      detail: '製品版ではインストール先に入っています。開発中は「npm run licenses」で作れます。'
    }
    void (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    return
  }
  const open = docWindows.get(file)
  if (open && !open.isDestroyed()) {
    open.focus()
    return
  }
  const win = new BrowserWindow({
    width: 860,
    height: 720,
    title: `${title} — ${PRODUCT_NAME}`,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false
    }
  })
  docWindows.set(file, win)
  win.removeMenu()
  // 文書の中の題名で窓の題名を上書きさせない
  win.on('page-title-updated', (e) => e.preventDefault())
  // 同じ文書の中の移動(目次のリンク)だけ許す。https のリンクは既定のブラウザで開く(docNavigation)
  const follow = (url: string): boolean => {
    const action = docNavigation(url, path)
    if (action === 'external') void shell.openExternal(url)
    return action === 'allow'
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    follow(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!follow(url)) e.preventDefault()
  })
  win.on('closed', () => docWindows.delete(file))
  void win.loadFile(path)
}

/** ヘルプ > サードパーティのライセンス */
export function openThirdPartyNotices(parent?: BrowserWindow | null): void {
  openDocWindow(NOTICES_FILE, 'サードパーティのライセンス', parent)
}

/** Chromium とその部品のライセンス */
export function openChromiumLicenses(parent?: BrowserWindow | null): void {
  openDocWindow(CHROMIUM_FILE, 'Chromium のライセンス', parent)
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
      '著作権と各ライセンスは「サードパーティのライセンス」「Chromium のライセンス」で読めます。',
    buttons: ['OK', 'サードパーティのライセンス…', 'Chromium のライセンス…'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  if (response === 1) openThirdPartyNotices(win)
  if (response === 2) openChromiumLicenses(win)
}

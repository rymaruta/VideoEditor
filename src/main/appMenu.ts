import { BrowserWindow, Menu, type IpcMain, type MenuItemConstructorOptions } from 'electron'
import {
  buildMenuTemplate,
  type MenuFileState,
  type MenuItemSpec,
  type MenuShortcuts
} from '@shared/appMenu'
import { IPC } from '@shared/ipc'
import { menuPopupPosition } from '@shared/windowChrome'
import { openThirdPartyNotices, showAboutDialog } from './aboutWindow'
import { openLogFolder, saveBugReport } from './diagnostics'

/**
 * メニューバーを Electron のメニューにする。項目の形は `@shared/appMenu`。
 *
 * **キーは横取りしない**(`registerAccelerator: false`)。表示だけ出して、実際のキーは
 * 画面側の既存の処理(キー配置の切り替えにも追従している)が受ける。メニューでも受けると、
 * 同じ操作が2回走る。
 */

let shortcuts: MenuShortcuts = {}
let windows: { id: string; label: string }[] = []
let fileState: MenuFileState = { recent: [], canRestoreDiscarded: false }

function sendCommand(id: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  // バージョン情報・ライセンス表記・記録は main だけで済む(画面へ送らない)
  if (id === 'help.about') {
    void showAboutDialog(win)
    return
  }
  if (id === 'help.licenses') {
    openThirdPartyNotices(win)
    return
  }
  if (id === 'help.openLogs') {
    void openLogFolder(win)
    return
  }
  if (id === 'help.bugReport') {
    void saveBugReport(win)
    return
  }
  win.webContents.send(IPC.menuCommand, id)
}

function toElectron(spec: MenuItemSpec): MenuItemConstructorOptions {
  if (spec.type === 'separator') return { type: 'separator' }
  const item: MenuItemConstructorOptions = { label: spec.label }
  if (spec.enabled === false) item.enabled = false
  if (spec.role) item.role = spec.role
  if (spec.accelerator) {
    item.accelerator = spec.accelerator
    item.registerAccelerator = spec.registerAccelerator === true
  }
  if (spec.id) {
    const id = spec.id
    item.click = () => sendCommand(id)
  }
  if (spec.submenu) item.submenu = spec.submenu.map(toElectron)
  return item
}

export function installAppMenu(isDev: boolean): void {
  const template = buildMenuTemplate(
    shortcuts,
    windows,
    { isDev, isMac: process.platform === 'darwin' },
    fileState
  )
  Menu.setApplicationMenu(Menu.buildFromTemplate(template.map(toElectron)))
}

/** 画面からキー配置・パネルの一覧を受け取って、メニューを作り直す */
export function updateAppMenu(
  next: {
    shortcuts?: MenuShortcuts
    windows?: { id: string; label: string }[]
    file?: MenuFileState
  },
  isDev: boolean
): void {
  if (next.shortcuts) shortcuts = next.shortcuts
  if (Array.isArray(next.windows)) windows = next.windows
  if (next.file && Array.isArray(next.file.recent)) {
    fileState = {
      recent: next.file.recent.filter((r) => typeof r === 'string').slice(0, 15),
      canRestoreDiscarded: Boolean(next.file.canRestoreDiscarded)
    }
  }
  installAppMenu(isDev)
}

/**
 * 上の帯の「メニュー」ボタンから、アプリのメニュー(メニューバーと同じもの)を出す。
 * Windows / Linux は OS のメニューバーを出さないので、ここから開く(`@shared/windowChrome`)。
 * 位置はボタンの左下(窓の中の座標)。おかしな値ならマウスの位置
 */
export function popupAppMenu(win: BrowserWindow | null | undefined, at?: unknown): boolean {
  const menu = Menu.getApplicationMenu()
  if (!menu || !win || win.isDestroyed()) return false
  const pos = menuPopupPosition(at as { x?: unknown; y?: unknown } | undefined)
  menu.popup({ window: win, ...(pos ?? {}) })
  return true
}

/** メニューボタンの IPC(画面 → main)を受ける */
export function installMenuPopupIpc(ipc: Pick<IpcMain, 'on'>): void {
  ipc.on(IPC.menuPopup, (e, at: unknown) => {
    popupAppMenu(BrowserWindow.fromWebContents(e.sender), at)
  })
}

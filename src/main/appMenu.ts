import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import {
  buildMenuTemplate,
  type MenuFileState,
  type MenuItemSpec,
  type MenuShortcuts
} from '@shared/appMenu'
import { IPC } from '@shared/ipc'

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
  if (id === 'help.about') {
    void dialog.showMessageBox(win, {
      type: 'info',
      title: 'バージョン情報',
      message: `VideoEditor ${app.getVersion()}`,
      detail: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`
    })
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

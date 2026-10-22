import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  menu: null as null | { popup: (...a: unknown[]) => void },
  win: null as null | { isDestroyed: () => boolean }
}))

vi.mock('electron', () => ({
  Menu: {
    getApplicationMenu: () => state.menu,
    setApplicationMenu: () => undefined,
    buildFromTemplate: (t: unknown) => t
  },
  BrowserWindow: {
    fromWebContents: () => state.win,
    getFocusedWindow: () => state.win,
    getAllWindows: () => (state.win ? [state.win] : [])
  }
}))
vi.mock('@main/aboutWindow', () => ({ openThirdPartyNotices: vi.fn(), showAboutDialog: vi.fn() }))
vi.mock('@main/diagnostics', () => ({ openLogFolder: vi.fn(), saveBugReport: vi.fn() }))

import { installMenuPopupIpc, popupAppMenu } from '@main/appMenu'
import { IPC } from '@shared/ipc'

let popup: ReturnType<typeof vi.fn>
beforeEach(() => {
  popup = vi.fn()
  state.menu = { popup }
  state.win = { isDestroyed: () => false }
})

describe('上の帯のメニューボタン(アプリのメニューを出す)', () => {
  it('IPC を受けて、送った窓のボタンの左下にアプリのメニューを出す', () => {
    const handlers = new Map<string, (e: unknown, ...args: unknown[]) => void>()
    installMenuPopupIpc({
      on: ((ch: string, fn: (e: unknown, ...a: unknown[]) => void) => {
        handlers.set(ch, fn)
      }) as never
    })
    const h = handlers.get(IPC.menuPopup)
    expect(h).toBeDefined()
    h!({ sender: {} }, { x: 10.2, y: 47.8 })
    expect(popup).toHaveBeenCalledWith({ window: state.win, x: 10, y: 48 })
  })
  it('位置がおかしければマウスの位置に出す', () => {
    expect(popupAppMenu(state.win as never, { x: 'a' })).toBe(true)
    expect(popup).toHaveBeenCalledWith({ window: state.win })
  })
  it('メニューが無い・窓が閉じたなら何もしない', () => {
    expect(popupAppMenu(null)).toBe(false)
    expect(popupAppMenu({ isDestroyed: () => true } as never, { x: 1, y: 1 })).toBe(false)
    state.menu = null
    expect(popupAppMenu({ isDestroyed: () => false } as never)).toBe(false)
    expect(popup).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  menu: null as null | {
    items: { label: string; submenu?: { popup: (...a: unknown[]) => void } }[]
  },
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
vi.mock('@main/aboutWindow', () => ({ openThirdPartyNotices: vi.fn() }))
vi.mock('@main/diagnostics', () => ({ openLogFolder: vi.fn(), saveBugReport: vi.fn() }))

import { installMenuPopupIpc, popupTopMenu } from '@main/appMenu'
import { menuMnemonic, topMenuMnemonics } from '@shared/appMenu'
import { IPC } from '@shared/ipc'
import { menuMnemonicFor } from '@renderer/lib/altMenuKey'

let file: ReturnType<typeof vi.fn>
let edit: ReturnType<typeof vi.fn>
beforeEach(() => {
  file = vi.fn()
  edit = vi.fn()
  state.menu = {
    items: [
      { label: 'ファイル(&F)', submenu: { popup: file } },
      { label: '編集(&E)', submenu: { popup: edit } }
    ]
  }
  state.win = { isDestroyed: () => false }
})

describe('メニューのニーモニック(Alt+F でファイルを開く。監査 中4)', () => {
  it('上の段のニーモニックはメニューの & 指定から(F/E/C/S/T/A/V/W/H)', () => {
    expect(menuMnemonic('ファイル(&F)')).toBe('F')
    expect(menuMnemonic('表示')).toBeNull()
    expect(topMenuMnemonics()).toEqual(['F', 'E', 'C', 'S', 'T', 'A', 'V', 'W', 'H'])
  })
  it('Alt+英字だけを見分ける(キーの位置で)。キー操作の Alt+X・Alt+Backspace とはぶつからない', () => {
    const m = topMenuMnemonics()
    const k = (over: Record<string, unknown>): never =>
      ({
        key: 'f',
        code: 'KeyF',
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...over
      }) as never
    expect(menuMnemonicFor(k({}), m)).toBe('F')
    // macOS の Option+F は別の文字になるが、位置で見る
    expect(menuMnemonicFor(k({ key: 'ƒ' }), m)).toBe('F')
    expect(menuMnemonicFor(k({ key: 'x', code: 'KeyX' }), m)).toBeNull()
    expect(menuMnemonicFor(k({ key: 'Backspace', code: 'Backspace' }), m)).toBeNull()
    expect(menuMnemonicFor(k({ altKey: false }), m)).toBeNull()
    expect(menuMnemonicFor(k({ ctrlKey: true }), m)).toBeNull()
    expect(menuMnemonicFor(k({ shiftKey: true }), m)).toBeNull()
  })
  it('IPC を受けて、上の段のそのメニューを出す', () => {
    const handlers = new Map<string, (e: unknown, ...args: unknown[]) => void>()
    installMenuPopupIpc({
      on: ((ch: string, fn: (e: unknown, ...a: unknown[]) => void) => {
        handlers.set(ch, fn)
      }) as never
    })
    handlers.get(IPC.menuPopupTop)!({ sender: {} }, 'E', { x: 8, y: 46 })
    expect(edit).toHaveBeenCalledWith({ window: state.win, x: 8, y: 46 })
    expect(file).not.toHaveBeenCalled()
  })
  it('知らない英字・おかしな値は何もしない', () => {
    expect(popupTopMenu(state.win as never, 'Q')).toBe(false)
    expect(popupTopMenu(state.win as never, 'ff')).toBe(false)
    expect(popupTopMenu(state.win as never, 3)).toBe(false)
    expect(popupTopMenu(null, 'F')).toBe(false)
    expect(file).not.toHaveBeenCalled()
  })
})

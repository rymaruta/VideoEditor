import { describe, expect, it } from 'vitest'
import { buildMenuTemplate, displayToAccelerator, type MenuItemSpec } from '@shared/appMenu'

const flatten = (items: MenuItemSpec[]): MenuItemSpec[] =>
  items.flatMap((i) => [i, ...(i.submenu ? flatten(i.submenu) : [])])

describe('appMenu — Windows の編集ソフトと同じメニューバー', () => {
  it('画面のキー表示を Electron の形へ直す。直せないものは出さない', () => {
    expect(displayToAccelerator('Ctrl+Shift+Z')).toBe('CmdOrCtrl+Shift+Z')
    expect(displayToAccelerator('Space')).toBe('Space')
    expect(displayToAccelerator('S')).toBe('S')
    expect(displayToAccelerator('Delete')).toBe('Delete')
    expect(displayToAccelerator('⌘+D')).toBe('CmdOrCtrl+D')
    expect(displayToAccelerator('Ctrl+?')).toBeUndefined()
    expect(displayToAccelerator('')).toBeUndefined()
    expect(displayToAccelerator(undefined)).toBeUndefined()
  })

  it('並びは ファイル・編集・クリップ・シーケンス・テロップ・自動編集・表示・ウィンドウ・ヘルプ(アクセスキー付き)', () => {
    const t = buildMenuTemplate({}, [], { isDev: false, isMac: false })
    expect(t.map((m) => m.label)).toEqual([
      'ファイル(&F)',
      '編集(&E)',
      'クリップ(&C)',
      'シーケンス(&S)',
      'テロップ(&T)',
      '自動編集(&A)',
      '表示(&V)',
      'ウィンドウ(&W)',
      'ヘルプ(&H)'
    ])
  })

  it('ショートカットの表示はキー配置から作る(配置を変えると表示も変わる)', () => {
    const t = buildMenuTemplate({ split: 'Ctrl+K', undo: 'Ctrl+Z' }, [], {
      isDev: false,
      isMac: false
    })
    const items = flatten(t)
    expect(items.find((i) => i.id === 'clip.split')?.accelerator).toBe('CmdOrCtrl+K')
    expect(items.find((i) => i.id === 'edit.undo')?.accelerator).toBe('CmdOrCtrl+Z')
  })

  it('ウィンドウの欄には渡したパネルが並ぶ。開発者ツールは開発中だけ', () => {
    const t = buildMenuTemplate({}, [{ id: 'export', label: '書き出し' }], {
      isDev: false,
      isMac: false
    })
    const win = t.find((m) => m.label === 'ウィンドウ(&W)')!
    expect(win.submenu).toEqual([{ label: '書き出し', id: 'window.export' }])
    expect(flatten(t).some((i) => i.role === 'toggleDevTools')).toBe(false)
    expect(
      flatten(buildMenuTemplate({}, [], { isDev: true, isMac: false })).some(
        (i) => i.role === 'toggleDevTools'
      )
    ).toBe(true)
  })

  it('mac では先頭にアプリの欄が付く', () => {
    expect(buildMenuTemplate({}, [], { isDev: false, isMac: true })[0].label).toBe('VideoEditor')
  })
})

describe('メニューのキーの受け方', () => {
  it('画面のキー操作に無いファイルの操作(開く・書き出し など)のキーはメニューで受け、画面が受ける操作は受けない', () => {
    const items = flatten(buildMenuTemplate({}, [], { isDev: false, isMac: false }))
    const reg = (id: string): boolean | undefined =>
      items.find((i) => i.id === id)?.registerAccelerator
    for (const id of [
      'file.new',
      'file.newEpisode',
      'file.open',
      'file.saveAs',
      'file.importVideo',
      'file.export'
    ])
      expect(reg(id), id).toBe(true)
    for (const id of ['file.save', 'edit.undo', 'clip.delete']) expect(reg(id), id).not.toBe(true)
  })
})

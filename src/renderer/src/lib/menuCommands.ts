import { useEffect, useRef } from 'react'
import type { MenuShortcuts } from '@shared/appMenu'
import { defaultTextStyle } from '@shared/textStyle'
import { getTotalDuration, useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { getKeymap, SHORTCUT_ACTIONS, type ShortcutAction } from './keymap'
import { newOverlayRange } from './textOverlayPlacement'

/**
 * メニューバーで押された項目を、**既存の操作**へつなぐ。
 *
 * - キーで出来る操作(分割・削除・コピー・再生 など)は、**今のキー配置のキーを押したことにして**
 *   既存のキー処理に渡す。メニュー専用の処理を別に書くと、キーとメニューで挙動が分かれていく
 *   (モーダル中は効かない、入力欄では効かない、などの門もキー処理側にしか育たない)。
 * - パネルが持っている操作(読み込み・ライブラリ・自動編集の画面を開く 等)は、
 *   `ve:menu` の出来事として流し、持ち主のパネルが受ける(`useMenuCommand`)。
 */

const MENU_EVENT = 've:menu'

/** パネルがメニューの項目を受ける */
export function useMenuCommand(handler: (id: string) => void): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    const listener = (e: Event): void => ref.current((e as CustomEvent<string>).detail)
    window.addEventListener(MENU_EVENT, listener)
    return () => window.removeEventListener(MENU_EVENT, listener)
  }, [])
}

export function emitMenuCommand(id: string): void {
  window.dispatchEvent(new CustomEvent(MENU_EVENT, { detail: id }))
}

const KEY_ACTIONS: Record<string, ShortcutAction> = {
  'clip.split': 'split',
  'clip.delete': 'delete',
  'clip.copy': 'copy',
  'clip.paste': 'paste',
  'clip.duplicate': 'duplicate',
  'sequence.playPause': 'playPause'
}

/** 今のキー配置で、その操作のキーを押したことにする */
export function pressShortcut(action: ShortcutAction): void {
  const binding = getKeymap(useSettingsStore.getState().keymapScheme)[action]
  // 入力欄にフォーカスがあるとキー処理は「文字を打っている」として何もしないので、外しておく
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  window.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: binding.key,
      code: binding.key === ' ' ? 'Space' : undefined,
      ctrlKey: Boolean(binding.ctrl),
      shiftKey: Boolean(binding.shift),
      bubbles: true,
      cancelable: true
    })
  )
}

export function menuShortcutsFor(scheme: Parameters<typeof getKeymap>[0]): MenuShortcuts {
  const keymap = getKeymap(scheme)
  const out: MenuShortcuts = {}
  for (const action of SHORTCUT_ACTIONS) out[action] = keymap[action].display
  return out
}

/** App に1回だけ置く。メニューの表示を今の設定に合わせ、押された項目を振り分ける */
export function useAppMenu(windows: readonly { id: string; label: string }[]): void {
  const scheme = useSettingsStore((s) => s.keymapScheme)
  const windowsKey = windows.map((w) => `${w.id}:${w.label}`).join('|')

  useEffect(() => {
    void window.api
      .updateMenu({ shortcuts: menuShortcutsFor(scheme), windows: [...windows] })
      .catch(() => {})
    // windows は表示用の一覧で、中身が同じなら作り直さない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheme, windowsKey])

  useEffect(
    () =>
      window.api.onMenuCommand((id) => {
        const store = useProjectStore.getState()
        if (id === 'edit.undo') return store.undo()
        if (id === 'edit.redo') return store.redo()
        const action = KEY_ACTIONS[id]
        if (action) return pressShortcut(action)
        if (id === 'telop.add') {
          store.addTextOverlay({
            text: '新しいテキスト',
            ...newOverlayRange(store.playheadTime, getTotalDuration(store.project)),
            style: defaultTextStyle(),
            source: 'manual'
          })
          emitMenuCommand('window.text')
          return
        }
        emitMenuCommand(id)
      }),
    []
  )
}

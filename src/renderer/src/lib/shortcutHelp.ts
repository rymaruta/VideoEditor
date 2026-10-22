import { create } from 'zustand'
import {
  EDITOR_ACTION_GROUPS,
  formatKeyDisplay,
  getActionLabel,
  getEditorActionLabel,
  getEditorKeymap,
  getKeymap,
  type KeymapScheme,
  type ShortcutAction
} from './keymap'

/** キー操作の一覧(? / Ctrl+/)を開いているか */
export const useShortcutHelpStore = create<{
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open }))
}))

export interface ShortcutHelpRow {
  label: string
  keys: string[]
}

export interface ShortcutHelpSection {
  title: string
  rows: ShortcutHelpRow[]
}

const BASIC_ACTIONS: ShortcutAction[] = [
  'playPause',
  'split',
  'delete',
  'copy',
  'paste',
  'duplicate',
  'undo',
  'redo',
  'save'
]

/** 一覧に出す中身(今のキー配置の分。macOS は ⌘ ⌥ ⇧ で書く) */
export function shortcutHelpSections(scheme: KeymapScheme, mac: boolean): ShortcutHelpSection[] {
  const fmt = (d: string): string => formatKeyDisplay(d, mac)
  const keymap = getKeymap(scheme)
  const editor = getEditorKeymap(scheme)
  const basic: ShortcutHelpSection = {
    title: '基本',
    rows: [
      ...BASIC_ACTIONS.map((a) => ({
        label: getActionLabel(a),
        keys: [
          fmt(keymap[a].display),
          ...(a === 'redo' ? [fmt('Ctrl+Y')] : []),
          ...(a === 'delete' ? [mac ? '⌦' : 'Backspace'] : [])
        ]
      })),
      { label: '1フレーム移動', keys: ['←', '→'] },
      { label: '10フレーム移動', keys: [fmt('Shift+←'), fmt('Shift+→')] },
      { label: '道具(選択・トリム・カミソリ)', keys: ['A', 'T', 'B'] }
    ]
  }
  return [
    basic,
    ...EDITOR_ACTION_GROUPS.map((g) => ({
      title: g.title,
      rows: g.actions.map((a) => ({
        label: getEditorActionLabel(a),
        keys: editor[a].map((b) => fmt(b.display))
      }))
    }))
  ]
}

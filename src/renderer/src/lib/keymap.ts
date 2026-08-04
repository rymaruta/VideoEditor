export type KeymapScheme = 'default' | 'premiere' | 'capcut'

export type ShortcutAction =
  'undo' | 'redo' | 'copy' | 'paste' | 'duplicate' | 'save' | 'playPause' | 'split' | 'delete'

export interface KeyBinding {
  key: string
  ctrl?: boolean
  shift?: boolean
  display: string
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  'split',
  'delete',
  'copy',
  'paste',
  'duplicate',
  'undo',
  'redo',
  'playPause',
  'save'
]

const ACTION_LABELS: Record<ShortcutAction, string> = {
  undo: '元に戻す',
  redo: 'やり直す',
  copy: 'コピー',
  paste: '貼り付け',
  duplicate: '複製',
  save: '保存',
  playPause: '再生/停止',
  split: '分割',
  delete: '削除'
}

const KEYMAPS: Record<KeymapScheme, Record<ShortcutAction, KeyBinding>> = {
  default: {
    undo: { key: 'z', ctrl: true, display: 'Ctrl+Z' },
    redo: { key: 'z', ctrl: true, shift: true, display: 'Ctrl+Shift+Z' },
    copy: { key: 'c', ctrl: true, display: 'Ctrl+C' },
    paste: { key: 'v', ctrl: true, display: 'Ctrl+V' },
    duplicate: { key: 'd', ctrl: true, display: 'Ctrl+D' },
    save: { key: 's', ctrl: true, display: 'Ctrl+S' },
    playPause: { key: ' ', display: 'Space' },
    split: { key: 's', display: 'S' },
    delete: { key: 'Delete', display: 'Delete' }
  },
  premiere: {
    undo: { key: 'z', ctrl: true, display: 'Ctrl+Z' },
    redo: { key: 'z', ctrl: true, shift: true, display: 'Ctrl+Shift+Z' },
    copy: { key: 'c', ctrl: true, display: 'Ctrl+C' },
    paste: { key: 'v', ctrl: true, display: 'Ctrl+V' },
    duplicate: { key: 'd', ctrl: true, display: 'Ctrl+D' },
    save: { key: 's', ctrl: true, display: 'Ctrl+S' },
    playPause: { key: ' ', display: 'Space' },
    split: { key: 'k', ctrl: true, display: 'Ctrl+K' },
    delete: { key: 'Delete', display: 'Delete' }
  },
  capcut: {
    undo: { key: 'z', ctrl: true, display: 'Ctrl+Z' },
    redo: { key: 'z', ctrl: true, shift: true, display: 'Ctrl+Shift+Z' },
    copy: { key: 'c', ctrl: true, display: 'Ctrl+C' },
    paste: { key: 'v', ctrl: true, display: 'Ctrl+V' },
    duplicate: { key: 'd', ctrl: true, display: 'Ctrl+D' },
    save: { key: 's', ctrl: true, display: 'Ctrl+S' },
    playPause: { key: ' ', display: 'Space' },
    split: { key: 'b', ctrl: true, display: 'Ctrl+B' },
    delete: { key: 'Delete', display: 'Delete' }
  }
}

export const KEYMAP_SCHEME_LABELS: Record<KeymapScheme, string> = {
  default: 'デフォルト',
  premiere: 'Premiere Pro風',
  capcut: 'CapCut風'
}

export function getKeymap(scheme: KeymapScheme): Record<ShortcutAction, KeyBinding> {
  return KEYMAPS[scheme] ?? KEYMAPS.default
}

export function getActionLabel(action: ShortcutAction): string {
  return ACTION_LABELS[action]
}

export function matchesBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
  const mod = e.metaKey || e.ctrlKey
  if (Boolean(binding.ctrl) !== mod) return false
  if (Boolean(binding.shift) !== e.shiftKey) return false
  if (binding.key === 'Delete') {
    return e.key === 'Delete' || e.key === 'Backspace'
  }
  if (binding.key === ' ') {
    return e.code === 'Space'
  }
  return e.key.toLowerCase() === binding.key.toLowerCase()
}

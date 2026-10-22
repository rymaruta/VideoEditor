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
  // 持っている型だけ(`KEYMAPS["constructor"]` は Object を返し、キー操作のたびに落ちていた)
  return Object.hasOwn(KEYMAPS, scheme) ? KEYMAPS[scheme] : KEYMAPS.default
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

// ---------------------------------------------------------------------------
// 編集画面の素早い操作(Premiere / DaVinci の既定に合わせたキー)
//
// 上の `ShortcutAction` はメニューバーの表示(`MenuShortcuts`)と同じ一覧なので、ここには足さない
// (足すとメニューとタイムラインのキーの帯に全部並ぶ)。こちらは編集画面だけで効くキー。
// ---------------------------------------------------------------------------

export type EditorAction =
  | 'shuttleReverse'
  | 'shuttleStop'
  | 'shuttleForward'
  | 'markIn'
  | 'markOut'
  | 'clearInOut'
  | 'goToIn'
  | 'goToOut'
  | 'playInToOut'
  | 'rippleDelete'
  | 'rippleTrimPrev'
  | 'rippleTrimNext'
  | 'prevEditPoint'
  | 'nextEditPoint'
  | 'goToStart'
  | 'goToEnd'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'addMarker'
  | 'nextMarker'
  | 'prevMarker'
  | 'removeMarker'
  | 'shortcutHelp'

export interface EditorBinding {
  /** `KeyboardEvent.key` の候補(英字は大小を問わない) */
  keys: string[]
  /** Ctrl(macOS は Cmd) */
  ctrl?: boolean
  /** true/false はその通り、'any' は Shift を見ない(+ や ? のように、配列によって Shift が要る記号) */
  shift?: boolean | 'any'
  /** Alt(macOS は Option) */
  alt?: boolean
  display: string
}

const EDITOR_ACTION_LABELS: Record<EditorAction, string> = {
  shuttleReverse: '戻る方向へ送る(押すたび速く)',
  shuttleStop: '停止(押したまま J / L で1フレーム)',
  shuttleForward: '再生(押すたび 2倍・4倍)',
  markIn: 'イン点を打つ',
  markOut: 'アウト点を打つ',
  clearInOut: 'イン・アウトを消す',
  goToIn: 'イン点へ移動',
  goToOut: 'アウト点へ移動',
  playInToOut: 'イン〜アウトを再生',
  rippleDelete: 'リップル削除(後ろを詰める)',
  rippleTrimPrev: '再生位置より前を切って詰める',
  rippleTrimNext: '再生位置より後ろを切って詰める',
  prevEditPoint: '前の編集点へ',
  nextEditPoint: '次の編集点へ',
  goToStart: '先頭へ',
  goToEnd: '末尾へ',
  zoomIn: 'タイムラインを拡大',
  zoomOut: 'タイムラインを縮小',
  zoomFit: 'タイムライン全体を表示',
  addMarker: 'マーカーを打つ',
  nextMarker: '次のマーカーへ',
  prevMarker: '前のマーカーへ',
  removeMarker: '再生位置のマーカーを消す',
  shortcutHelp: 'キー操作の一覧'
}

/** 一覧の並び(ダイアログの見出しごと) */
export const EDITOR_ACTION_GROUPS: { title: string; actions: EditorAction[] }[] = [
  {
    title: '再生・移動',
    actions: [
      'shuttleReverse',
      'shuttleStop',
      'shuttleForward',
      'prevEditPoint',
      'nextEditPoint',
      'goToStart',
      'goToEnd'
    ]
  },
  {
    title: 'イン・アウト',
    actions: ['markIn', 'markOut', 'goToIn', 'goToOut', 'playInToOut', 'clearInOut']
  },
  { title: '編集', actions: ['rippleDelete', 'rippleTrimPrev', 'rippleTrimNext'] },
  { title: 'マーカー', actions: ['addMarker', 'nextMarker', 'prevMarker', 'removeMarker'] },
  { title: '表示', actions: ['zoomIn', 'zoomOut', 'zoomFit', 'shortcutHelp'] }
]

export const EDITOR_ACTIONS: EditorAction[] = EDITOR_ACTION_GROUPS.flatMap((g) => g.actions)

function bind(
  keys: string[],
  display: string,
  mods: Pick<EditorBinding, 'ctrl' | 'shift' | 'alt'> = {}
): EditorBinding {
  return { keys, display, ...mods }
}

/** Premiere Pro の既定(Windows の表記)。macOS では Ctrl が Cmd、Alt が Option になる */
const PREMIERE_EDITOR_KEYS: Record<EditorAction, EditorBinding[]> = {
  shuttleReverse: [bind(['j'], 'J')],
  shuttleStop: [bind(['k'], 'K')],
  shuttleForward: [bind(['l'], 'L')],
  markIn: [bind(['i'], 'I')],
  markOut: [bind(['o'], 'O')],
  clearInOut: [
    bind(['x'], 'Alt+X', { alt: true }),
    bind(['x'], 'Ctrl+Shift+X', { ctrl: true, shift: true })
  ],
  goToIn: [bind(['i'], 'Shift+I', { shift: true })],
  goToOut: [bind(['o'], 'Shift+O', { shift: true })],
  playInToOut: [bind([' '], 'Ctrl+Shift+Space', { ctrl: true, shift: true })],
  rippleDelete: [
    bind(['Delete', 'Backspace'], 'Shift+Delete', { shift: true }),
    bind(['Backspace', 'Delete'], 'Alt+Backspace', { alt: true })
  ],
  rippleTrimPrev: [bind(['q'], 'Q')],
  rippleTrimNext: [bind(['w'], 'W')],
  prevEditPoint: [bind(['ArrowUp'], '↑')],
  nextEditPoint: [bind(['ArrowDown'], '↓')],
  goToStart: [bind(['Home'], 'Home')],
  goToEnd: [bind(['End'], 'End')],
  zoomIn: [bind(['=', '+'], '+', { shift: 'any' })],
  zoomOut: [bind(['-', '_'], '-', { shift: 'any' })],
  zoomFit: [bind(['\\', '¥', '|'], '\\', { shift: 'any' })],
  addMarker: [bind(['m'], 'M')],
  nextMarker: [bind(['m'], 'Shift+M', { shift: true })],
  prevMarker: [bind(['m'], 'Ctrl+Shift+M', { ctrl: true, shift: true })],
  removeMarker: [bind(['m'], 'Ctrl+Alt+M', { ctrl: true, alt: true })],
  shortcutHelp: [bind(['?'], '?', { shift: 'any' }), bind(['/'], 'Ctrl+/', { ctrl: true })]
}

/**
 * CapCut 風: 拡大・縮小は Ctrl+= / Ctrl+-、全体表示は Shift+Z(CapCut のデスクトップ版の既定)。
 * ほかは Premiere と同じ(CapCut も Q / W・M・J / K / L・I / O を同じ意味で使う)
 */
const CAPCUT_EDITOR_KEYS: Record<EditorAction, EditorBinding[]> = {
  ...PREMIERE_EDITOR_KEYS,
  zoomIn: [bind(['=', '+'], 'Ctrl+=', { ctrl: true, shift: 'any' })],
  zoomOut: [bind(['-', '_'], 'Ctrl+-', { ctrl: true, shift: 'any' })],
  zoomFit: [bind(['z'], 'Shift+Z', { shift: true })]
}

const EDITOR_KEYMAPS: Record<KeymapScheme, Record<EditorAction, EditorBinding[]>> = {
  default: PREMIERE_EDITOR_KEYS,
  premiere: PREMIERE_EDITOR_KEYS,
  capcut: CAPCUT_EDITOR_KEYS
}

export function getEditorKeymap(scheme: KeymapScheme): Record<EditorAction, EditorBinding[]> {
  return Object.hasOwn(EDITOR_KEYMAPS, scheme) ? EDITOR_KEYMAPS[scheme] : EDITOR_KEYMAPS.default
}

export function getEditorActionLabel(action: EditorAction): string {
  return EDITOR_ACTION_LABELS[action]
}

/** キーの出来事のうち、見る所だけ(試験で作りやすいように) */
export type KeyLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>

export function matchesEditorBinding(e: KeyLike, binding: EditorBinding): boolean {
  if (Boolean(binding.ctrl) !== (e.metaKey || e.ctrlKey)) return false
  if (Boolean(binding.alt) !== e.altKey) return false
  if (binding.shift !== 'any' && Boolean(binding.shift) !== e.shiftKey) return false
  if (binding.keys.includes(' ')) return e.code === 'Space' || e.key === ' '
  const norm = (k: string): string => (k.length === 1 ? k.toLowerCase() : k)
  const key = norm(e.key)
  if (binding.keys.some((k) => norm(k) === key)) return true
  // macOS の Option+英字は別の文字(Option+X は「≈」)になるので、Alt のときだけキーの位置で見る
  if (e.altKey && typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code)) {
    const letter = e.code.slice(3).toLowerCase()
    return binding.keys.some((k) => k.length === 1 && k.toLowerCase() === letter)
  }
  return false
}

/** 押されたキーに当たる編集の操作(無ければ null) */
export function editorActionFor(
  e: KeyLike,
  keymap: Record<EditorAction, EditorBinding[]>
): EditorAction | null {
  for (const action of EDITOR_ACTIONS) {
    if (keymap[action].some((binding) => matchesEditorBinding(e, binding))) return action
  }
  return null
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '')
}

/** 画面に出すキーの書き方。macOS では Ctrl → ⌘、Alt → ⌥、Shift → ⇧、Delete → ⌫ */
export function formatKeyDisplay(display: string, mac: boolean): string {
  if (!mac || display === '+') return display
  // 最後の「+」はキーそのもの(`Ctrl++`)のことがあるので、つなぎの「+」だけで割る
  const parts = display.endsWith('++')
    ? [...display.slice(0, -2).split('+'), '+']
    : display.split('+')
  const mark: Record<string, string> = {
    Ctrl: '⌘',
    Alt: '⌥',
    Shift: '⇧',
    Delete: '⌫',
    Backspace: '⌫'
  }
  return parts.map((p) => mark[p] ?? p).join('')
}

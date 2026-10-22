import type { EditorAction } from './keymap'
import { getTotalDuration, useProjectStore } from '../store/projectStore'
import {
  addMarkerAtPlayhead,
  goToEditPoint,
  goToMark,
  goToMarker,
  markIn,
  markOut,
  removeMarkerAtPlayhead,
  rippleDelete,
  rippleTrimToPlayhead
} from './editCommands'
import {
  isShuttleKHeld,
  playRange,
  pressShuttleKey,
  stopRangePlayback,
  stopShuttle
} from './shuttle'
import { emitMenuCommand } from './menuCommands'
import { useShortcutHelpStore } from './shortcutHelp'

/** 押しっぱなしの繰り返しを通す操作(ほかは1回とみなす) */
const REPEATABLE = new Set<EditorAction>(['prevEditPoint', 'nextEditPoint', 'zoomIn', 'zoomOut'])

/** ソースビューアが見えている間は、そちらが受け持つキー(ソースビューアにも J/K/L・I/O がある) */
const SOURCE_VIEWER_ACTIONS = new Set<EditorAction>([
  'shuttleReverse',
  'shuttleStop',
  'shuttleForward',
  'markIn',
  'markOut'
])

/** ソースビューアが見えているか(右のタブで「ソース」を開いている) */
function sourceViewerHasKeys(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.querySelector('.source-viewer')
  if (!el) return false
  const pane = el.closest('.tab-pane')
  return !pane || pane.classList.contains('active')
}

/**
 * 編集画面のキーの操作を行う。文字を打つ欄・ダイアログの門は呼ぶ側(`useKeyboardShortcuts`)が先に見る。
 * タイムラインが隠れている間(自動編集の画面など)は何もしない。
 * 既定の動き(ページのスクロールなど)を止めるべきなら true
 */
export function runEditorAction(
  action: EditorAction,
  e: Pick<KeyboardEvent, 'repeat'>,
  isTimelineCovered: () => boolean
): boolean {
  if (isTimelineCovered()) return false
  if (SOURCE_VIEWER_ACTIONS.has(action) && sourceViewerHasKeys()) return false
  if (e.repeat) {
    // K を押したままの J / L(1フレーム送り)は、押しっぱなしで続けて送る
    const stepping =
      (action === 'shuttleReverse' || action === 'shuttleForward') && isShuttleKHeld()
    if (!stepping && !REPEATABLE.has(action)) return true
  }
  const store = useProjectStore.getState()
  const shuttleOptions = { shouldStop: isTimelineCovered }
  switch (action) {
    case 'shuttleReverse':
      stopRangePlayback()
      pressShuttleKey('j', shuttleOptions)
      return true
    case 'shuttleStop':
      stopRangePlayback()
      pressShuttleKey('k', shuttleOptions)
      return true
    case 'shuttleForward':
      stopRangePlayback()
      pressShuttleKey('l', shuttleOptions)
      return true
    case 'markIn':
      markIn()
      return true
    case 'markOut':
      markOut()
      return true
    case 'clearInOut':
      store.clearTimelineInOut()
      return true
    case 'goToIn':
      goToMark('in')
      return true
    case 'goToOut':
      goToMark('out')
      return true
    case 'playInToOut': {
      const from = store.timelineIn ?? 0
      const to = store.timelineOut ?? getTotalDuration(store.project)
      playRange(from, to)
      return true
    }
    case 'rippleDelete':
      return rippleDelete()
    case 'rippleTrimPrev':
      stopShuttle()
      rippleTrimToPlayhead('start')
      return true
    case 'rippleTrimNext':
      stopShuttle()
      rippleTrimToPlayhead('end')
      return true
    case 'prevEditPoint':
      stopShuttle()
      goToEditPoint(-1)
      return true
    case 'nextEditPoint':
      stopShuttle()
      goToEditPoint(1)
      return true
    case 'goToStart':
      stopShuttle()
      store.seekTo(0)
      return true
    case 'goToEnd':
      stopShuttle()
      store.seekTo(getTotalDuration(store.project))
      return true
    case 'zoomIn':
      emitMenuCommand('view.zoomIn')
      return true
    case 'zoomOut':
      emitMenuCommand('view.zoomOut')
      return true
    case 'zoomFit':
      emitMenuCommand('view.zoomFit')
      return true
    case 'addMarker':
      addMarkerAtPlayhead()
      return true
    case 'nextMarker':
      goToMarker(1)
      return true
    case 'prevMarker':
      goToMarker(-1)
      return true
    case 'removeMarker':
      removeMarkerAtPlayhead()
      return true
    case 'shortcutHelp':
      useShortcutHelpStore.getState().toggle()
      return true
  }
}

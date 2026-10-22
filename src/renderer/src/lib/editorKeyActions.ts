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

/**
 * 本編を変える操作・本編の再生位置を動かす操作。ソースビューアが見えている間と、
 * 吹き出し・右クリックのメニューが開いている間は通さない
 * (ソースを見ながら押した Q・M・↓ が、見えていない本編を切り・印を打ち・再生位置を動かしていた。
 * メニューの上の ↑↓ は項目を選ぶキー)
 */
const TIMELINE_ACTIONS = new Set<EditorAction>([
  'rippleDelete',
  'rippleTrimPrev',
  'rippleTrimNext',
  'addMarker',
  'nextMarker',
  'prevMarker',
  'removeMarker',
  'clearInOut',
  'goToIn',
  'goToOut',
  'playInToOut',
  'prevEditPoint',
  'nextEditPoint',
  'goToStart',
  'goToEnd'
])

/** ソースビューアが見えているか(右のタブで「ソース」を開いている) */
export function isSourceViewerVisible(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.querySelector('.source-viewer')
  if (!el) return false
  const pane = el.closest('.tab-pane')
  return !pane || pane.classList.contains('active')
}

/** 吹き出し・色の選び・右クリックのメニューが開いているか(モーダルではないもの) */
export function isPopoverOpen(): boolean {
  if (typeof document === 'undefined') return false
  return (
    document.querySelector('.app-popover, .color-popover, .clip-context-menu, [role="menu"]') !==
    null
  )
}

/** 画面の様子(試験では差し替える) */
export interface EditorKeyEnv {
  sourceViewerVisible: () => boolean
  popoverOpen: () => boolean
  pageHidden: () => boolean
}

const domEnv: EditorKeyEnv = {
  sourceViewerVisible: isSourceViewerVisible,
  popoverOpen: isPopoverOpen,
  pageHidden: () => typeof document !== 'undefined' && document.hidden
}

/**
 * 編集画面のキーの操作を行う。文字を打つ欄・ダイアログの門は呼ぶ側(`useKeyboardShortcuts`)が先に見る。
 * タイムラインが隠れている間(自動編集の画面など)は何もしない。
 * 既定の動き(ページのスクロールなど)を止めるべきなら true
 */
export function runEditorAction(
  action: EditorAction,
  e: Pick<KeyboardEvent, 'repeat'>,
  isTimelineCovered: () => boolean,
  env: EditorKeyEnv = domEnv
): boolean {
  if (isTimelineCovered()) return false
  const sourceVisible = env.sourceViewerVisible()
  if (SOURCE_VIEWER_ACTIONS.has(action) && sourceVisible) return false
  if (TIMELINE_ACTIONS.has(action) && (sourceVisible || env.popoverOpen())) return false
  if (e.repeat) {
    // K を押したままの J / L(1フレーム送り)は、押しっぱなしで続けて送る
    const stepping =
      (action === 'shuttleReverse' || action === 'shuttleForward') && isShuttleKHeld()
    if (!stepping && !REPEATABLE.has(action)) return true
  }
  const store = useProjectStore.getState()
  // 窓が隠れた・テロップのタブへ移った・ダイアログが開いたら、送るのをやめる
  const shuttleOptions = {
    // テロップのタブではタイムラインもプログラムも見えたままなので止めない(止めると J・2倍・4倍が効かなかった)
    shouldStop: () => isTimelineCovered() || env.pageHidden()
  }
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

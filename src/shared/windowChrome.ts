/**
 * 主の窓の枠(タイトルバー)の作り。Premiere・DaVinci・VS Code のように、OS のタイトルバーと
 * メニューバーを出さず、アプリの上の帯(WorkflowBar)1 本にまとめる。
 *
 * - Windows / Linux: タイトルバーを隠し、最小化・最大化・閉じるのボタンだけを帯の右端に重ねる
 *   (`titleBarOverlay`)。OS のメニューバーは出さない(メニューは帯の「メニュー」ボタンから出す。
 *   アプリのメニューは設定したままなので、キーの割り当てはそのまま効く)
 * - macOS: 信号のボタンを帯の左に重ねる(`hiddenInset`)。メニューは今まで通り画面の上
 *
 * electron を読み込まない(試験で使う)。
 */

/** 上の帯の高さ(px)。tokens.css の `--ve-bar-workflow`(`.workflow-bar`)と同じ */
export const TITLE_BAR_HEIGHT = 44

/**
 * 重ねるボタンの地の色。上の帯の地(見出しの帯 --ve-surface-band)と同じ灰(継ぎ目が見えない)
 */
export const TITLE_BAR_OVERLAY_COLOR = '#202020'
/** 重ねるボタンの記号の色(ふつうの操作の字 --ve-text-2) */
export const TITLE_BAR_SYMBOL_COLOR = '#bdbdbd'

/**
 * 窓の最小の大きさ。これより狭いと、パネル(最小 300)・モニター・タイムラインの道具の帯
 * (「その他」に回しても)が入らない
 */
export const MIN_WINDOW_WIDTH = 960
export const MIN_WINDOW_HEIGHT = 600

export interface WindowChromeOptions {
  minWidth: number
  minHeight: number
  titleBarStyle: 'hidden' | 'hiddenInset'
  titleBarOverlay?: { color: string; symbolColor: string; height: number }
  /** OS のメニューバーを Alt で出さない(Alt は帯のメニューボタンへ) */
  autoHideMenuBar: false
  /** macOS の信号のボタンの位置(帯の高さの真ん中に) */
  trafficLightPosition?: { x: number; y: number }
}

/** プラットフォームごとの、主の窓の枠の設定(`BrowserWindow` に渡す) */
export function windowChromeOptions(platform: string): WindowChromeOptions {
  if (platform === 'darwin')
    return {
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT,
      titleBarStyle: 'hiddenInset',
      autoHideMenuBar: false,
      // 信号のボタン(高さ 14px)を 44px の帯の真ん中に
      trafficLightPosition: { x: 14, y: Math.round((TITLE_BAR_HEIGHT - 14) / 2) }
    }
  return {
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: TITLE_BAR_OVERLAY_COLOR,
      symbolColor: TITLE_BAR_SYMBOL_COLOR,
      height: TITLE_BAR_HEIGHT
    },
    autoHideMenuBar: false
  }
}

/** 帯にメニューボタンを置くか(macOS は画面の上にメニューがあるので置かない) */
export function needsMenuButton(platform: string): boolean {
  return platform !== 'darwin'
}

/**
 * 帯のメニューボタンから出すメニューの位置(窓の中の座標・整数)。ボタンの左下から出す。
 * 値がおかしければ(数でない・負)、マウスの位置に出す(undefined)
 */
export function menuPopupPosition(
  at: { x?: unknown; y?: unknown } | null | undefined
): { x: number; y: number } | undefined {
  if (!at) return undefined
  const { x, y } = at
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return undefined
  return { x: Math.round(x), y: Math.round(y) }
}

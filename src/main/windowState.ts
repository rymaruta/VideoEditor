/**
 * 前回のウィンドウの大きさ・位置を復元するときの規則。
 *
 * 保存しているのは `getBounds()` そのままなので、**副ディスプレイに置いたまま終了すると
 * `x` に 1920 や 2400 が入る**。次に起動したときそのモニタが繋がっていなければ、
 * ウィンドウは実在しない座標に開く。Electron は位置を一切丸めないので
 * (実測: x=2400 を要求すると x=2400 のまま。負の座標も同じ)、
 * **アプリは起動しているのに画面のどこにも見えない**——エラーも警告も出ない。
 * ノートPCのドックの抜き差しで普通に踏む。
 *
 * 大きさも同様に素通しで、壊れた値がそのまま効く
 * (実測: 幅 0 と 負 は **1px 幅**のウィンドウ、`1e400`(JSON で書ける Infinity)は 800、
 * 99999 はそのまま 99999)。
 *
 * だから**読む側のここ1箇所**で、いま実在するディスプレイに合わせて収め直す。
 * 書く側は実際の座標をそのまま記録してよい(複数モニタの位置は正しい情報で、
 * 変わるのは「次に起動したときどのモニタがあるか」のほうなので)。
 */

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  isMaximized: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 状態が無いときの大きさ。`createWindow` の既定値と揃える。 */
export const DEFAULT_WINDOW_SIZE = { width: 1360, height: 860 } as const

/**
 * 「見えている」と認めるのに必要な重なり。
 * 端が数pxだけ覗いている状態は、掴んで動かすこともできないので復元とは呼べない。
 */
export const MIN_VISIBLE = { width: 160, height: 80 } as const

function finitePositive(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clamp(v: number, lo: number, hi: number): number {
  // 作業領域よりウィンドウが大きいときは lo > hi になり得る。そのときは左上に寄せる。
  if (hi < lo) return lo
  return Math.min(hi, Math.max(lo, v))
}

/** 枠と作業領域が重なっている幅・高さ。 */
function overlap(rect: Rect, area: Rect): { width: number; height: number } {
  return {
    width: Math.max(
      0,
      Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
    ),
    height: Math.max(
      0,
      Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
    )
  }
}

function isVisibleEnough(rect: Rect, workAreas: Rect[]): boolean {
  return workAreas.some((area) => {
    const o = overlap(rect, area)
    return o.width >= MIN_VISIBLE.width && o.height >= MIN_VISIBLE.height
  })
}

/** 枠の中心が一番近い作業領域。距離が同じなら先に並んでいるほう(＝主ディスプレイ)。 */
function nearestArea(rect: Rect, workAreas: Rect[]): Rect {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  let best = workAreas[0]
  let bestDistance = Infinity
  for (const area of workAreas) {
    const dx = area.x + area.width / 2 - cx
    const dy = area.y + area.height / 2 - cy
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      best = area
    }
  }
  return best
}

/**
 * 保存されていた値を、いま実在するディスプレイに合わせて収め直す。
 *
 * - 形が違う(オブジェクトでない)ものは `null`。呼び出し側は「状態なし」＝初回起動と
 *   同じ扱いになり、最大化して開く。中途半端に復元するより既定に倒すほうが安全。
 * - 大きさが有限の正の数でなければ既定値。作業領域より大きければ作業領域まで縮める。
 * - 位置は**十分に見えているならそのまま**(1pxも動かさない)。見えていなければ
 *   一番近い作業領域の中へクランプする。
 * - `x`/`y` の片方でも数値でなければ位置は指定しない(Electron が中央に置く)。
 */
export function fitWindowStateToDisplays(raw: unknown, workAreas: Rect[]): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const state: WindowState = {
    width: Math.round(finitePositive(source.width) ?? DEFAULT_WINDOW_SIZE.width),
    height: Math.round(finitePositive(source.height) ?? DEFAULT_WINDOW_SIZE.height),
    isMaximized: source.isMaximized === true
  }
  const x = finiteNumber(source.x)
  const y = finiteNumber(source.y)
  if (workAreas.length === 0) {
    // ディスプレイが1枚も取れないのは異常だが、ここで落とすと起動できない。
    // 大きさだけ整えて位置は Electron に任せる。
    return state
  }
  if (x === null || y === null) return state

  const area = nearestArea({ x, y, width: state.width, height: state.height }, workAreas)
  // 作業領域より大きい状態は復元できないので縮める。**縮めたら位置も置き直す**——
  // 大きさを変えてしまった時点で、記録された左上の座標は「その大きさでの位置」ではない。
  const shrunk = state.width > area.width || state.height > area.height
  state.width = Math.min(state.width, area.width)
  state.height = Math.min(state.height, area.height)

  const rect: Rect = {
    x: Math.round(x),
    y: Math.round(y),
    width: state.width,
    height: state.height
  }
  if (!shrunk && isVisibleEnough(rect, workAreas)) {
    state.x = rect.x
    state.y = rect.y
    return state
  }
  state.x = clamp(rect.x, area.x, area.x + area.width - state.width)
  state.y = clamp(rect.y, area.y, area.y + area.height - state.height)
  return state
}

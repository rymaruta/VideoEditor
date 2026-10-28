/**
 * 画面の見え方の好み(この PC に覚える)。覚えられない環境でも既定の見え方で動く。
 */

/** 素材の並べ方(格子 / 一覧) */
export const MEDIA_LAYOUT_KEY = 've-media-layout'
/** 16:9 などのモニターの安全枠(動き 5%・文字 10%) */
export const SAFE_FRAME_KEY = 've-preview-safe-frame'

/** 既定は一覧(今までと同じ)。格子は選んだ人だけ */
export function readMediaLayout(): 'grid' | 'list' {
  try {
    // 既定は格子(デザイン案の素材のパネル)。一覧を選んだら覚える
    return localStorage.getItem(MEDIA_LAYOUT_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export function storeMediaLayout(layout: 'grid' | 'list'): void {
  try {
    localStorage.setItem(MEDIA_LAYOUT_KEY, layout)
  } catch {
    // 覚えられなくても今回の表示は変わる
  }
}

/** 安全枠は既定で出さない(今までの見え方のまま)。出すと決めた人だけ出す */
export function readSafeFrame(): boolean {
  try {
    return localStorage.getItem(SAFE_FRAME_KEY) === 'true'
  } catch {
    return false
  }
}

export function storeSafeFrame(on: boolean): void {
  try {
    localStorage.setItem(SAFE_FRAME_KEY, on ? 'true' : 'false')
  } catch {
    // 覚えられなくても今回の表示は変わる
  }
}

/** テロップのインスペクタの数値のカード(表示・読む速さ・字数)を開いておくか */
export const TELOP_METRICS_KEY = 've-telop-metrics-open'

/** 覚えた選び方があればそれ。無ければ、低い窓(高さ 900 未満)では畳んでおく(モニターを小さくしない) */
export function readTelopMetricsOpen(windowHeight: number): boolean {
  try {
    const v = localStorage.getItem(TELOP_METRICS_KEY)
    if (v === 'true' || v === 'false') return v === 'true'
  } catch {
    // 読めなければ窓の高さで決める
  }
  return windowHeight >= 900
}

export function storeTelopMetricsOpen(open: boolean): void {
  try {
    localStorage.setItem(TELOP_METRICS_KEY, open ? 'true' : 'false')
  } catch {
    // 覚えられなくても今回の開閉は効く
  }
}

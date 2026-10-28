import { create } from 'zustand'

/**
 * プログラム(`PreviewPlayer`)を、確認の画面の右の枠へ重ねて出すための置き場。
 *
 * プログラムは編集の画面に1つだけ置いてあり、テロップ・ワイプ・音の重ね方まで書き出しと同じに見せる。
 * 確認の画面のためにもう1つ作ると、同じ素材を2組の video で読み、音も二重に鳴る。
 * そこで確認の画面は枠(`rect`)だけを用意し、プログラムはその位置へ `position: fixed` で重なる
 * (作り直さないので、再生・位置・読み込んだ素材はそのまま)。枠が無くなれば元の場所へ戻る
 */
export interface DockRect {
  left: number
  top: number
  width: number
  height: number
  /** 上下で切り取る量(枠が送れる列の外へはみ出した分。0 なら切らない) */
  clipTop: number
  clipBottom: number
}

export const useProgramDock = create<{
  rect: DockRect | null
  setRect: (rect: DockRect | null) => void
}>((set, get) => ({
  rect: null,
  setRect: (rect) => {
    const prev = get().rect
    if (
      prev &&
      rect &&
      prev.left === rect.left &&
      prev.top === rect.top &&
      prev.width === rect.width &&
      prev.height === rect.height &&
      prev.clipTop === rect.clipTop &&
      prev.clipBottom === rect.clipBottom
    )
      return
    set({ rect })
  }
}))

/**
 * 要素の画面の上の位置(整数に丸める。少しの揺れで描き直さない)。`within` を渡すと、その中に見えている所の
 * 外(縦に送って上下にはみ出した所)を切り取る量も返す
 */
export function dockRectOf(el: Element, within?: Element): DockRect {
  const r = el.getBoundingClientRect()
  const box = within?.getBoundingClientRect()
  return dockRectFrom(r, box)
}

/** 位置と、見えている枠から(試験のため DOM を使わない形で分けてある) */
export function dockRectFrom(
  r: { left: number; top: number; width: number; height: number },
  box?: { top: number; bottom: number }
): DockRect {
  const top = Math.round(r.top)
  const height = Math.round(r.height)
  const clipTop = box ? Math.max(0, Math.min(height, Math.round(box.top) - top)) : 0
  const clipBottom = box ? Math.max(0, Math.min(height, top + height - Math.round(box.bottom))) : 0
  return {
    left: Math.round(r.left),
    top,
    width: Math.round(r.width),
    height,
    clipTop,
    clipBottom
  }
}

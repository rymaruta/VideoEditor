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
      prev.height === rect.height
    )
      return
    set({ rect })
  }
}))

/** 要素の画面の上の位置(整数に丸める。少しの揺れで描き直さない) */
export function dockRectOf(el: Element): DockRect {
  const r = el.getBoundingClientRect()
  return {
    left: Math.round(r.left),
    top: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height)
  }
}

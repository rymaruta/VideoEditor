import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Esc でダイアログを閉じる(背景を押したときと同じ)。一番上のダイアログだけが閉じる。
 * 中で開いている吹き出し(色・候補の一覧)があれば、そちらが先に閉じる。
 * 打ちかけの数値欄の Esc(打つ前の値に戻す)はその欄が止めるので、ここまで来ない。
 * トリム・自動テロップなどのダイアログは Esc で閉じず、書き出しのダイアログと振る舞いが違っていた
 */
export function useEscapeToClose(
  backdropRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true
): void {
  const latest = useRef(onClose)
  useLayoutEffect(() => {
    latest.current = onClose
  })
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = backdropRef.current
      if (!el) return
      const all = document.querySelectorAll('.modal-backdrop')
      if (all[all.length - 1] !== el) return
      if (document.querySelector('.app-popover, .color-popover')) return
      e.stopImmediatePropagation()
      latest.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [backdropRef, enabled])
}

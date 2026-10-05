import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { placePopover } from '../lib/appearanceEdit'

/**
 * 欄の横に出す吹き出し(マイ設定・書体の一覧・見た目の貼り付けなど)。
 *
 * - document.body に出す(スクロールする枠の overflow で切れないように)
 * - 位置は基準の欄から決め、画面からはみ出さない(下に入らなければ上へ。高すぎればスクロール)
 * - 外を押す・Esc で閉じる。Esc で閉じたら基準の欄にフォーカスを戻す(キーボードだけで使える)
 * - 中身の大きさが変わったら位置を直す
 */
export function Popover({
  anchorRef,
  onClose,
  label,
  className = '',
  children,
  initialFocus,
  role = 'dialog'
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  label: string
  className?: string
  children: React.ReactNode
  /** 開いたときにフォーカスする要素(CSS セレクタ)。無ければ最初の操作できる要素 */
  initialFocus?: string
  role?: 'dialog' | 'menu'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  const place = useCallback((): void => {
    const a = anchorRef.current
    const p = ref.current
    if (!a || !p) return
    const next = placePopover(
      a.getBoundingClientRect(),
      { width: p.offsetWidth, height: p.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next))
  }, [anchorRef])

  useLayoutEffect(() => {
    place()
    const p = ref.current
    if (!p) return
    const ro = new ResizeObserver(() => place())
    ro.observe(p)
    return () => ro.disconnect()
  }, [place])

  // 位置が決まって見えるようになってからフォーカスする(見えない要素にはフォーカスできない)
  const focused = useRef(false)
  useEffect(() => {
    const p = ref.current
    if (!pos || !p || focused.current) return
    focused.current = true
    const focusTarget =
      (initialFocus ? p.querySelector<HTMLElement>(initialFocus) : null) ??
      p.querySelector<HTMLElement>(
        'input, button:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    focusTarget?.focus({ preventScroll: true })
  }, [pos, initialFocus])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return
      // ほかの吹き出し(この中から開いた色の欄など)の中は外とみなさない
      if ((t as Element).closest?.('.color-popover, .app-popover')) return
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 中で開いている別の吹き出し(色の欄)が先に閉じる
      if (document.querySelector('.color-popover')) return
      // 名前の欄など、Esc を自分で使う欄(data-escape-local)は、その欄に任せる
      if ((e.target as Element | null)?.closest?.('[data-escape-local]')) return
      e.stopPropagation()
      onCloseRef.current()
      anchorRef.current?.focus()
    }
    const onMove = (): void => place()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [anchorRef, place])

  return createPortal(
    <div
      ref={ref}
      className={`app-popover ${className}`}
      role={role}
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body
  )
}

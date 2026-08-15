import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  label: string
  /** ショートカットの表記(あれば右端に薄く出す) */
  shortcut?: string
  onSelect: () => void
  disabled?: boolean
  /** 消す・戻せない類は赤くする */
  danger?: boolean
}

/**
 * タイムラインのクリップを右クリックしたときの操作メニュー。
 *
 * 同じ操作はショートカットとインスペクターにもあるが、**どちらも知っている必要がある**。
 * 掴んだクリップの上でそのまま出せると、選ぶ → 目的のパネルを探す、の往復が無くなる。
 *
 * 位置は画面からはみ出さないように出したあとで詰める(端のクリップだと右や下が切れるため、
 * 描画してから実寸で測って寄せる)。
 */
export function ClipContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))
    setPos({ left, top })
  }, [x, y])

  useEffect(() => {
    // 外を押す・Escape・スクロール/リサイズで閉じる。開いたまま置き去りにしない。
    function handlePointerDown(e: MouseEvent): void {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', handlePointerDown, true)
    window.addEventListener('keydown', handleKey, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true)
      window.removeEventListener('keydown', handleKey, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  return createPortal(
    <div className="clip-context-menu" ref={ref} style={{ left: pos.left, top: pos.top }}>
      {items.map((item) => (
        <button
          key={item.label}
          className={`clip-context-menu-item ${item.danger ? 'danger' : ''}`}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="clip-context-menu-key">{item.shortcut}</span>}
        </button>
      ))}
    </div>,
    document.body
  )
}

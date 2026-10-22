import { useRef, useState } from 'react'
import { Popover } from './Popover'
import { moveMenuFocus } from '../lib/panelTabs'

export interface OverflowAction {
  key: string
  label: string
  icon?: React.ReactNode
  title?: string
  onSelect: () => void
}

/**
 * 道具の帯に収まらない操作の「その他 ▾」(tokens.css §3.5)。帯では狭い窓のときだけ出す
 * (広い窓では同じ操作を帯に並べる。どちらか一方だけが見える)。↑↓ / Home / End で移り、Esc で閉じる
 */
export function OverflowMenu({
  actions,
  label = 'その他',
  menuLabel,
  className = ''
}: {
  actions: readonly OverflowAction[]
  label?: string
  /** メニューの名前(読み上げ) */
  menuLabel: string
  className?: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  if (actions.length === 0) return null
  const onKey = (e: React.KeyboardEvent): void => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const next = moveMenuFocus(
      e.key,
      items.indexOf(document.activeElement as HTMLElement),
      items.length
    )
    if (next === null) return
    e.preventDefault()
    items[next]?.focus()
  }
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`small-button overflow-menu-button ${className}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={menuLabel}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {label}
        <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="m6 9 6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </button>
      {open && (
        <Popover
          anchorRef={ref}
          onClose={() => setOpen(false)}
          label={menuLabel}
          role="menu"
          className="overflow-menu"
        >
          <div ref={listRef} onKeyDown={onKey}>
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="overflow-menu-item"
                title={a.title}
                onClick={() => {
                  setOpen(false)
                  ref.current?.focus()
                  a.onSelect()
                }}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}

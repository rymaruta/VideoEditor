import { useEffect, useRef, useState } from 'react'
import { Popover } from './Popover'
import { moveMenuFocus } from '../lib/panelTabs'
import { useModalOpen } from '../lib/useModalOpen'

export interface OverflowAction {
  key: string
  label: string
  icon?: React.ReactNode
  title?: string
  /** 危険な操作(削除など)。赤い字で出す */
  danger?: boolean
  onSelect: () => void
}

/**
 * 道具の帯に収まらない操作の「その他 ▾」(tokens.css §3.5)。帯では入らないときだけ出す
 * (入るときは同じ操作を帯に並べる。どちらか一方だけが見える)。↑↓ / Home / End で移り、Esc で閉じる。
 * 選択の欄(速度・繋ぎ)も回すときは `children` に入れる(そのときは欄を含む吹き出しにする)。
 * 選んだ操作がダイアログを開いたら、閉じた後に「その他」のボタンへフォーカスを戻す。
 */
export function OverflowMenu({
  actions,
  label = 'その他',
  menuLabel,
  className = '',
  children
}: {
  actions: readonly OverflowAction[]
  label?: string
  /** メニューの名前(読み上げ) */
  menuLabel: string
  className?: string
  /** 回した選択の欄 */
  children?: React.ReactNode
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 選んだ操作が開いたダイアログが閉じたら、ボタンへフォーカスを戻す
  const modalOpen = useModalOpen()
  const pending = useRef<'none' | 'wait-open' | 'wait-close'>('none')
  useEffect(() => {
    if (pending.current === 'wait-open' && modalOpen) pending.current = 'wait-close'
    else if (pending.current === 'wait-close' && !modalOpen) {
      pending.current = 'none'
      ref.current?.focus()
    }
  }, [modalOpen])
  const hasFields = Boolean(children)
  if (actions.length === 0 && !hasFields) return null
  const onKey = (e: React.KeyboardEvent): void => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    if (!items.includes(document.activeElement as HTMLElement)) return
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
        aria-haspopup={hasFields ? 'dialog' : 'menu'}
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
          role={hasFields ? 'dialog' : 'menu'}
          className="overflow-menu"
        >
          <div ref={listRef} onKeyDown={onKey} role={hasFields ? 'menu' : undefined}>
            {actions.map((a) => (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`overflow-menu-item ${a.danger ? 'danger' : ''}`}
                title={a.title}
                onClick={() => {
                  setOpen(false)
                  ref.current?.focus()
                  pending.current = 'wait-open'
                  a.onSelect()
                  // ダイアログを開かない操作なら、待たない
                  requestAnimationFrame(() => {
                    if (
                      pending.current === 'wait-open' &&
                      !document.querySelector('.modal-backdrop')
                    )
                      pending.current = 'none'
                  })
                }}
              >
                {a.icon}
                {a.label}
              </button>
            ))}
          </div>
          {hasFields && <div className="overflow-menu-fields">{children}</div>}
        </Popover>
      )}
    </>
  )
}

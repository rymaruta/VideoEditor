import { useRef, useState } from 'react'
import type { SVGProps } from 'react'
import { Popover } from './Popover'
import { MoreIcon } from './icons'
import { moveMenuFocus } from '../lib/panelTabs'

export interface RailItem {
  id: string
  label: string
  description: string
  icon: (props: SVGProps<SVGSVGElement>) => React.JSX.Element
}

/**
 * 左のレール(80px)。左のパネル(288px)に出す中身を選ぶ。
 * よく使うもの(素材・BGM/SE・プリセット・テンプレート)を並べ、残り(ボイス・サムネイル・投稿の準備…)は
 * 「その他」のメニューにまとめる。その他から選んだものは、並びの後ろに出して今いる所を示す。
 * 狭い窓(高さが足りない)ではレールの中を縦に送る。
 */
export function SideRail({
  items,
  more,
  current,
  onSelect
}: {
  items: readonly RailItem[]
  /** 「その他」の中のまとまり */
  more: readonly { label: string; items: readonly RailItem[] }[]
  current: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const moreItems = more.flatMap((g) => g.items)
  const pickedMore = moreItems.find((i) => i.id === current)
  const shown = pickedMore ? [...items, pickedMore] : items

  const button = (item: RailItem): React.JSX.Element => {
    const Icon = item.icon
    const on = current === item.id
    return (
      <button
        key={item.id}
        type="button"
        className={`ve-rail-button ${on ? 'on' : ''}`}
        aria-pressed={on}
        title={item.description}
        onClick={() => onSelect(item.id)}
      >
        <Icon width={18} height={18} />
        <span className="ve-rail-label">{item.label}</span>
      </button>
    )
  }

  const choose = (id: string): void => {
    setOpen(false)
    onSelect(id)
    moreRef.current?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent): void => {
    const els = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    ]
    const next = moveMenuFocus(
      e.key,
      els.indexOf(document.activeElement as HTMLElement),
      els.length
    )
    if (next === null) return
    e.preventDefault()
    els[next]?.focus()
  }

  return (
    <nav className="ve-rail" aria-label="左のパネル">
      {shown.map(button)}
      {moreItems.length > 0 && (
        <button
          ref={moreRef}
          type="button"
          className={`ve-rail-button ${open ? 'open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`ほかのパネル(${moreItems.map((i) => i.label).join('・')})`}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && !open) {
              e.preventDefault()
              setOpen(true)
            }
          }}
        >
          <MoreIcon width={18} height={18} />
          <span className="ve-rail-label">その他</span>
        </button>
      )}
      {open && (
        <Popover
          anchorRef={moreRef}
          onClose={() => setOpen(false)}
          label="ほかのパネル"
          role="menu"
          className="panel-more-menu ve-rail-menu"
          initialFocus={pickedMore ? `[data-rail="${pickedMore.id}"]` : '[role="menuitemradio"]'}
        >
          <div ref={listRef} onKeyDown={onMenuKey}>
            {more.map((g) => (
              <div key={g.label} className="panel-more-group" role="group" aria-label={g.label}>
                <div className="panel-more-group-label" aria-hidden="true">
                  {g.label}
                </div>
                {g.items.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current === i.id}
                    data-rail={i.id}
                    tabIndex={-1}
                    className={`panel-more-item ${current === i.id ? 'current' : ''}`}
                    onClick={() => choose(i.id)}
                  >
                    <span className="panel-more-item-label">{i.label}</span>
                    <span className="panel-more-item-note">{i.description}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </nav>
  )
}

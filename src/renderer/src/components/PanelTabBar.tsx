import { useRef, useState } from 'react'
import { Popover } from './Popover'
import { isInMore, moveMenuFocus, splitPanelTabs } from '../lib/panelTabs'

export interface PanelTabBarDef {
  id: string
  label: string
  description: string
}

/**
 * 上段左のパネルのタブ。よく使うタブ(インスペクタ・テキスト・BGM/SE・テンプレート)を表に出し、
 * 残り(ボイス・サムネ・プリセット・投稿準備・YouTube・ゲームトレンド)は「その他」の中に用途ごとに
 * まとめる(`lib/panelTabs`)。「その他」から選んだタブは、表のタブの後ろに出して今いる所を示す。
 */
export function PanelTabBar({
  tabs,
  current,
  onSelect,
  leading
}: {
  tabs: readonly PanelTabBarDef[]
  current: string
  onSelect: (id: string) => void
  /** 先頭に足すタブ(素材をソースで開いたときの「ソース」) */
  leading?: React.ReactNode
}): React.JSX.Element {
  const { primary, groups } = splitPanelTabs(tabs)
  const moreTab = isInMore(current, tabs) ? tabs.find((t) => t.id === current) : undefined
  const [open, setOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const tabButton = (t: PanelTabBarDef, extra = ''): React.JSX.Element => (
    <button
      key={t.id}
      type="button"
      role="tab"
      aria-selected={current === t.id}
      className={`panel-tab ${current === t.id ? 'active' : ''} ${extra}`}
      onClick={() => onSelect(t.id)}
      title={t.description}
    >
      {t.label}
    </button>
  )

  const choose = (id: string): void => {
    setOpen(false)
    onSelect(id)
    moreRef.current?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent): void => {
    const items = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])
    ]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = moveMenuFocus(e.key, index, items.length)
    if (next === null) return
    e.preventDefault()
    items[next]?.focus()
  }

  return (
    <div className="panel-tabs panel-tabs-grouped" role="tablist" aria-label="パネル">
      {leading}
      {primary.map((t) => tabButton(t))}
      {moreTab && tabButton(moreTab, 'panel-tab-more-current')}
      {groups.length > 0 && (
        <button
          ref={moreRef}
          type="button"
          className={`panel-tab panel-tab-more ${open ? 'open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          title="ほかのパネル(ボイス・サムネ・プリセット・投稿準備・YouTube・ゲームトレンド)"
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault()
              setOpen(true)
            }
          }}
        >
          その他
          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="m6 9 6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      {open && (
        <Popover
          anchorRef={moreRef}
          onClose={() => setOpen(false)}
          label="ほかのパネル"
          role="menu"
          className="panel-more-menu"
          initialFocus={moreTab ? `[data-tab="${moreTab.id}"]` : '[role="menuitemradio"]'}
        >
          <div ref={listRef} onKeyDown={onMenuKey}>
            {groups.map((g) => (
              <div key={g.label} className="panel-more-group" role="group" aria-label={g.label}>
                <div className="panel-more-group-label" aria-hidden="true">
                  {g.label}
                </div>
                {g.tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current === t.id}
                    data-tab={t.id}
                    tabIndex={-1}
                    className={`panel-more-item ${current === t.id ? 'current' : ''}`}
                    onClick={() => choose(t.id)}
                  >
                    <span className="panel-more-item-label">{t.label}</span>
                    <span className="panel-more-item-note">{t.description}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </div>
  )
}

import { useLayoutEffect, useRef, useState } from 'react'
import { Popover } from './Popover'
import { fitTabs, isInMore, moveMenuFocus, splitPanelTabs } from '../lib/panelTabs'

export interface PanelTabBarDef {
  id: string
  label: string
  description: string
}

/**
 * 上段左のパネルのタブ。よく使うタブ(インスペクタ・テキスト・BGM/SE・テンプレート)を表に出し、
 * 残り(ボイス・サムネ・プリセット・投稿準備・YouTube・ゲームトレンド)は「その他」の中に用途ごとに
 * まとめる(`lib/panelTabs`)。「その他」から選んだタブは、表のタブの後ろに出して今いる所を示す。
 *
 * 「その他」のボタンは先に場所を取り(縮めない)、表のタブは帯の幅を測って入るだけ並べる
 * (入らないタブは順に「その他」の先頭へ回す)。今開いているタブは必ず見える。
 * 「その他」のボタンは tablist の外に置く(タブの並びの中にメニューのボタンを混ぜない)。
 */
export function PanelTabBar({
  tabs,
  current,
  onSelect,
  leadingTab
}: {
  tabs: readonly PanelTabBarDef[]
  current: string
  onSelect: (id: string) => void
  /** 先頭に足すタブ(素材をソースで開いたときの「ソース」) */
  leadingTab?: PanelTabBarDef
}): React.JSX.Element {
  const { primary, groups } = splitPanelTabs(tabs)
  const moreTab = isInMore(current, tabs) ? tabs.find((t) => t.id === current) : undefined
  // 表に並べたい順(ソース・よく使うタブ・その他から選んだタブ)
  const candidates = [
    ...(leadingTab ? [leadingTab] : []),
    ...primary,
    ...(moreTab ? [moreTab] : [])
  ]
  const [open, setOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const tablistRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const [shownIds, setShownIds] = useState<string[] | null>(null)
  const candidateKey = candidates.map((t) => t.id).join(',')

  // 帯の幅を測って、表に並べるタブを決める
  useLayoutEffect(() => {
    const list = tablistRef.current
    if (!list) return
    const run = (): void => {
      const m = measureRef.current
      if (!m) return
      const widths = [...m.children].map((e) => e.getBoundingClientRect().width)
      const ids = candidateKey ? candidateKey.split(',') : []
      const next = fitTabs(ids, widths, list.clientWidth, current)
      setShownIds((prev) => (prev && prev.join(',') === next.join(',') ? prev : next))
    }
    run()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => run())
    ro.observe(list)
    return () => ro.disconnect()
  }, [candidateKey, current])

  const visible = shownIds ? candidates.filter((t) => shownIds.includes(t.id)) : candidates
  // 表に入らなかったタブは「その他」の先頭のまとまりへ
  const overflowed = candidates.filter((t) => !visible.includes(t) && t !== moreTab)
  const menuGroups = [
    ...(overflowed.length > 0 ? [{ label: '表に入らないタブ', tabs: overflowed }] : []),
    ...groups
  ]

  const tabButton = (t: PanelTabBarDef): React.JSX.Element => (
    <button
      key={t.id}
      type="button"
      role="tab"
      aria-selected={current === t.id}
      className={`panel-tab ${current === t.id ? 'active' : ''} ${t === moreTab ? 'panel-tab-more-current' : ''}`}
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
    <>
      <div className="panel-tabs panel-tabs-grouped">
        <div className="panel-tabs-list" role="tablist" aria-label="パネル" ref={tablistRef}>
          {visible.map((t) => tabButton(t))}
        </div>
        {menuGroups.length > 0 && (
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
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </button>
        )}
      </div>
      {/* 表のタブの幅を測るための見えない写し(読み上げ・Tab の対象外) */}
      <span
        className="overflow-measure panel-tabs-measure"
        ref={measureRef}
        aria-hidden="true"
        inert
      >
        {candidates.map((t) => (
          <span
            key={t.id}
            className={`panel-tab ${current === t.id ? 'active' : ''} ${t === moreTab ? 'panel-tab-more-current' : ''}`}
          >
            {t.label}
          </span>
        ))}
      </span>
      {open && (
        <Popover
          anchorRef={moreRef}
          onClose={() => setOpen(false)}
          label="ほかのパネル"
          role="menu"
          className="panel-more-menu"
          initialFocus={
            menuGroups.some((g) => g.tabs.some((t) => t.id === current))
              ? `[data-tab="${current}"]`
              : '[role="menuitemradio"]'
          }
        >
          <div ref={listRef} onKeyDown={onMenuKey}>
            {menuGroups.map((g) => (
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
    </>
  )
}

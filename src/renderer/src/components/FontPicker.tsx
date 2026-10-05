import { useEffect, useMemo, useRef, useState } from 'react'
import type { FontFamily } from '@shared/types'
import { FONT_FAMILY_OPTIONS } from '@shared/textStyle'
import { TELOP_FONT_STACKS } from '@shared/telop/render'
import { ChevronDownIcon, SearchIcon } from './icons'
import { Popover } from './Popover'
import { filterFonts } from '../lib/appearanceEdit'

/**
 * 書体を選ぶ欄。一覧の各行をその書体そのもので見せ(Premiere・Canva と同じ)、
 * 名前・分類で絞り込める。キーボード: ↑↓ で移り Enter で決める、Esc で閉じる。
 */

/** 書体の見本の文(かな・漢字・英数字の形が分かる) */
const FONT_SAMPLE = 'あア亜 Aa1'

export function FontPicker({
  value,
  onChange
}: {
  value: FontFamily
  onChange: (v: FontFamily) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = FONT_FAMILY_OPTIONS.find((f) => f.value === value)
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="font-picker-button prop-wide"
        aria-label={`フォント: ${current?.label ?? value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="書体を選ぶ(一覧は各書体で表示。名前で絞り込めます)"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-picker-current" style={{ fontFamily: TELOP_FONT_STACKS[value] }}>
          {current?.label ?? value}
        </span>
        <ChevronDownIcon width={12} height={12} className="font-picker-chevron" />
      </button>
      {open && (
        <Popover
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          label="書体を選ぶ"
          className="font-picker-popover"
          initialFocus=".font-picker-search input"
        >
          <FontList
            value={value}
            onPick={(v) => {
              onChange(v)
              setOpen(false)
              buttonRef.current?.focus()
            }}
          />
        </Popover>
      )}
    </>
  )
}

function FontList({
  value,
  onPick
}: {
  value: FontFamily
  onPick: (v: FontFamily) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const list = useMemo(() => filterFonts(FONT_FAMILY_OPTIONS, query), [query])
  const [cursor, setCursor] = useState(() =>
    Math.max(
      0,
      FONT_FAMILY_OPTIONS.findIndex((f) => f.value === value)
    )
  )
  const listRef = useRef<HTMLUListElement>(null)
  // 開いたら、今の書体が見える所までスクロールする
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'center' })
  }, [])
  const at = Math.min(cursor, list.length - 1)
  const move = (d: number): void => {
    const next = Math.max(0, Math.min(list.length - 1, at + d))
    setCursor(next)
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${next}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div className="font-picker-panel">
      <label className="font-picker-search look-search">
        <SearchIcon width={13} height={13} aria-hidden="true" />
        <input
          type="search"
          aria-label="書体を探す"
          placeholder="書体を探す(例: 丸、明朝、手書き)"
          value={query}
          aria-controls="font-picker-list"
          aria-activedescendant={list[at] ? `font-opt-${list[at].value}` : undefined}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              move(1)
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              move(-1)
            } else if (e.key === 'Enter' && list[at]) {
              e.preventDefault()
              onPick(list[at].value as FontFamily)
            }
          }}
        />
      </label>
      {list.length === 0 ? (
        <p className="section-preset-empty">「{query}」に合う書体はありません。</p>
      ) : (
        <ul
          id="font-picker-list"
          ref={listRef}
          className="font-picker-list"
          role="listbox"
          aria-label="書体"
        >
          {list.map((f, i) => {
            const head = i === 0 || list[i - 1].group !== f.group ? f.group : null
            return (
              <li key={f.value} role="presentation">
                {head && <div className="font-picker-group">{head}</div>}
                <div
                  id={`font-opt-${f.value}`}
                  role="option"
                  data-index={i}
                  aria-selected={f.value === value}
                  className={`font-picker-option ${i === at ? 'cursor' : ''} ${f.value === value ? 'selected' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(f.value as FontFamily)}
                >
                  <span
                    className="font-picker-sample"
                    style={{ fontFamily: TELOP_FONT_STACKS[f.value as FontFamily] }}
                  >
                    {FONT_SAMPLE}
                  </span>
                  <span
                    className="font-picker-name"
                    style={{ fontFamily: TELOP_FONT_STACKS[f.value as FontFamily] }}
                  >
                    {f.label}
                  </span>
                  {f.value === value && <span className="font-picker-check">✓</span>}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

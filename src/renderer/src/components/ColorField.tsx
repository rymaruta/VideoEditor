import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { normalizeHex, parseColor, rgbToHex, type Rgb } from '../lib/colorValue'
import { useSettingsStore } from '../store/settingsStore'

/** 吹き出しと見本・画面の端との間 */
const POPOVER_GAP = 6
const VIEWPORT_MARGIN = 8

/**
 * 色の欄。押すと、RGB の数値・16進・パレットで自由に選べ、お気に入りの色を保存・呼び出せる。
 * テロップの文字・縁・帯・強調、サムネイルの文字など、色を選ぶ所はすべてこれを使う
 * (お気に入りはどの欄からでも同じものが使える)。
 *
 * 吹き出しは document.body に出す。欄の中に置くと、スクロールする枠(overflow: auto)で切れる。
 */
export function ColorField({
  value,
  onChange,
  label,
  mixed = false
}: {
  value: string
  onChange: (hex: string) => void
  /** 読み上げ・ツールチップ用の名前(「文字の色」など) */
  label: string
  /** 複数のテロップで色が混在している */
  mixed?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const swatchRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const hex = normalizeHex(value) ?? '#ffffff'

  // 見本の位置から吹き出しの位置を決める。下・右に入りきらなければ上・左へ返す
  const place = useCallback((): void => {
    const swatch = swatchRef.current
    const pop = popoverRef.current
    if (!swatch || !pop) return
    const r = swatch.getBoundingClientRect()
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = r.bottom + POPOVER_GAP
    if (top + h > vh - VIEWPORT_MARGIN && r.top - POPOVER_GAP - h >= VIEWPORT_MARGIN)
      top = r.top - POPOVER_GAP - h
    let left = r.left
    if (left + w > vw - VIEWPORT_MARGIN) left = r.right - w
    // どちらにも入りきらないときは、画面の中に押し込む(端が切れるよりよい)
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - VIEWPORT_MARGIN - h))
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - VIEWPORT_MARGIN - w))
    setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }))
  }, [])

  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      // 吹き出しは欄の外(body)にあるので、両方を見る
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    // 枠のスクロールでも見本が動くので、capture で拾って付いていく
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
  }, [open, place])

  return (
    <div className="color-field" ref={rootRef}>
      <button
        ref={swatchRef}
        type="button"
        className={`color-field-swatch ${mixed ? 'mixed' : ''}`}
        style={mixed ? undefined : { background: hex }}
        aria-label={`${label}: ${mixed ? '混在' : hex}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${label} ${mixed ? '(混在)' : hex}`}
        onClick={() => {
          // 開き直すときは前の位置を使わない(見本が動いているかもしれない)
          setPos(null)
          setOpen((v) => !v)
        }}
      />
      {open &&
        createPortal(
          <ColorPopover
            ref={popoverRef}
            hex={hex}
            label={label}
            onChange={onChange}
            onResize={place}
            // 位置が決まるまでは見せない(左上に一瞬出るのを防ぐ)
            style={
              pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }
            }
          />,
          document.body
        )}
    </div>
  )
}

function ColorPopover({
  ref,
  hex,
  label,
  onChange,
  onResize,
  style
}: {
  ref: React.RefObject<HTMLDivElement | null>
  hex: string
  label: string
  onChange: (hex: string) => void
  /** 中身の高さが変わった(エラー文・お気に入りの増減)。上に返した位置を直す */
  onResize: () => void
  style: React.CSSProperties
}): React.JSX.Element {
  const favorites = useSettingsStore((s) => s.favoriteColors)
  const addFavorite = useSettingsStore((s) => s.addFavoriteColor)
  const removeFavorite = useSettingsStore((s) => s.removeFavoriteColor)
  const rgb = parseColor(hex) ?? { r: 255, g: 255, b: 255 }
  // 16進の欄は打っている途中の値を持つ(打ち終わるまで色を変えない)
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const draftValid = hexDraft === null || normalizeHex(hexDraft) !== null

  const setChannel = (key: keyof Rgb, v: number): void => {
    if (!Number.isFinite(v)) return
    onChange(rgbToHex({ ...rgb, [key]: v }))
  }
  const commitHex = (): void => {
    if (hexDraft === null) return
    const next = normalizeHex(hexDraft)
    if (next) onChange(next)
    setHexDraft(null)
  }
  const isFavorite = favorites.includes(hex)

  useLayoutEffect(() => {
    onResize()
  }, [onResize, draftValid, favorites.length])

  return (
    <div
      ref={ref}
      className="color-popover"
      role="dialog"
      aria-label={`${label}を選ぶ`}
      style={style}
    >
      <div className="color-popover-head">
        <span className="color-popover-preview" style={{ background: hex }} />
        <input
          type="color"
          aria-label="パレットから選ぶ"
          title="パレットから選ぶ"
          value={hex}
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className={`color-popover-hex ${draftValid ? '' : 'invalid'}`}
          aria-label="16進の色"
          aria-invalid={!draftValid}
          spellCheck={false}
          value={hexDraft ?? hex}
          onChange={(e) => setHexDraft(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHex()
          }}
        />
      </div>
      {!draftValid && (
        <p className="color-popover-error">#ff8800・ff8800・rgb(255,136,0) の形で入れてください</p>
      )}
      {(['r', 'g', 'b'] as const).map((key) => (
        <label key={key} className={`color-popover-channel ${key}`}>
          <span className="color-popover-channel-name">{key.toUpperCase()}</span>
          <input
            type="range"
            min={0}
            max={255}
            aria-label={`${key.toUpperCase()}(0〜255)`}
            value={rgb[key]}
            onChange={(e) => setChannel(key, Number(e.target.value))}
          />
          <input
            type="number"
            min={0}
            max={255}
            className="prop-num"
            aria-label={`${key.toUpperCase()} の値`}
            value={rgb[key]}
            onChange={(e) => setChannel(key, Number(e.target.value))}
          />
        </label>
      ))}
      <div className="color-popover-favorites-head">
        <span>お気に入り</span>
        <button
          type="button"
          className="small-button"
          disabled={isFavorite}
          onClick={() => addFavorite(hex)}
        >
          {isFavorite ? '保存済み' : '今の色を保存'}
        </button>
      </div>
      {favorites.length === 0 ? (
        <p className="color-popover-empty">よく使う色を保存すると、ここから1回で選べます</p>
      ) : (
        <div className="color-popover-favorites" role="list">
          {favorites.map((c) => (
            <div key={c} className="color-popover-favorite" role="listitem">
              <button
                type="button"
                className={`color-popover-favorite-swatch ${c === hex ? 'active' : ''}`}
                style={{ background: c }}
                aria-label={`お気に入りの色 ${c} を使う`}
                title={c}
                onClick={() => onChange(c)}
              />
              <button
                type="button"
                className="color-popover-favorite-remove"
                aria-label={`お気に入りから ${c} を外す`}
                title="お気に入りから外す"
                onClick={() => removeFavorite(c)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

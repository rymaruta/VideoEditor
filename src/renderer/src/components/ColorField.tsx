import { useEffect, useRef, useState } from 'react'
import { normalizeHex, parseColor, rgbToHex, type Rgb } from '../lib/colorValue'
import { useSettingsStore } from '../store/settingsStore'

/**
 * 色の欄。押すと、RGB の数値・16進・パレットで自由に選べ、お気に入りの色を保存・呼び出せる。
 * テロップの文字・縁・帯・強調、サムネイルの文字など、色を選ぶ所はすべてこれを使う
 * (お気に入りはどの欄からでも同じものが使える)。
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
  const hex = normalizeHex(value) ?? '#ffffff'

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div className="color-field" ref={rootRef}>
      <button
        type="button"
        className={`color-field-swatch ${mixed ? 'mixed' : ''}`}
        style={mixed ? undefined : { background: hex }}
        aria-label={`${label}: ${mixed ? '混在' : hex}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${label} ${mixed ? '(混在)' : hex}`}
        onClick={() => setOpen((v) => !v)}
      />
      {open && <ColorPopover hex={hex} label={label} onChange={onChange} />}
    </div>
  )
}

function ColorPopover({
  hex,
  label,
  onChange
}: {
  hex: string
  label: string
  onChange: (hex: string) => void
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

  return (
    <div className="color-popover" role="dialog" aria-label={`${label}を選ぶ`}>
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

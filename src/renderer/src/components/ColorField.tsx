import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { normalizeHex, parseColor, rgbToHex, type Rgb } from '../lib/colorValue'
import { placePopover } from '../lib/appearanceEdit'
import { useSettingsStore } from '../store/settingsStore'

/**
 * 色の欄。押すと、RGB の数値・16進・パレット・スポイトで自由に選べ、
 * お気に入りの色を保存・呼び出せる。選んだ色は「最近使った色」に自動で残る。
 * テロップの文字・縁・帯・強調、サムネイルの文字など、色を選ぶ所はすべてこれを使う
 * (お気に入り・最近使った色はどの欄からでも同じものが使える)。
 *
 * 吹き出しは document.body に出す。欄の中に置くと、スクロールする枠(overflow: auto)で切れる。
 * キーボード: 開くと16進の欄にフォーカス、Esc で閉じて見本に戻る。色の並びは ← → で移り、
 * お気に入りは Delete で外せる。
 */

interface EyeDropperResult {
  sRGBHex: string
}
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> }

/** Chromium のスポイト(画面のどこからでも色を拾える)。無ければ undefined */
function eyeDropper(): EyeDropperCtor | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
    : undefined
}

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
  const pushRecent = useSettingsStore((s) => s.pushRecentColor)
  // 開いたときの色と今の色(閉じたときに変わっていれば「最近使った色」に残す)
  const openedWith = useRef<string | null>(null)
  const latest = useRef(hex)
  // スポイトで拾っている間は、外を押しても閉じない
  const picking = useRef(false)
  useLayoutEffect(() => {
    latest.current = hex
  })

  const close = useCallback(
    (focusSwatch = false): void => {
      setOpen(false)
      if (openedWith.current !== null && openedWith.current !== latest.current)
        pushRecent(latest.current)
      openedWith.current = null
      if (focusSwatch) swatchRef.current?.focus()
    },
    [pushRecent]
  )

  // 開いたまま欄が消えた(テロップを選び直した)ときも、選んだ色は残す
  useEffect(
    () => () => {
      if (openedWith.current !== null && openedWith.current !== latest.current)
        useSettingsStore.getState().pushRecentColor(latest.current)
    },
    []
  )

  // 見本の位置から吹き出しの位置を決める。下・右に入りきらなければ上・左へ返す
  const place = useCallback((): void => {
    const swatch = swatchRef.current
    const pop = popoverRef.current
    if (!swatch || !pop) return
    const next = placePopover(
      swatch.getBoundingClientRect(),
      { width: pop.offsetWidth, height: pop.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setPos((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next))
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    const pop = popoverRef.current
    if (!pop) return
    const ro = new ResizeObserver(() => place())
    ro.observe(pop)
    return () => ro.disconnect()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (picking.current) return
      const target = e.target as Node
      // 吹き出しは欄の外(body)にあるので、両方を見る
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return
      close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(true)
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
  }, [open, place, close])

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
          if (open) {
            close()
            return
          }
          // 開き直すときは前の位置を使わない(見本が動いているかもしれない)
          setPos(null)
          openedWith.current = hex
          setOpen(true)
        }}
      />
      {open &&
        createPortal(
          <ColorPopover
            ref={popoverRef}
            hex={hex}
            label={label}
            onChange={onChange}
            onPicking={(v) => {
              picking.current = v
            }}
            ready={pos !== null}
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

/** 色の並び(お気に入り・最近使った色)の中を ← → ↑ ↓ で移る */
function moveInGrid(e: React.KeyboardEvent<HTMLElement>, columns: number): void {
  const keys: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -columns,
    ArrowDown: columns
  }
  const d = keys[e.key]
  if (d === undefined) return
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-swatch]')]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (i < 0) return
  e.preventDefault()
  items[Math.max(0, Math.min(items.length - 1, i + d))]?.focus()
}

function ColorPopover({
  ref,
  hex,
  label,
  onChange,
  onPicking,
  ready,
  style
}: {
  ref: React.RefObject<HTMLDivElement | null>
  hex: string
  label: string
  onChange: (hex: string) => void
  /** スポイトで拾っている間(外を押しても閉じない) */
  onPicking: (picking: boolean) => void
  /** 位置が決まって見えている(見えない要素にはフォーカスできない) */
  ready: boolean
  style: React.CSSProperties
}): React.JSX.Element {
  const favorites = useSettingsStore((s) => s.favoriteColors)
  const recent = useSettingsStore((s) => s.recentColors)
  const addFavorite = useSettingsStore((s) => s.addFavoriteColor)
  const removeFavorite = useSettingsStore((s) => s.removeFavoriteColor)
  const rgb = parseColor(hex) ?? { r: 255, g: 255, b: 255 }
  // 16進の欄は打っている途中の値を持つ(打ち終わるまで色を変えない)
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const draftValid = hexDraft === null || normalizeHex(hexDraft) !== null
  const hexRef = useRef<HTMLInputElement>(null)
  const Dropper = eyeDropper()

  // 開いたら16進の欄へ(打ってすぐ Enter で決められる)
  const focused = useRef(false)
  useEffect(() => {
    if (!ready || focused.current) return
    focused.current = true
    hexRef.current?.focus({ preventScroll: true })
    hexRef.current?.select()
  }, [ready])

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
  const pickFromScreen = async (): Promise<void> => {
    if (!Dropper) return
    onPicking(true)
    try {
      const r = await new Dropper().open()
      const next = normalizeHex(r.sRGBHex)
      if (next) onChange(next)
    } catch {
      // Esc で取りやめた
    } finally {
      // 拾ったときの mousedown が先に届くので、少し待ってから外の押下を見る
      window.setTimeout(() => onPicking(false), 0)
    }
  }
  const isFavorite = favorites.includes(hex)
  const recentOnly = recent.filter((c) => c !== hex).slice(0, 12)

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
          ref={hexRef}
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
        {Dropper && (
          <button
            type="button"
            className="icon-chip color-popover-dropper"
            aria-label="スポイトで画面から色を拾う"
            title="スポイト: 画面(プレビューの映像など)を押して、その色を拾います。Esc でやめます"
            onClick={() => void pickFromScreen()}
          >
            <EyedropperIcon />
          </button>
        )}
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
      {recentOnly.length > 0 && (
        <>
          <div className="color-popover-favorites-head">
            <span>最近使った色</span>
          </div>
          <div
            className="color-popover-favorites recent"
            role="list"
            aria-label="最近使った色"
            onKeyDown={(e) => moveInGrid(e, 8)}
          >
            {recentOnly.map((c) => (
              <div key={c} className="color-popover-favorite" role="listitem">
                <button
                  type="button"
                  data-swatch
                  className="color-popover-favorite-swatch"
                  style={{ background: c }}
                  aria-label={`最近使った色 ${c} を使う`}
                  title={c}
                  onClick={() => onChange(c)}
                />
              </div>
            ))}
          </div>
        </>
      )}
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
        <div
          className="color-popover-favorites"
          role="list"
          aria-label="お気に入りの色"
          onKeyDown={(e) => moveInGrid(e, 8)}
        >
          {favorites.map((c) => (
            <div key={c} className="color-popover-favorite" role="listitem">
              <button
                type="button"
                data-swatch
                className={`color-popover-favorite-swatch ${c === hex ? 'active' : ''}`}
                style={{ background: c }}
                aria-label={`お気に入りの色 ${c} を使う(Delete で外す)`}
                title={`${c}(Delete で外す)`}
                onClick={() => onChange(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Delete' || e.key === 'Backspace') {
                    e.preventDefault()
                    const next =
                      (e.currentTarget.parentElement?.nextElementSibling?.querySelector(
                        '[data-swatch]'
                      ) as HTMLElement | null) ??
                      (e.currentTarget.parentElement?.previousElementSibling?.querySelector(
                        '[data-swatch]'
                      ) as HTMLElement | null)
                    removeFavorite(c)
                    next?.focus()
                  }
                }}
              />
              <button
                type="button"
                tabIndex={-1}
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

function EyedropperIcon(): React.JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m2 22 1-1h3l9-9" />
      <path d="M3 21v-3l9-9" />
      <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
    </svg>
  )
}

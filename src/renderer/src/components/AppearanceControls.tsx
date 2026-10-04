import { useState } from 'react'
import type { TelopGradient } from '@shared/types'
import { gradientCss, gradientFromColor, colorFromGradient } from '../lib/telopAppearance'
import { ColorField } from './ColorField'
import { GradientEditor } from './GradientEditor'
import { ChevronDownIcon } from './icons'

/**
 * テロップの見た目の欄で使う小さな部品(畳める見出し・数値+つまみ・切り替えボタン・塗り)。
 * Premiere のエッセンシャルグラフィックス「アピアランス」のように、項目ごとに畳め、
 * 影・背景などは見出しのチェックで入り切りできる。
 */

const OPEN_KEY = 'telopStyleSectionsOpen'

function readOpen(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(OPEN_KEY)
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeOpen(id: string, open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, JSON.stringify({ ...readOpen(), [id]: open }))
  } catch {
    // 保存できなくても開け閉めはできる
  }
}

/** 畳める見出し。開け閉めは覚えておく(テロップを選び直しても同じ開き方) */
export function StyleSection({
  id,
  title,
  defaultOpen = false,
  enabled,
  onToggle,
  summary,
  children
}: {
  id: string
  title: string
  defaultOpen?: boolean
  /** 入り切りのある項目(影・背景など)。undefined なら切り替え無し */
  enabled?: boolean
  onToggle?: (on: boolean) => void
  /** 畳んでいるときに見出しの右に出す短い説明 */
  summary?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpenState] = useState(() => readOpen()[id] ?? defaultOpen)
  const setOpen = (v: boolean): void => {
    setOpenState(v)
    writeOpen(id, v)
  }
  const off = enabled === false
  const bodyId = `style-section-${id}`
  return (
    <section className={`style-section ${open ? 'open' : ''} ${off ? 'off' : ''}`}>
      <div className="style-section-head">
        <button
          type="button"
          className="style-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
        >
          <ChevronDownIcon width={12} height={12} className="style-section-chevron" />
          <span className="style-section-title">{title}</span>
          {summary && <span className="style-section-summary">{summary}</span>}
        </button>
        {enabled !== undefined && onToggle && (
          <input
            type="checkbox"
            className="style-section-check"
            aria-label={`${title}を使う`}
            title={enabled ? `${title}を外す` : `${title}を付ける`}
            checked={enabled}
            onChange={(e) => {
              onToggle(e.target.checked)
              if (e.target.checked && !open) setOpen(true)
            }}
          />
        )}
      </div>
      {open && (
        <div className="style-section-body" id={bodyId}>
          {off ? (
            <p className="hint-text style-section-off">チェックを入れると付きます。</p>
          ) : (
            children
          )}
        </div>
      )}
    </section>
  )
}

/**
 * 数値(つまみ + 数値欄)。`scale` を掛けた値を見せる(不透明度 0〜1 を % で見せるなど)。
 * 数値欄は打っている途中の範囲外の値で値を壊さないよう、範囲内になったときだけ反映する。
 */
export function NumberSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  sliderMin,
  sliderMax,
  unit,
  scale = 1,
  slider = true,
  digits
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  sliderMin?: number
  sliderMax?: number
  unit?: string
  scale?: number
  slider?: boolean
  /** 数値欄に見せる小数の桁 */
  digits?: number
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = value * scale
  const d = digits ?? (step < 1 ? Math.min(2, String(step).split('.')[1]?.length ?? 1) : 0)
  const text = Number.isFinite(shown) ? String(Number(shown.toFixed(d))) : ''
  const commit = (raw: string): void => {
    const v = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(v)) return
    if (v < min || v > max) return
    onChange(v / scale)
  }
  return (
    <span className="num-slider">
      {slider && (
        <input
          type="range"
          aria-label={label}
          min={sliderMin ?? min}
          max={sliderMax ?? max}
          step={step}
          value={Math.min(sliderMax ?? max, Math.max(sliderMin ?? min, shown))}
          onChange={(e) => onChange(Number(e.target.value) / scale)}
        />
      )}
      <input
        type="number"
        className="prop-num"
        aria-label={slider ? `${label}(数値)` : label}
        min={min}
        max={max}
        step={step}
        value={draft ?? text}
        onChange={(e) => {
          setDraft(e.target.value)
          commit(e.target.value)
        }}
        onBlur={() => setDraft(null)}
      />
      {unit && <span className="prop-unit">{unit}</span>}
    </span>
  )
}

/** 切り替えボタンの組(左・中央・右揃え、単色/グラデーションなど) */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: React.ReactNode; title?: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="seg-group" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`seg-button ${o.value === value ? 'active' : ''}`}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export type FillMode = 'inherit' | 'solid' | 'gradient'

/**
 * 塗り(単色 / グラデーション、部分の装飾では「本文と同じ」も)。
 * 切り替えても前の色を手がかりにする(単色 → グラデーションは今の色から始める)。
 */
export function FillField({
  label,
  color,
  gradient,
  onChange,
  allowInherit = false,
  fallbackColor = '#ffffff'
}: {
  label: string
  color: string | undefined
  gradient: TelopGradient | undefined
  onChange: (next: { color?: string; gradient?: TelopGradient }) => void
  allowInherit?: boolean
  /** 「本文と同じ」から切り替えたときに始める色 */
  fallbackColor?: string
}): React.JSX.Element {
  const mode: FillMode = gradient ? 'gradient' : color || !allowInherit ? 'solid' : 'inherit'
  const solid = color ?? fallbackColor
  const options: { value: FillMode; label: React.ReactNode; title?: string }[] = [
    ...(allowInherit
      ? [{ value: 'inherit' as const, label: '本文と同じ', title: '本文の塗りをそのまま使います' }]
      : []),
    { value: 'solid', label: '単色' },
    {
      value: 'gradient',
      label: (
        <>
          <span
            className="seg-grad-swatch"
            style={{ background: gradientCss(gradient ?? gradientFromColor(solid)) }}
          />
          グラデーション
        </>
      )
    }
  ]
  return (
    <div className="fill-field">
      <div className="fill-field-head">
        <Segmented
          label={`${label}の種類`}
          value={mode}
          options={options}
          onChange={(m) => {
            if (m === mode) return
            if (m === 'inherit') onChange({ color: undefined, gradient: undefined })
            else if (m === 'solid')
              onChange({
                color: gradient ? (color ?? colorFromGradient(gradient)) : solid,
                gradient: undefined
              })
            else onChange({ color, gradient: gradientFromColor(solid) })
          }}
        />
        {mode === 'solid' && (
          <ColorField
            label={label}
            value={solid}
            onChange={(hex) => onChange({ color: hex, gradient: undefined })}
          />
        )}
      </div>
      {mode === 'gradient' && gradient && (
        <GradientEditor
          label={label}
          value={gradient}
          onChange={(g) => onChange({ color, gradient: g })}
        />
      )}
    </div>
  )
}

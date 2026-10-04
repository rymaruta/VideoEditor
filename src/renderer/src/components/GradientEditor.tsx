import { useRef, useState } from 'react'
import type { TelopGradient } from '@shared/types'
import {
  addGradientStop,
  GRADIENT_MAX_STOPS,
  GRADIENT_MIN_STOPS,
  GRADIENT_PRESETS,
  gradientBarCss,
  gradientCss,
  moveGradientStop,
  normalizeAngle,
  recolorGradientStop,
  removeGradientStop
} from '../lib/telopAppearance'
import { ColorField } from './ColorField'

/**
 * グラデーションの編集欄(Premiere の「線形グラデーション」の止まりの帯と同じ操作)。
 *
 * - 帯を押すと、その位置に色の止まりを足す(最大8色)
 * - 帯の下のつまみを左右に引くと位置が動く。選んだつまみの色・位置は下の欄で直す
 * - つまみを選んで Delete / × で消す(最低2色は残す)
 * - 向きは丸いつまみ(引いて回す)か数値。よく使う向きと色の組はボタン1つで
 *
 * 文字の塗り・縁・背景・部分の装飾、どこでも同じ部品を使う。
 */
export function GradientEditor({
  value,
  onChange,
  label
}: {
  value: TelopGradient
  onChange: (g: TelopGradient) => void
  /** 読み上げ用の名前(「文字の塗り」など) */
  label: string
}): React.JSX.Element {
  const [selected, setSelected] = useState(0)
  const barRef = useRef<HTMLDivElement>(null)
  // 引きずっている間は、親から戻る前の最新の値と番号を持つ
  const latest = useRef(value)
  latest.current = value
  const dragIndex = useRef<number | null>(null)

  const sel = Math.min(selected, value.stops.length - 1)
  const stop = value.stops[sel]

  const atFromEvent = (clientX: number): number => {
    const r = barRef.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return 0
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  }

  function onBarDown(e: React.PointerEvent): void {
    if (e.button !== 0) return
    const { gradient, index } = addGradientStop(value, atFromEvent(e.clientX))
    if (index < 0) return
    onChange(gradient)
    setSelected(index)
  }

  function onHandleDown(e: React.PointerEvent, index: number): void {
    if (e.button !== 0) return
    e.stopPropagation()
    setSelected(index)
    dragIndex.current = index
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onHandleMove(e: React.PointerEvent): void {
    if (dragIndex.current === null) return
    const { gradient, index } = moveGradientStop(
      latest.current,
      dragIndex.current,
      atFromEvent(e.clientX)
    )
    dragIndex.current = index
    latest.current = gradient
    onChange(gradient)
    setSelected(index)
  }

  function onHandleUp(e: React.PointerEvent): void {
    dragIndex.current = null
    const el = e.currentTarget as HTMLElement
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  }

  function remove(index: number): void {
    if (value.stops.length <= GRADIENT_MIN_STOPS) return
    onChange(removeGradientStop(value, index))
    setSelected(Math.max(0, index - 1))
  }

  function onHandleKey(e: React.KeyboardEvent, index: number): void {
    const s = value.stops[index]
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const step = (e.shiftKey ? 0.1 : 0.01) * (e.key === 'ArrowLeft' ? -1 : 1)
      const moved = moveGradientStop(value, index, s.at + step)
      onChange(moved.gradient)
      setSelected(moved.index)
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      remove(index)
    }
  }

  return (
    <div className="grad-editor" role="group" aria-label={`${label}のグラデーション`}>
      <div className="grad-bar-wrap">
        <div
          ref={barRef}
          className="grad-bar"
          title={
            value.stops.length < GRADIENT_MAX_STOPS
              ? '押すと、その位置に色を足します'
              : `色は ${GRADIENT_MAX_STOPS} つまでです`
          }
          onPointerDown={onBarDown}
        >
          <div className="grad-bar-fill" style={{ background: gradientBarCss(value) }} />
        </div>
        <div className="grad-handles">
          {value.stops.map((s, i) => (
            <button
              key={i}
              type="button"
              className={`grad-handle ${i === sel ? 'selected' : ''}`}
              style={{ left: `${s.at * 100}%`, ['--stop' as string]: s.color }}
              aria-label={`${label}の色 ${i + 1}(位置 ${Math.round(s.at * 100)}%)`}
              aria-pressed={i === sel}
              onPointerDown={(e) => onHandleDown(e, i)}
              onPointerMove={onHandleMove}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
              onKeyDown={(e) => onHandleKey(e, i)}
              onClick={() => setSelected(i)}
            />
          ))}
        </div>
      </div>

      {stop && (
        <div className="grad-row">
          <span className="grad-row-label">色 {sel + 1}</span>
          <ColorField
            label={`${label}の色 ${sel + 1}`}
            value={stop.color}
            onChange={(hex) => onChange(recolorGradientStop(value, sel, hex))}
          />
          <input
            type="number"
            className="prop-num"
            aria-label={`${label}の色 ${sel + 1} の位置(%)`}
            min={0}
            max={100}
            value={Math.round(stop.at * 100)}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (e.target.value === '' || !Number.isFinite(v)) return
              const moved = moveGradientStop(value, sel, v / 100)
              onChange(moved.gradient)
              setSelected(moved.index)
            }}
          />
          <span className="prop-unit">%</span>
          <button
            type="button"
            className="icon-chip"
            aria-label={`${label}の色 ${sel + 1} を消す`}
            title="この色を消す(最低2色)"
            disabled={value.stops.length <= GRADIENT_MIN_STOPS}
            onClick={() => remove(sel)}
          >
            ×
          </button>
          <span className="grad-count" title="色の数">
            {value.stops.length}/{GRADIENT_MAX_STOPS}
          </span>
        </div>
      )}

      <div className="grad-row">
        <span className="grad-row-label">向き</span>
        <AngleDial
          label={`${label}の向き`}
          value={value.angle}
          kind="gradient"
          onChange={(angle) => onChange({ ...value, angle })}
        />
        <input
          type="number"
          className="prop-num"
          aria-label={`${label}の向き(度)`}
          min={0}
          max={359}
          value={normalizeAngle(value.angle)}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (e.target.value === '' || !Number.isFinite(v)) return
            onChange({ ...value, angle: normalizeAngle(v) })
          }}
        />
        <span className="prop-unit">度</span>
        <div className="grad-angle-presets">
          {[0, 45, 90, 135, 180, 270].map((a) => (
            <button
              key={a}
              type="button"
              className={`angle-chip ${normalizeAngle(value.angle) === a ? 'active' : ''}`}
              aria-label={`向きを ${a} 度に`}
              title={`${a}°`}
              onClick={() => onChange({ ...value, angle: a })}
            >
              <span style={{ transform: `rotate(${-a}deg)` }}>↓</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grad-presets" role="group" aria-label={`${label}のグラデーションの見本`}>
        {GRADIENT_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            className="grad-preset"
            title={p.name}
            aria-label={`グラデーション「${p.name}」`}
            onClick={() => {
              onChange(p.gradient)
              setSelected(0)
            }}
          >
            <span className="grad-preset-swatch" style={{ background: gradientCss(p.gradient) }} />
            <span className="grad-preset-name">{p.name}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 向きの丸いつまみ。引いて回す(Shift で 45° 刻み)。
 * `gradient` は 0 が下向き・90 が右向き(グラデーションの流れ)、
 * `shadow` は 0 が右・90 が下(影の落ちる向き)。
 */
export function AngleDial({
  value,
  onChange,
  label,
  kind
}: {
  value: number
  onChange: (deg: number) => void
  label: string
  kind: 'gradient' | 'shadow'
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const rad = (value * Math.PI) / 180
  // 画面上の向き(y は下向き)
  const vx = kind === 'gradient' ? Math.sin(rad) : Math.cos(rad)
  const vy = kind === 'gradient' ? Math.cos(rad) : Math.sin(rad)

  const fromPointer = (e: React.PointerEvent): void => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    if (Math.hypot(dx, dy) < 2) return
    let deg =
      kind === 'gradient'
        ? (Math.atan2(dx, dy) * 180) / Math.PI
        : (Math.atan2(dy, dx) * 180) / Math.PI
    if (e.shiftKey) deg = Math.round(deg / 45) * 45
    deg = ((Math.round(deg) % 360) + 360) % 360
    if (kind === 'shadow' && deg > 180) deg -= 360
    onChange(deg)
  }

  return (
    <div
      ref={ref}
      className="angle-dial"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={kind === 'gradient' ? 0 : -180}
      aria-valuemax={kind === 'gradient' ? 359 : 180}
      aria-valuenow={Math.round(value)}
      title="引いて回す(Shift で 45° 刻み)"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        fromPointer(e)
      }}
      onPointerMove={(e) => dragging.current && fromPointer(e)}
      onPointerUp={(e) => {
        dragging.current = false
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const step = (e.shiftKey ? 15 : 1) * (e.key === 'ArrowLeft' ? -1 : 1)
        onChange(Math.round(value) + step)
      }}
    >
      <svg viewBox="-12 -12 24 24" width={24} height={24} aria-hidden="true">
        <circle r={10.5} className="angle-dial-ring" />
        <line x1={0} y1={0} x2={vx * 9} y2={vy * 9} className="angle-dial-hand" />
        <circle cx={vx * 9} cy={vy * 9} r={2} className="angle-dial-tip" />
      </svg>
    </div>
  )
}

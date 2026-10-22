import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import type { Scene, SceneJudgement } from '@shared/structure/scenes'
import { speakerColor } from '@shared/speaker'
import {
  eventRanges,
  formatDuration,
  frameSourceAt,
  sourceLanes,
  speakerLanes,
  type Range,
  type SceneChip,
  type StepState,
  SCENE_BAND_COLORS,
  keptOrder,
  rulerTicks
} from '../lib/autoEditView'
import type { NextAction, NextActionButton, NextActionId } from '../lib/autoEditNext'

/** 工程の状態の印。色だけでなく形でも分ける(済んだ=丸にチェック・進行中=弧・待ち=点線の丸・省いた=横棒・止まった=四角) */
export function StepIcon({
  state,
  percent = 0
}: {
  state: StepState
  percent?: number
}): React.JSX.Element {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true } as const
  switch (state) {
    case 'done':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" fill="var(--ve-success-soft)" />
          <path d="m7.5 12 3 3 6-6.5" fill="none" stroke="var(--ve-success)" strokeWidth="2.4" />
        </svg>
      )
    case 'run': {
      // 進んだ割合だけ弧を伸ばす(最低でも少しは見せる)
      const frac = Math.min(0.97, Math.max(0.08, percent / 100))
      const a = frac * 2 * Math.PI
      const x = 12 + 9 * Math.sin(a)
      const y = 12 - 9 * Math.cos(a)
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--ve-border)" strokeWidth="3" />
          <path
            d={`M12 3A9 9 0 ${frac > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`}
            fill="none"
            stroke="var(--ve-primary)"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )
    }
    case 'skipped':
      return (
        <svg {...common}>
          <circle
            cx="12"
            cy="12"
            r="9"
            fill="none"
            stroke="var(--ve-border-strong)"
            strokeWidth="2"
          />
          <path d="M8 12h8" stroke="var(--ve-text-3)" strokeWidth="2" />
        </svg>
      )
    case 'error':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" fill="var(--ve-danger-soft)" />
          <path
            d="M12 7.5v5.5M12 16.5h.01"
            stroke="var(--ve-danger)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <circle
            cx="12"
            cy="12"
            r="8.5"
            fill="none"
            stroke="var(--ve-border-strong)"
            strokeWidth="2"
            strokeDasharray="3 3"
          />
        </svg>
      )
  }
}

/** 区間を、全体の長さ `span` に対する帯の位置に */
function place(r: Range, span: number): React.CSSProperties {
  return {
    left: `${(r.start / span) * 100}%`,
    width: `${Math.max(0.15, ((r.end - r.start) / span) * 100)}%`
  }
}

/** 目盛り(6 本前後の切りのよい間隔) */
export function SpanRuler({ span }: { span: number }): React.JSX.Element {
  return (
    <span className="ae-ruler tc" aria-hidden="true">
      {rulerTicks(span).map((t) => (
        <span key={t} style={{ left: `${(t / span) * 100}%` }}>
          {formatDuration(t)}
        </span>
      ))}
      <span className="ae-ruler-end">{formatDuration(span)}</span>
    </span>
  )
}

/**
 * 「素材の全体で見つかったもの」。同期した収録の全体(共通の時刻)に、機材・話者・文字起こし・
 * 笑い/歓声・場面を帯で並べる。まだの工程は空の帯(縞)にして、工程が進むと埋まる
 */
export function FoundOverview({
  project,
  span,
  transcribe,
  events,
  scenes,
  keptOf
}: {
  project: Project
  span: number
  transcribe: { state: StepState; percent: number }
  events: StepState
  scenes: readonly Scene[]
  keptOf: (id: string) => boolean
}): React.JSX.Element {
  const sources = sourceLanes(project)
  const speakers = speakerLanes(project)
  const found = eventRanges(project)
  const transcribed =
    transcribe.state === 'done' || transcribe.state === 'skipped'
      ? 1
      : transcribe.state === 'run'
        ? transcribe.percent / 100
        : 0
  return (
    <section className="ae-card" aria-label="素材の全体で見つかったもの">
      <div className="ae-card-head">
        <span className="ae-card-title">{formatDuration(span)} の全体で見つかったもの</span>
        <span className="ae-muted">工程が進むと行が埋まります</span>
      </div>
      <div className="ae-found">
        <span />
        <SpanRuler span={span} />
        {sources.map((s) => (
          <FoundRow key={s.id} label={s.name}>
            <div className="ae-lane">
              {s.ranges.map((r, i) => (
                <span
                  key={i}
                  className={`ae-mark ${project.multicam?.sources.find((x) => x.id === s.id)?.kind === 'mic' ? 'mic' : 'camera'}`}
                  style={place(r, span)}
                />
              ))}
            </div>
          </FoundRow>
        ))}
        {speakers.length > 0 && (
          <FoundRow label="話者">
            <div className="ae-lane-stack">
              {speakers.map((s) => (
                <div key={s.speaker} className="ae-lane thin" title={s.speaker}>
                  {s.ranges.map((r, i) => (
                    <span
                      key={i}
                      className="ae-mark"
                      style={{ ...place(r, span), background: speakerColor(s.speaker) }}
                    />
                  ))}
                </div>
              ))}
            </div>
          </FoundRow>
        )}
        <FoundRow label="文字起こし" pending={transcribed === 0}>
          <div className={`ae-lane ${transcribed === 0 ? 'pending' : ''}`}>
            {transcribed > 0 && (
              <span
                className="ae-mark progress"
                style={{ left: 0, width: `${transcribed * 100}%` }}
              />
            )}
          </div>
        </FoundRow>
        <FoundRow
          label="笑い・歓声"
          pending={events !== 'done' && found.laugh.length + found.cheer.length === 0}
        >
          <div
            className={`ae-lane ${events !== 'done' && found.laugh.length + found.cheer.length === 0 ? 'pending' : ''}`}
          >
            {found.cheer.map((r, i) => (
              <span key={`c${i}`} className="ae-mark cheer" style={place(r, span)} />
            ))}
            {found.laugh.map((r, i) => (
              <span key={`l${i}`} className="ae-mark laugh" style={place(r, span)} />
            ))}
          </div>
        </FoundRow>
        <FoundRow label="場面" pending={scenes.length === 0}>
          <div className={`ae-lane ${scenes.length === 0 ? 'pending' : ''}`}>
            {scenes.map((sc) => (
              <span
                key={sc.id}
                className={`ae-mark scene ${keptOf(sc.id) ? 'kept' : 'dropped'}`}
                style={place(sc, span)}
              />
            ))}
          </div>
        </FoundRow>
      </div>
    </section>
  )
}

function FoundRow({
  label,
  pending,
  children
}: {
  label: string
  pending?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <span className={`ae-found-label ${pending ? 'pending' : ''}`}>{label}</span>
      {children}
    </>
  )
}

/** 場面の絵。見えたときに、その時刻を録っているカメラから 1 枚取る(取った絵は覚えておく) */
const thumbCache = new Map<string, Promise<string>>()

export function SceneThumb({
  project,
  at,
  dim
}: {
  project: Project
  at: number
  dim?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined')
  const source = frameSourceAt(project, at)
  const key = source ? `${source.filePath}|${source.at.toFixed(1)}` : null
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) setVisible(true)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || !key || !source) return
    let cancelled = false
    let p = thumbCache.get(key)
    if (!p) {
      p = window.api.generateThumbnail(source.filePath, source.at)
      p.catch(() => thumbCache.delete(key))
      thumbCache.set(key, p)
    }
    p.then(
      (u) => {
        if (!cancelled) setUrl(u)
      },
      () => {
        if (!cancelled) setUrl(null)
      }
    )
    return () => {
      cancelled = true
    }
    // source は key から決まる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key])
  return (
    <div ref={ref} className={`ae-thumb ${dim ? 'dim' : ''}`}>
      {url && <img src={url} alt="" draggable={false} />}
    </div>
  )
}

export function Chip({ chip }: { chip: SceneChip }): React.JSX.Element {
  return <span className={`ae-chip ${chip.tone} ${chip.manual ? 'manual' : ''}`}>{chip.label}</span>
}

/**
 * 構成の帯: 素材の全体の中で、残す場面(順に 4 色)・見どころ(琥珀の印)・落とす場面(縞)・選んだ場面。
 * 押すとその場面を選ぶ(一覧の行へ移る)。キーボードでは一覧の行で同じことができるので、帯は飾り扱い
 */
export function KeepBand({
  scenes,
  span,
  judgements,
  keptOf,
  selected,
  onSelect
}: {
  scenes: readonly Scene[]
  span: number
  judgements: readonly SceneJudgement[]
  keptOf: (id: string) => boolean
  selected: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  const order = keptOrder(scenes, keptOf)
  return (
    <div className="ae-band" aria-hidden="true">
      {scenes.map((sc) => {
        const n = order.get(sc.id)
        const kept = n !== null && n !== undefined
        const highlight = judgements.find((j) => j.sceneId === sc.id)?.kind === 'highlight'
        return (
          <span
            key={sc.id}
            className={`ae-band-seg ${kept ? 'kept' : 'dropped'} ${highlight ? 'highlight' : ''} ${selected === sc.id ? 'selected' : ''}`}
            style={{
              ...place(sc, span),
              ...(kept
                ? ({
                    '--seg': SCENE_BAND_COLORS[n % SCENE_BAND_COLORS.length]
                  } as React.CSSProperties)
                : {})
            }}
            onClick={() => onSelect(sc.id)}
          />
        )
      })}
    </div>
  )
}

/** 数値のカード(Graphite 3 の「表示・読む速さ・字数」と同じ作り)。値の無いカードは出さない */
export function MetricCard({
  label,
  value,
  unit,
  tone
}: {
  label: string
  value: string
  unit?: string
  tone: 'blue' | 'green' | 'amber' | 'violet'
}): React.JSX.Element {
  return (
    <div className={`ae-metric ${tone}`}>
      <span className="ae-metric-label">{label}</span>
      <span className="ae-metric-value tc">
        {value}
        {unit && <span className="ae-metric-unit"> {unit}</span>}
      </span>
    </div>
  )
}

/** 次にやること(大きな主ボタン 1 つ + 短い説明)。`lib/autoEditNext` が決める */
export function NextActionCard({
  action,
  onAction,
  disabled
}: {
  action: NextAction
  onAction: (id: NextActionId) => void
  /** 押せないボタン(工程の都合)。押せない理由は説明に書く */
  disabled?: (id: NextActionId) => boolean
}): React.JSX.Element {
  // 手で決めたものを捨てる操作は、押す前に確かめる
  const press = (b: NextActionButton): void => {
    if (b.confirm && !window.confirm(b.confirm)) return
    onAction(b.id)
  }
  return (
    <section className={`ae-next ${action.kind}`} aria-label="次にやること">
      <span className="ae-next-icon" aria-hidden="true">
        <NextIcon kind={action.kind} />
      </span>
      <div className="ae-next-body">
        <h2 className="ae-next-title">{action.title}</h2>
        <p className="ae-next-detail">{action.detail}</p>
      </div>
      <div className="ae-next-actions">
        <button
          type="button"
          className="primary-button ae-next-primary"
          disabled={disabled?.(action.primary.id)}
          onClick={() => press(action.primary)}
        >
          {action.primary.label}
        </button>
        {action.secondary.map((b) => (
          <button
            key={b.id}
            type="button"
            className={`small-button ae-next-secondary ${b.id === 'cancel' ? 'danger' : ''}`}
            disabled={disabled?.(b.id)}
            onClick={() => press(b)}
          >
            {b.label}
          </button>
        ))}
      </div>
    </section>
  )
}

function NextIcon({ kind }: { kind: NextAction['kind'] }): React.JSX.Element {
  const p = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  } as const
  switch (kind) {
    case 'done':
      return (
        <svg {...p}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      )
    case 'running':
      return (
        <svg {...p}>
          <path d="M12 3a9 9 0 1 1-9 9" />
        </svg>
      )
    case 'error':
      return (
        <svg {...p}>
          <path d="M12 8v5M12 16.5h.01" />
          <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      )
    case 'no-footage':
      return (
        <svg {...p}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 11v5M9.5 13.5h5" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <path d="M7 4.5v15l12.5-7.5z" />
        </svg>
      )
  }
}

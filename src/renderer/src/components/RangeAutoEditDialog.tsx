import { useEffect, useRef, useState } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { sameExceptAutoEdit, useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  DEFAULT_RANGED_OPTIONS,
  rangedEditBlockedReason,
  rangedVariantSpecs,
  variantScenes,
  type RangedEditOptions,
  type RangedEditSteps,
  type RangedPreview,
  type RangedVariantId,
  type StripPiece
} from '../lib/rangedAutoEdit'
import type { TimelineRange } from '@shared/roughCut/range'
import { formatTimecode } from '../lib/timelineRuler'
import type { RangeOrigin } from '../lib/timelineRange'
import { frameSeconds } from '@shared/frameRate'
import { useEscapeToClose } from '../lib/useEscapeToClose'
import { PlayIcon, WandIcon } from './icons'
import './rangeAutoEdit.css'
import { DialogHeader } from './DialogHeader'

const STEP_LABELS: [keyof RangedEditSteps, string, string][] = [
  ['cut', 'カット・間詰め', '切ると、今の残し方のまま(案は1つ)'],
  ['angles', 'アングル', '切ると、今のカメラのまま'],
  ['speech', '発言テロップ', ''],
  ['effects', '演出テロップ', '選んである提案を置き直します'],
  ['se', 'SE', '範囲の中に始まるもの'],
  ['cg', 'CG', '範囲の中に始まるもの'],
  ['bgm', 'BGM', '切ると、本編に付いていくだけ。入れると範囲の中を入れ直し、境で1秒フェード']
]

const sec = (s: number): string => `${s >= 0 ? '' : '−'}${Math.abs(s).toFixed(1)}秒`
const signed = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0')

/** 範囲の中の本編の小さな帯(前・後) */
function Strip({
  pieces,
  length,
  scale
}: {
  pieces: StripPiece[]
  length: number
  scale: number
}): React.JSX.Element {
  return (
    <div className="range-strip" style={{ width: `${Math.max(4, length * scale)}%` }}>
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`range-strip-piece ${p.kind}`}
          style={{
            left: `${(p.start / Math.max(1e-9, length)) * 100}%`,
            width: `${((p.end - p.start) / Math.max(1e-9, length)) * 100}%`
          }}
        />
      ))}
    </div>
  )
}

/** 当てる前と後の違い(選んだ案の中身) */
function Diff({
  preview,
  fps,
  keepLength
}: {
  preview: RangedPreview
  fps: number
  keepLength: boolean
}): React.JSX.Element {
  const sm = preview.summary
  const scale = 100 / Math.max(sm.lengthBefore, sm.lengthAfter, 1e-9)
  return (
    <div
      className="range-auto-edit-diff"
      aria-label={`案${preview.variant.id}の、当てる前と後の違い`}
    >
      <div className="range-strips">
        <span className="form-note">前</span>
        <Strip pieces={sm.stripBefore} length={sm.lengthBefore} scale={scale} />
        <span className="form-note">後</span>
        <Strip pieces={sm.stripAfter} length={sm.lengthAfter} scale={scale} />
      </div>
      {sm.lengthAfter > sm.lengthBefore * 1.5 + 5 && (
        <p className="range-auto-edit-grow" role="alert">
          落とした場面の所も作り直すため、範囲が {sec(sm.lengthBefore)} から {sec(sm.lengthAfter)}{' '}
          に伸びます(
          {keepLength ? '長さを保つ' : `後ろが ${sec(sm.lengthAfter - sm.lengthBefore)} 送られます`}
          )
        </p>
      )}
      <dl>
        <dt>範囲の長さ</dt>
        <dd>
          {sec(sm.lengthBefore)} → {sec(sm.lengthAfter)}({sec(sm.lengthAfter - sm.lengthBefore)})
        </dd>
        <dt>本編の長さ</dt>
        <dd>
          {formatTimecode(sm.totalBefore, fps)} → {formatTimecode(sm.totalAfter, fps)}
        </dd>
        <dt>カット</dt>
        <dd>
          {sm.cutsBefore} → {sm.cutsAfter} 本
        </dd>
        <dt>自動テロップ</dt>
        <dd>
          {sm.telopsBefore} → {sm.telopsAfter} 枚
        </dd>
        <dt>SE / BGM / CG</dt>
        <dd>
          {sm.se[0]}→{sm.se[1]} / {sm.bgm[0]}→{sm.bgm[1]} / {sm.cg[0]}→{sm.cg[1]}
        </dd>
      </dl>
      <ul className="range-auto-edit-notes">
        {sm.movedHand > 0 && (
          <li>範囲より後ろの手置き {sm.movedHand} 個(テロップ・音・画)も一緒に動きます</li>
        )}
        {sm.insideHand > 0 && (
          <li>範囲の中の手置き {sm.insideHand} 個はそのままの時刻に残ります</li>
        )}
        {sm.speedChanged > 0 && (
          <li className="warn">
            範囲の中の速さを変えたクリップ {sm.speedChanged} 本は、素材の速さに戻ります
          </li>
        )}
        {sm.outsideOverlap > 0 && (
          <li className="warn">
            範囲の外に、範囲の中と同じ時刻を映すクリップが {sm.outsideOverlap}{' '}
            本あります(同じ所が2回出ることがあります)
          </li>
        )}
        {sm.skipped.length > 0 && (
          <li>手で直した {sm.skipped.join('・')} のトラックは、範囲で置き直していません</li>
        )}
      </ul>
    </div>
  )
}

/** 案のカード(長さ・カット・テロップ・場面・前後の小さな帯・試しに見る) */
function VariantCard({
  preview,
  selected,
  trying,
  canTry,
  onSelect,
  onTry
}: {
  preview: RangedPreview
  selected: boolean
  trying: boolean
  canTry: boolean
  onSelect: () => void
  onTry: () => void
}): React.JSX.Element {
  const sm = preview.summary
  const v = preview.variant
  const scenes = variantScenes(preview)
  const scale = 100 / Math.max(sm.lengthBefore, sm.lengthAfter, 1e-9)
  return (
    <div
      className={`range-variant${selected ? ' selected' : ''}`}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="range-variant-head">
        <span className="range-variant-name">
          案{v.id} {v.label}
        </span>
        {trying && <span className="range-variant-badge">試しに当て中</span>}
      </div>
      <p className="range-variant-note">{v.note}</p>
      <dl className="range-variant-facts">
        <dt>長さ</dt>
        <dd>
          {sm.lengthBefore.toFixed(1)} → {sm.lengthAfter.toFixed(1)}秒
        </dd>
        <dt>カット</dt>
        <dd>
          {sm.cutsBefore} → {sm.cutsAfter}
        </dd>
        <dt>テロップ</dt>
        <dd>{signed(sm.telopsAfter - sm.telopsBefore)}</dd>
        <dt>場面</dt>
        <dd>
          残す {scenes.kept} / 落とす {scenes.dropped}
        </dd>
      </dl>
      <div className="range-strips range-variant-strips" aria-hidden="true">
        <span className="form-note">前</span>
        <Strip pieces={sm.stripBefore} length={sm.lengthBefore} scale={scale} />
        <span className="form-note">後</span>
        <Strip pieces={sm.stripAfter} length={sm.lengthAfter} scale={scale} />
      </div>
      {v.merged.length > 0 && (
        <p className="range-variant-note">
          「{v.merged.join('」「')}」もほぼ同じ中身なので、まとめました
        </p>
      )}
      <button
        type="button"
        className="small-button range-variant-try"
        disabled={!canTry}
        title={
          canTry
            ? '本編に試しに当て、範囲の頭から再生します(閉じると元に戻ります)'
            : '案を作り終えてから見られます'
        }
        onClick={(e) => {
          e.stopPropagation()
          onTry()
        }}
      >
        <PlayIcon width={12} height={12} />
        試しに見る
      </button>
    </div>
  )
}

/**
 * 選んだ範囲だけを自動で作り直すダイアログ。1. 作り直す(案を最大3つ、作れた順に出す)→
 * 2. 案を選ぶ(試しに見られる)→ 3. この案にする(取り消し1回で戻る)。選ばずに閉じれば何も変わらない
 * (試しに当てていれば戻す)。当てた後は、タイムラインの上の帯で前/後を見比べ、別の案に替えられる
 */
export function RangeAutoEditDialog({
  range,
  origin,
  onClose
}: {
  range: TimelineRange
  /** どこで決めた範囲か。イン点・アウト点なら境を寄せず、当てた後のイン点・アウト点も合わせる */
  origin?: RangeOrigin
  onClose: () => void
}): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const scenes = usePipelineStore((s) => s.scenes)
  const restored = usePipelineStore((s) => s.restored)
  const running = usePipelineStore((s) => s.running)
  const editPolicy = useSettingsStore((s) => s.editPolicy)
  const blocked = rangedEditBlockedReason(project, { scenes, restored, running })
  const [options, setOptions] = useState<RangedEditOptions>(DEFAULT_RANGED_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askRipple, setAskRipple] = useState(false)
  const [previews, setPreviews] = useState<RangedPreview[]>([])
  const [selected, setSelected] = useState<RangedVariantId | null>(null)
  /** 試しに当てている案(閉じると取り消す) */
  const [trial, setTrial] = useState<RangedVariantId | null>(null)
  const [showOptions, setShowOptions] = useState(true)
  const abortRef = useRef<{ aborted: boolean } | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const fps = 1 / frameSeconds(project.clips, project.assets)
  const specs = rangedVariantSpecs(editPolicy).filter((sp) => options.steps.cut || sp.id === 'A')

  // 閉じたら(画面から外れたら)作っている案を止める
  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.aborted = true
    },
    []
  )

  /** 試しに当てた案を取り消す(当てた後に別の編集をしていれば、そのまま) */
  const revertTrial = (): void => {
    if (!trial) return
    const st = useProjectStore.getState()
    const rv = usePipelineStore.getState().rangeReview
    st.setIsPlaying(false)
    if (rv && st.project.clips === rv.afterClips && sameExceptAutoEdit(st.project, rv.afterProject))
      st.undo()
    usePipelineStore.getState().closeRangeReview()
    setTrial(null)
  }
  const close = (): void => {
    if (abortRef.current) abortRef.current.aborted = true
    revertTrial()
    onClose()
  }
  useEscapeToClose(backdropRef, close)

  const change = (patch: Partial<RangedEditOptions>): void => {
    revertTrial()
    setOptions((o) => ({ ...o, ...patch }))
    setPreviews([])
    setSelected(null)
    setAskRipple(false)
  }
  const prepare = async (opts: RangedEditOptions): Promise<void> => {
    if (abortRef.current) abortRef.current.aborted = true
    const signal = { aborted: false }
    abortRef.current = signal
    setBusy(true)
    setError(null)
    setAskRipple(false)
    setPreviews([])
    setSelected(null)
    try {
      const r = await usePipelineStore.getState().prepareRangedVariants(range, opts, {
        exact: origin === 'marks',
        signal,
        onVariant: (list) => {
          if (signal.aborted) return
          setPreviews(list)
          setSelected((s) => s ?? list[0]?.variant.id ?? null)
          setShowOptions(false)
        }
      })
      if (signal.aborted) return
      if (r.ok) {
        setPreviews(r.previews)
        setSelected((s) => s ?? r.previews[0]?.variant.id ?? null)
        setShowOptions(false)
      } else {
        setPreviews([])
        setShowOptions(true)
        setError(r.reason)
        setAskRipple(Boolean(r.needsRipple))
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }

  /** 当てた後の範囲をルーラーに出す(前の範囲のままだと、ずれた所を指す) */
  const showNewRange = (p: RangedPreview): void => {
    const st = useProjectStore.getState()
    if (origin === 'marks') {
      st.setTimelineIn(null)
      st.setTimelineOut(p.newRange.end)
      st.setTimelineIn(p.newRange.start)
    } else st.setDragRange(p.newRange)
  }
  /** 案を本編に当てる(試しに当てていれば、取り消して替える。履歴は1件のまま) */
  const put = (p: RangedPreview): boolean => {
    const pipe = usePipelineStore.getState()
    const r = trial ? pipe.switchRangedVariant(p) : pipe.applyRangedEdit(p, previews)
    if (!r.ok) {
      if (!trial) {
        setPreviews([])
        setSelected(null)
        setShowOptions(true)
      }
      setError(r.reason ?? '当てられませんでした')
      return false
    }
    setError(null)
    showNewRange(p)
    return true
  }
  const tryOut = (p: RangedPreview): void => {
    setSelected(p.variant.id)
    if (trial !== p.variant.id && !put(p)) return
    setTrial(p.variant.id)
    const st = useProjectStore.getState()
    st.seekTo(Math.max(0, p.newRange.start - 1))
    st.setIsPlaying(true)
  }
  const choose = (): void => {
    const p = previews.find((x) => x.variant.id === selected)
    if (!p) return
    if (abortRef.current) abortRef.current.aborted = true
    if (trial !== p.variant.id && !put(p)) return
    useProjectStore.getState().setIsPlaying(false)
    onClose()
  }

  const chosen = previews.find((x) => x.variant.id === selected) ?? null
  const stage = previews.length === 0 ? 1 : 2
  const pending = busy
    ? specs.filter(
        (sp) => !previews.some((p) => p.variant.id === sp.id || p.variant.merged.includes(sp.label))
      )
    : []
  return (
    <div
      className={`modal-backdrop${trial ? ' range-trial' : ''}`}
      ref={backdropRef}
      onClick={() => !trial && close()}
    >
      <div
        className="range-auto-edit-dialog range-auto-edit"
        role="dialog"
        aria-modal="true"
        aria-label="この範囲を自動編集"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader
          title={
            <>
              <WandIcon width={16} height={16} />
              この範囲を自動編集
              <span className="range-auto-edit-span mono">
                {formatTimecode(range.start, fps)} 〜 {formatTimecode(range.end, fps)}
              </span>
            </>
          }
          closeTitle={
            busy ? '閉じると、作っている案を止めます' : '閉じる(選ばなければ何も変わりません)'
          }
          onClose={close}
        />
        <div className="range-auto-edit-body">
          {blocked ? (
            <p className="hint-text">{blocked}</p>
          ) : (
            <>
              <ol className="range-flow" aria-label="手順">
                <li className={stage === 1 ? 'current' : 'done'}>作り直す</li>
                <li className={stage === 2 ? 'current' : ''}>案を選ぶ</li>
                <li>この案にする</li>
              </ol>
              {showOptions && !trial ? (
                <>
                  <p className="form-note">
                    範囲の中だけを作り直し、性格の違う案(標準・詰める・残す)を並べます。範囲の外はそのまま。
                    {origin === 'marks'
                      ? 'イン点・アウト点の所をそのまま使います。'
                      : '境は近くの静かな所へ寄せます。'}
                  </p>
                  <fieldset className="range-auto-edit-steps">
                    <legend>やり直す工程</legend>
                    {STEP_LABELS.map(([key, label, note]) => (
                      <label key={key} title={note}>
                        <input
                          type="checkbox"
                          checked={options.steps[key]}
                          disabled={busy}
                          onChange={(e) =>
                            change({ steps: { ...options.steps, [key]: e.target.checked } })
                          }
                        />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="range-auto-edit-after">
                    <legend>範囲より後ろ</legend>
                    <label>
                      <input
                        type="radio"
                        name="range-after"
                        checked={!options.keepLength}
                        disabled={busy}
                        onChange={() => change({ keepLength: false })}
                      />
                      詰める・送る(リップル。後ろの声・テロップ・手で置いたものも一緒に動く)
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="range-after"
                        checked={options.keepLength}
                        disabled={busy}
                        onChange={() => change({ keepLength: true })}
                      />
                      範囲の長さを保つ(後ろは1フレームも動かさない)
                    </label>
                  </fieldset>
                  <label className="range-auto-edit-check">
                    <input
                      type="checkbox"
                      checked={options.keepInside}
                      disabled={busy}
                      onChange={(e) => change({ keepInside: e.target.checked })}
                    />
                    範囲の中の手直し(削った・足した所、替えたカメラ)を残す
                  </label>
                  <label className="range-auto-edit-check">
                    <input
                      type="checkbox"
                      checked={options.lockAfter}
                      disabled={busy}
                      onChange={(e) => change({ lockAfter: e.target.checked })}
                    />
                    終わったら、この範囲を自動編集で触らないようにする(ロック。手で編集はできます)
                  </label>
                </>
              ) : (
                <p className="form-note range-options-line">
                  やり直す工程:{' '}
                  {STEP_LABELS.filter(([k]) => options.steps[k])
                    .map(([, l]) => l)
                    .join('・') || 'なし'}
                  {options.keepLength ? '・長さを保つ' : ''}
                  {options.keepInside ? '・手直しを残す' : ''}
                  {options.lockAfter ? '・ロック' : ''}
                  {!trial && !busy && (
                    <button className="small-button" onClick={() => setShowOptions(true)}>
                      工程を変える
                    </button>
                  )}
                </p>
              )}
              {error && (
                <p className={askRipple ? 'hint-text' : 'error-text'} role="alert">
                  {error}
                  {askRipple && (
                    <button
                      className="small-button"
                      onClick={() => {
                        const next = { ...options, keepLength: false }
                        setOptions(next)
                        void prepare(next)
                      }}
                    >
                      詰める(リップル)で作り直す
                    </button>
                  )}
                </p>
              )}
              {(previews.length > 0 || pending.length > 0) && (
                <div className="range-variants" role="radiogroup" aria-label="作り直しの案">
                  {previews.map((p) => (
                    <VariantCard
                      key={p.variant.id}
                      preview={p}
                      selected={selected === p.variant.id}
                      trying={trial === p.variant.id}
                      canTry={!busy}
                      onSelect={() => setSelected(p.variant.id)}
                      onTry={() => tryOut(p)}
                    />
                  ))}
                  {pending.map((sp) => (
                    <div key={sp.id} className="range-variant pending" aria-busy="true">
                      <div className="range-variant-head">
                        <span className="range-variant-name">
                          案{sp.id} {sp.label}
                        </span>
                      </div>
                      <p className="range-variant-note">{sp.note}</p>
                      <p className="form-note">作っています…</p>
                    </div>
                  ))}
                </div>
              )}
              {previews.length === 1 && !busy && specs.length > 1 && (
                <p className="form-note">
                  範囲が短く、どの案もほぼ同じ中身になったので、1つにまとめました。
                </p>
              )}
              {chosen && !trial && (
                <Diff preview={chosen} fps={fps} keepLength={options.keepLength} />
              )}
            </>
          )}
        </div>
        <div className="dialog-footer">
          {trial && <span className="form-note">閉じると、試しに当てた案を取り消します</span>}
          <div className="dialog-footer-spacer" />
          <button className="small-button" onClick={close}>
            閉じる
          </button>
          {!blocked && previews.length === 0 && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void prepare(options)}
            >
              {busy ? '作っています…' : '作り直す'}
            </button>
          )}
          {!blocked && previews.length > 0 && (
            <button className="primary-button" disabled={!chosen} onClick={choose}>
              この案にする
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

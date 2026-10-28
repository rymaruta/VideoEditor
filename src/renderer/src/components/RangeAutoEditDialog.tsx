import { useEffect, useRef, useState } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { lockedTrackNames, useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  DEFAULT_RANGED_OPTIONS,
  growNote,
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
  const grow = growNote(preview, keepLength)
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
      {grow && <p className="range-auto-edit-grow">{grow}</p>}
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
  keepLength,
  onSelect,
  onTry
}: {
  preview: RangedPreview
  selected: boolean
  trying: boolean
  canTry: boolean
  keepLength: boolean
  onSelect: () => void
  onTry: () => void
}): React.JSX.Element {
  const sm = preview.summary
  const v = preview.variant
  const scenes = variantScenes(preview)
  const grow = growNote(preview, keepLength)
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
        {trying && <span className="range-variant-badge">試し中</span>}
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
          残す {scenes.before} → {scenes.kept}(全 {scenes.total})
        </dd>
      </dl>
      {grow && <p className="range-variant-grow">{grow}</p>}
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
  prefer,
  onClose
}: {
  range: TimelineRange
  /** どこで決めた範囲か。イン点・アウト点なら境を寄せず、当てた後のイン点・アウト点も合わせる */
  origin?: RangeOrigin
  /** 最初に選んでおく案(確認の画面の「残す」は案C「残す」)。省略は最初にできた案 */
  prefer?: RangedVariantId
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
  // 試しに当てている案。ローカルの印でなく、本編が今その案の後かで決める(ずれない)
  const inTrial = useProjectStore((s) => s.trial !== null)
  // 試している間にメニューなどから編集しようとして断った数(試し始めた時の数より増えたら知らせる)
  const refused = useProjectStore((s) => s.trialRefused)
  const [refusedBase, setRefusedBase] = useState(0)
  const review = usePipelineStore((s) => s.rangeReview)
  const trial: RangedVariantId | null =
    inTrial && review && project.clips === review.afterClips ? review.current : null
  const [showOptions, setShowOptions] = useState(true)
  const abortRef = useRef<{ aborted: boolean } | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const fps = 1 / frameSeconds(project.clips, project.assets)
  const specs = rangedVariantSpecs(editPolicy).filter((sp) => options.steps.cut || sp.id === 'A')
  /** 最初に選ぶ案: 頼まれた案(ほかの案にまとめられていればその案)、無ければ最初の案 */
  const firstPick = (list: readonly RangedPreview[]): RangedVariantId | null => {
    const label = prefer ? specs.find((sp) => sp.id === prefer)?.label : undefined
    const hit = prefer
      ? list.find(
          (p) =>
            p.variant.id === prefer || (label !== undefined && p.variant.merged.includes(label))
        )
      : undefined
    return hit?.variant.id ?? list[0]?.variant.id ?? null
  }

  // 閉じたら(画面から外れたら)作っている案を止め、試しに当てた案をやめる
  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.aborted = true
      usePipelineStore.getState().cancelRangedTrial()
    },
    []
  )

  /** 試しに当てた案をやめる(試す前の企画・履歴・記録に丸ごと戻る) */
  const revertTrial = (): void => usePipelineStore.getState().cancelRangedTrial()
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
    // 範囲の長さが変わると、固定したトラック(声・テロップ…)は動かないので後ろでずれる。
    // 長さを保つときは後ろが動かないので確かめない
    if (!opts.keepLength) {
      const names = lockedTrackNames(useProjectStore.getState().project).filter((n) => n !== '本編')
      if (
        names.length > 0 &&
        !confirm(
          `固定中のトラック(${names.join('・')})は動かないため、範囲より後ろで音やテロップがずれる場合があります。続けますか`
        )
      )
        return
    }
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
          setSelected((s) => s ?? firstPick(list))
          setShowOptions(false)
        }
      })
      if (signal.aborted) return
      if (r.ok) {
        setPreviews(r.previews)
        // 頼まれた案が後からできたなら、そちらへ選び直す(作れた順に出すので、最初は案A)
        setSelected((s) =>
          prefer && s !== prefer ? firstPick(r.previews) : (s ?? firstPick(r.previews))
        )
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
  const failed = (reason: string | undefined): void => {
    setPreviews([])
    setSelected(null)
    setShowOptions(true)
    setError(reason ?? '当てられませんでした')
  }
  /** 試しに当てる(履歴に積まない。別の案なら、試す前に戻してから当てる)。範囲の頭から再生する */
  const tryOut = (p: RangedPreview): void => {
    setSelected(p.variant.id)
    if (!inTrial) setRefusedBase(useProjectStore.getState().trialRefused)
    if (trial !== p.variant.id) {
      const r = usePipelineStore.getState().tryRangedVariant(p, previews)
      if (!r.ok) return failed(r.reason)
      setError(null)
      showNewRange(p)
    }
    const st = useProjectStore.getState()
    st.seekTo(Math.max(0, p.newRange.start - 1))
    st.setIsPlaying(true)
  }
  /** この案にする(履歴は1件。取り消し1回で当てる前に戻る) */
  const choose = (): void => {
    const p = previews.find((x) => x.variant.id === selected)
    if (!p) return
    if (abortRef.current) abortRef.current.aborted = true
    useProjectStore.getState().setIsPlaying(false)
    const showing = trial === p.variant.id
    const r = usePipelineStore.getState().commitRangedVariant(p, previews)
    if (!r.ok) return failed(r.reason)
    if (!showing) showNewRange(p)
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
      className={`modal-backdrop${inTrial ? ' range-trial' : ''}`}
      ref={backdropRef}
      onClick={() => !inTrial && close()}
    >
      <div
        className="range-auto-edit-dialog range-auto-edit"
        role="dialog"
        aria-modal="true"
        aria-label="この範囲を再編集"
        onClick={(e) => e.stopPropagation()}
      >
        <DialogHeader
          title={
            <>
              <WandIcon width={16} height={16} />
              この範囲を再編集
              <span className="range-auto-edit-span mono">
                {formatTimecode(range.start, fps)} – {formatTimecode(range.end, fps)}
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
              {showOptions && !inTrial ? (
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
                  {!inTrial && !busy && (
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
                      keepLength={options.keepLength}
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
                  {previews[0].variant.merged.length === specs.length - 1
                    ? 'どの案もほぼ同じ中身になったので、1つにまとめました。'
                    : 'ほかの案は、この範囲では作れないか、ほぼ同じ中身になりました。'}
                </p>
              )}
              {chosen && !inTrial && (
                <Diff preview={chosen} fps={fps} keepLength={options.keepLength} />
              )}
            </>
          )}
        </div>
        <div className="dialog-footer">
          {inTrial && (
            <span className="form-note" role="status">
              {refused > refusedBase
                ? '試している間は編集できません。この案にするか、閉じてから編集してください'
                : trial
                  ? '試している間は編集・取り消しはできません。閉じると試す前に戻ります'
                  : '試していた案が本編から外れました。閉じると試す前に戻ります'}
            </span>
          )}
          <div className="dialog-footer-spacer" />
          <button type="button" className="ve-export-button" onClick={close}>
            閉じる
          </button>
          {!blocked && previews.length === 0 && (
            <button
              type="button"
              className="ve-export-button primary"
              disabled={busy}
              onClick={() => void prepare(options)}
            >
              {busy ? '作っています…' : '作り直す'}
            </button>
          )}
          {!blocked && previews.length > 0 && (
            <button
              type="button"
              className="ve-export-button primary"
              disabled={!chosen}
              onClick={choose}
            >
              この案にする
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

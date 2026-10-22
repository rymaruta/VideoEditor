import { useRef, useState } from 'react'
import { usePipelineStore } from '../store/pipelineStore'
import { useProjectStore } from '../store/projectStore'
import {
  DEFAULT_RANGED_OPTIONS,
  rangedEditBlockedReason,
  type RangedEditOptions,
  type RangedEditSteps,
  type RangedPreview,
  type StripPiece
} from '../lib/rangedAutoEdit'
import type { TimelineRange } from '@shared/roughCut/range'
import { formatTimecode } from '../lib/timelineRuler'
import type { RangeOrigin } from '../lib/timelineRange'
import { frameSeconds } from '@shared/frameRate'
import { useEscapeToClose } from '../lib/useEscapeToClose'
import { WandIcon } from './icons'
import './rangeAutoEdit.css'

const STEP_LABELS: [keyof RangedEditSteps, string, string][] = [
  ['cut', 'カット・間詰め', '切ると、今の残し方のまま'],
  ['angles', 'アングル', '切ると、今のカメラのまま'],
  ['speech', '発言テロップ', ''],
  ['effects', '演出テロップ', '選んである提案を置き直します'],
  ['se', 'SE', '範囲の中に始まるもの'],
  ['cg', 'CG', '範囲の中に始まるもの'],
  ['bgm', 'BGM', '切ると、本編に付いていくだけ。入れると範囲の中を入れ直し、境で1秒フェード']
]

const sec = (s: number): string => `${s >= 0 ? '' : '−'}${Math.abs(s).toFixed(1)}秒`

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

/**
 * 選んだ範囲だけを自動で作り直すダイアログ。工程を選び → 用意(企画には当てない)→ 違いを確かめて当てる。
 * 当てたら取り消し1回で戻る(当てた後は、タイムラインの上の帯で前/後を見比べられる)
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
  const blocked = rangedEditBlockedReason(project, { scenes, restored, running })
  const [options, setOptions] = useState<RangedEditOptions>(DEFAULT_RANGED_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askRipple, setAskRipple] = useState(false)
  const [preview, setPreview] = useState<RangedPreview | null>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeToClose(backdropRef, onClose, !busy)
  const fps = 1 / frameSeconds(project.clips, project.assets)

  const change = (patch: Partial<RangedEditOptions>): void => {
    setOptions((o) => ({ ...o, ...patch }))
    setPreview(null)
    setAskRipple(false)
  }
  const prepare = async (opts: RangedEditOptions): Promise<void> => {
    setBusy(true)
    setError(null)
    setAskRipple(false)
    try {
      const r = await usePipelineStore
        .getState()
        .prepareRangedEdit(range, opts, { exact: origin === 'marks' })
      if (r.ok) setPreview(r.preview)
      else {
        setPreview(null)
        setError(r.reason)
        setAskRipple(Boolean(r.needsRipple))
      }
    } finally {
      setBusy(false)
    }
  }
  const apply = (): void => {
    if (!preview) return
    const r = usePipelineStore.getState().applyRangedEdit(preview)
    if (!r.ok) {
      setPreview(null)
      setError(r.reason ?? '当てられませんでした')
      return
    }
    // 当てた後の範囲をルーラーに出す(前の範囲のままだと、ずれた所を指す)
    const st = useProjectStore.getState()
    if (origin === 'marks') {
      st.setTimelineIn(null)
      st.setTimelineOut(preview.newRange.end)
      st.setTimelineIn(preview.newRange.start)
    } else st.setDragRange(preview.newRange)
    onClose()
  }

  const sm = preview?.summary
  const scale = sm ? 100 / Math.max(sm.lengthBefore, sm.lengthAfter, 1e-9) : 0
  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={() => !busy && onClose()}>
      <div
        className="modal range-auto-edit"
        role="dialog"
        aria-label="この範囲を自動編集"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>
          <WandIcon width={15} height={15} />
          この範囲を自動編集
          <span className="range-auto-edit-span mono">
            {formatTimecode(range.start, fps)} 〜 {formatTimecode(range.end, fps)}
          </span>
        </h3>
        {blocked ? (
          <p className="hint-text">{blocked}</p>
        ) : (
          <>
            <p className="form-note">
              範囲の中だけを、自動編集と同じやり方で作り直します。範囲の外の本編はそのままです。
              範囲の中の手直し(削った・足した所、替えたカメラ)は、下の「手直しを残す」を入れない限り
              自動の結果に置き換わります。
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
                  onChange={() => change({ keepLength: false })}
                />
                詰める・送る(リップル。後ろの声・テロップ・手で置いたものも一緒に動く)
              </label>
              <label>
                <input
                  type="radio"
                  name="range-after"
                  checked={options.keepLength}
                  onChange={() => change({ keepLength: true })}
                />
                範囲の長さを保つ(後ろは1フレームも動かさない)
              </label>
            </fieldset>
            <label className="range-auto-edit-check">
              <input
                type="checkbox"
                checked={options.keepInside}
                onChange={(e) => change({ keepInside: e.target.checked })}
              />
              範囲の中の手直し(削った・足した所、替えたカメラ)を残す
            </label>
            <label className="range-auto-edit-check">
              <input
                type="checkbox"
                checked={options.lockAfter}
                onChange={(e) => change({ lockAfter: e.target.checked })}
              />
              終わったら、この範囲を自動編集で触らないようにする(ロック。手で編集はできます)
            </label>
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
                    詰める(リップル)で用意する
                  </button>
                )}
              </p>
            )}
            {sm && (
              <div className="range-auto-edit-diff" aria-label="当てる前と後の違い">
                <div className="range-strips">
                  <span className="form-note">前</span>
                  <Strip pieces={sm.stripBefore} length={sm.lengthBefore} scale={scale} />
                  <span className="form-note">後</span>
                  <Strip pieces={sm.stripAfter} length={sm.lengthAfter} scale={scale} />
                </div>
                {sm.lengthAfter > sm.lengthBefore * 1.5 + 5 && (
                  <p className="range-auto-edit-grow" role="alert">
                    落とした場面の所も作り直すため、範囲が {sec(sm.lengthBefore)} から{' '}
                    {sec(sm.lengthAfter)} に伸びます(
                    {options.keepLength
                      ? '長さを保つ'
                      : `後ろが ${sec(sm.lengthAfter - sm.lengthBefore)} 送られます`}
                    )
                  </p>
                )}
                <dl>
                  <dt>範囲の長さ</dt>
                  <dd>
                    {sec(sm.lengthBefore)} → {sec(sm.lengthAfter)}(
                    {sec(sm.lengthAfter - sm.lengthBefore)})
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
                    <li>
                      範囲より後ろの手置き {sm.movedHand} 個(テロップ・音・画)も一緒に動きます
                    </li>
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
                    <li>
                      手で直した {sm.skipped.join('・')} のトラックは、範囲で置き直していません
                    </li>
                  )}
                </ul>
              </div>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            閉じる
          </button>
          {!blocked && !preview && (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void prepare(options)}
            >
              {busy ? '用意しています…' : '用意する(まだ当てません)'}
            </button>
          )}
          {!blocked && preview && (
            <button className="primary-button" onClick={apply}>
              当てる(取り消しは Ctrl+Z 1回)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

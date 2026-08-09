import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { formatIpcError } from '../lib/ipcError'
import {
  BEAT_SNAP_TOLERANCE,
  MIN_CUT_SECONDS,
  PACE_PROFILES,
  ScanCache,
  ShortPace,
  ScannedWindow,
  ShortPlan,
  canReuseScan,
  foldedOutputLength,
  planShortFromWindows,
  snapCutsToBeat,
  tightenSegmentEdges
} from '../lib/longFormShort'
import { WandIcon, SparklesIcon } from './icons'
import type { TextOverlay, TransitionType } from '@shared/types'

// How many windows are shortlisted from the audio scan. Every one of these costs a
// transcription pass, so this is the main lever on how long the whole run takes:
// ~24 windows of ≤22s is a few minutes of audio to transcribe, regardless of whether
// the source is 10 minutes or 3 hours.
const MAX_WINDOWS = 24
const TARGET_OPTIONS = [20, 30, 45, 60]
const PACE_OPTIONS: ShortPace[] = ['fast', 'normal', 'relaxed']
// Deliberately short. A long dissolve between two highlight cuts reads as amateur
// footage, which is the exact problem this feature exists to fix.
const TRANSITION_SECONDS = 0.3
// Only the types the export pipeline already renders (xfade). Anything else would look
// right in this dropdown and silently come out as a hard cut in the exported file.
const TRANSITION_OPTIONS: { value: TransitionType; label: string }[] = [
  { value: 'none', label: 'カット(推奨)' },
  { value: 'crossfade', label: 'クロスフェード' },
  { value: 'fade', label: 'フェード(黒)' }
]

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

type Stage = 'idle' | 'scanning' | 'transcribing' | 'planning' | 'tightening' | 'done'

/** 詰め・ビート寄せまで済ませた、実際にタイムラインへ置く区間 */
interface PreparedCut {
  start: number
  end: number
  maxEnd: number
  role: string
  reason: string
  headTrimmed: number
  tailTrimmed: number
  beatSnapped: boolean
}

export function LongFormShortModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const assets = useProjectStore((s) => s.project.assets)
  const clips = useProjectStore((s) => s.project.clips)
  const beatGrid = useProjectStore((s) => s.project.beatGrid)
  const applyShortPlan = useProjectStore((s) => s.applyShortPlan)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)
  // 編集方針は毎回書き直したくないので設定として残す(次回起動時も引き継がれる)
  const note = useSettingsStore((s) => s.shortNote)
  const setNote = useSettingsStore((s) => s.setShortNote)

  const videoAssets = assets.filter((a) => a.hasVideo).sort((a, b) => b.duration - a.duration)
  const [assetId, setAssetId] = useState(videoAssets[0]?.id ?? '')
  const [target, setTarget] = useState(30)
  const [refineNote, setRefineNote] = useState('')
  const [scanCache, setScanCache] = useState<ScanCache | null>(null)
  const [addHook, setAddHook] = useState(true)
  const [pace, setPace] = useState<ShortPace>('normal')
  const [tighten, setTighten] = useState(true)
  const [transition, setTransition] = useState<TransitionType>('none')
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<ShortPlan | null>(null)
  const [cuts, setCuts] = useState<PreparedCut[]>([])

  const asset = videoAssets.find((a) => a.id === assetId)
  const running = stage !== 'idle' && stage !== 'done'
  // The new material is appended, so it starts where the existing timeline ended.
  const existingLength = clips.reduce(
    (sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1),
    0
  )

  async function handleRun(): Promise<void> {
    if (!asset) return
    if (!geminiApiKey) {
      setError('Gemini API キーを入力してください(ゲームトレンドタブで設定できます)')
      return
    }
    setError(null)
    // 追加指示があるときだけ、前回の構成案を土台としてAIへ渡す。
    const previousPlan = plan
    setPlan(null)
    setCuts([])
    try {
      let scanned: ScannedWindow[]
      if (canReuseScan(scanCache, asset)) {
        // 作り直しのたびに全編スキャンと文字起こしをやり直すと、長尺では数分〜数十分
        // 待たされる。候補区間は素材だけで決まるので、同じ素材なら使い回す。
        scanned = scanCache!.windows
      } else {
        setStage('scanning')
        const windows = await window.api.scanLongFormWindows(
          asset.filePath,
          asset.duration,
          MAX_WINDOWS
        )
        if (windows.length === 0) {
          throw new Error(
            '盛り上がっている箇所を見つけられませんでした。音声が無いか、音量が一定の動画の可能性があります。'
          )
        }

        setStage('transcribing')
        setProgress({ done: 0, total: windows.length })
        scanned = []
        for (const [i, w] of windows.entries()) {
          let transcript = ''
          try {
            const segments = await window.api.transcribe(asset.filePath, w.start, w.end, 'ja')
            transcript = segments.map((s) => s.text).join(' ')
          } catch {
            // A window that fails to transcribe is still a usable candidate — its
            // loudness score alone can carry it. Losing the whole run over one
            // failed window would be far worse.
            transcript = ''
          }
          scanned.push({ ...w, transcript })
          setProgress({ done: i + 1, total: windows.length })
        }
        setScanCache({ assetId: asset.id, filePath: asset.filePath, windows: scanned })
      }

      setStage('planning')
      const result = await planShortFromWindows(
        geminiApiKey,
        scanned,
        target,
        note,
        asset.duration,
        pace,
        previousPlan && refineNote.trim() ? { previousPlan, instruction: refineNote } : undefined
      )

      setStage('tightening')
      setProgress({ done: 0, total: result.segments.length })
      const prepared: PreparedCut[] = []
      for (const [i, seg] of result.segments.entries()) {
        let trimmed = { start: seg.start, end: seg.end, headTrimmed: 0, tailTrimmed: 0 }
        if (tighten) {
          try {
            const silences = await window.api.detectSilence(asset.filePath, seg.start, seg.end)
            trimmed = tightenSegmentEdges(seg, silences, pace)
          } catch {
            // One segment whose silence scan fails is still perfectly usable untrimmed.
            // Losing a run that already cost a scan, N transcriptions and an LLM call
            // over a single ffmpeg failure would be far worse.
          }
        }
        prepared.push({
          ...trimmed,
          maxEnd: seg.end,
          role: seg.role,
          reason: seg.reason,
          beatSnapped: false
        })
        setProgress({ done: i + 1, total: result.segments.length })
      }

      const snapped =
        beatGrid && beatGrid.enabled && beatGrid.bpm > 0
          ? snapCutsToBeat(
              prepared,
              existingLength,
              beatGrid,
              BEAT_SNAP_TOLERANCE,
              MIN_CUT_SECONDS
            ).map((c, i) => ({ ...c, beatSnapped: c.end !== prepared[i].end }))
          : prepared

      setPlan(result)
      setCuts(snapped)
      setStage('done')
    } catch (e) {
      setError(formatIpcError(e))
      setStage('idle')
    }
  }

  function handleApply(): void {
    if (!plan || !asset || cuts.length === 0) return
    const picks = cuts.map((c, i) => ({
      assetId: asset.id,
      start: c.start,
      end: c.end,
      transitionIn:
        i === 0 || transition === 'none'
          ? undefined
          : { type: transition, duration: TRANSITION_SECONDS }
    }))
    const overlays: Omit<TextOverlay, 'id'>[] = []
    if (addHook && plan.hookLine.trim()) {
      const firstSegment = cuts[0].end - cuts[0].start
      overlays.push({
        text: plan.hookLine,
        startTime: existingLength,
        endTime: existingLength + Math.min(2.5, firstSegment),
        source: 'auto',
        style: {
          fontFamily: 'M PLUS Rounded 1c',
          fontSize: 64,
          color: '#ffffff',
          position: 'center',
          rotation: 0,
          bold: true,
          italic: false,
          outline: true,
          outlineColor: '#000000',
          outlineWidth: 6,
          shadow: true,
          background: false,
          backgroundColor: '#000000',
          backgroundOpacity: 0.5,
          letterSpacing: 0,
          animation: 'none',
          wordHighlight: false,
          highlightColor: '#ffd400'
        }
      })
    }
    applyShortPlan(picks, overlays)
    onClose()
  }

  const cutDurations = cuts.map((c) => c.end - c.start)
  const timelineLength = cutDurations.reduce((sum, d) => sum + d, 0)
  // What the exported file will actually be: transitions overlap their two clips.
  const outputLength =
    foldedOutputLength(
      cutDurations,
      transition === 'none' ? 0 : TRANSITION_SECONDS,
      existingLength
    ) - existingLength
  const trimmedTotal = cuts.reduce((sum, c) => sum + c.headTrimmed + c.tailTrimmed, 0)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal long-form-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <WandIcon width={15} height={15} />
          長尺動画からショートを自動生成
        </h3>
        <p className="hint-text">
          動画全体の音声を解析して盛り上がっている箇所を探し、その部分だけを文字起こししてAIが構成を決めます。映像の解析はしないので、長い動画でも現実的な時間で終わります。
        </p>

        {videoAssets.length === 0 ? (
          <p className="hint-text">先に動画素材を取り込んでください。</p>
        ) : (
          <>
            <div className="trim-field">
              <label>元にする動画</label>
              <select
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
                disabled={running}
              >
                {videoAssets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fileName}({formatClock(a.duration)})
                  </option>
                ))}
              </select>
            </div>

            <div className="trim-field">
              <label>目標の長さ</label>
              <div className="long-form-targets">
                {TARGET_OPTIONS.map((t) => (
                  <button
                    key={t}
                    className={`small-button ${target === t ? 'active' : ''}`}
                    onClick={() => setTarget(t)}
                    disabled={running}
                  >
                    {t}秒
                  </button>
                ))}
              </div>
            </div>

            <div className="trim-field">
              <label>テンポ</label>
              <div className="long-form-targets">
                {PACE_OPTIONS.map((p) => (
                  <button
                    key={p}
                    className={`small-button ${pace === p ? 'active' : ''}`}
                    onClick={() => setPace(p)}
                    disabled={running}
                    title={`${PACE_PROFILES[p].minSegments}〜${PACE_PROFILES[p].maxSegments}区間 / 1区間 ${PACE_PROFILES[p].minSeconds}〜${PACE_PROFILES[p].maxSeconds}秒`}
                  >
                    {PACE_PROFILES[p].label}
                  </button>
                ))}
              </div>
            </div>

            <div className="trim-field">
              <label>区間のつなぎ</label>
              <select
                value={transition}
                onChange={(e) => setTransition(e.target.value as TransitionType)}
                disabled={running}
              >
                {TRANSITION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="trim-field">
              <label>どんなショートにしたいか(任意)</label>
              <textarea
                className="long-form-note"
                rows={4}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={running}
                placeholder={
                  '例: 一番笑えるところだけ\n初見が驚く場面を中心に\n専門用語の説明は入れない'
                }
              />
              <p className="hint-text">ここに書いた方針は保存され、次回起動時も残ります。</p>
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={tighten}
                onChange={(e) => setTighten(e.target.checked)}
                disabled={running}
              />
              区間の頭とお尻の無音を詰める
            </label>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={addHook}
                onChange={(e) => setAddHook(e.target.checked)}
                disabled={running}
              />
              冒頭にフックのテロップを自動で入れる
            </label>

            {plan && (
              <>
                <div className="trim-field">
                  <label>この構成案への追加指示(任意)</label>
                  <textarea
                    className="long-form-note"
                    rows={3}
                    value={refineNote}
                    onChange={(e) => setRefineNote(e.target.value)}
                    disabled={running}
                    placeholder={'例: 1つ目はそのまま残して、あとをもっと短く\nオチをもう1つ足して'}
                  />
                  <p className="hint-text">
                    書いて「追加指示で作り直す」を押すと、いまの構成案を土台にAIが直します。空のまま押すと同じ条件で作り直します。文字起こしはやり直しません。
                  </p>
                </div>
                <p className="hint-text">
                  テンポと無音詰めの変更も「作り直す」で反映されます(つなぎはそのまま反映されます)。
                </p>
              </>
            )}

            {running && (
              <div className="long-form-progress">
                {stage === 'scanning' && <p>音声を解析して候補を探しています...</p>}
                {stage === 'transcribing' && (
                  <>
                    <p>
                      候補区間を文字起こし中 {progress.done} / {progress.total}
                    </p>
                    <div className="media-proxy-bar">
                      <div
                        className="media-proxy-bar-fill"
                        style={{
                          width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`
                        }}
                      />
                    </div>
                  </>
                )}
                {stage === 'planning' && <p>AIが構成を決めています...</p>}
                {stage === 'tightening' && (
                  <p>
                    区間の無音を詰めています {progress.done} / {progress.total}
                  </p>
                )}
              </div>
            )}

            {error && <p className="error-text">{error}</p>}

            {plan && (
              <div className="long-form-plan">
                <h4>{plan.title || '構成案'}</h4>
                {plan.hookLine && <p className="long-form-hook">冒頭テロップ: {plan.hookLine}</p>}
                <p className="hint-text">
                  {cuts.length}個の区間 ・ 書き出し尺 {outputLength.toFixed(1)}秒(目標 {target}秒)
                  {transition !== 'none' &&
                    ` ・ つなぎで ${(timelineLength - outputLength).toFixed(1)}秒ぶん重なります`}
                  {trimmedTotal > 0.05 && ` ・ 無音を ${trimmedTotal.toFixed(1)}秒詰めました`}
                </p>
                <ol className="long-form-segments">
                  {cuts.map((c, i) => (
                    <li key={i}>
                      <span className="game-trend-hook-badge">{c.role || '本編'}</span>
                      <span className="long-form-time">
                        {formatClock(c.start)}〜{formatClock(c.end)}({(c.end - c.start).toFixed(1)}
                        秒)
                      </span>
                      {c.headTrimmed + c.tailTrimmed > 0.05 && (
                        <span className="hint-text">
                          {' '}
                          頭 -{c.headTrimmed.toFixed(1)}秒 / 尻 -{c.tailTrimmed.toFixed(1)}秒
                        </span>
                      )}
                      {c.beatSnapped && <span className="hint-text"> ビートに合わせました</span>}
                      <p className="hint-text">{c.reason}</p>
                    </li>
                  ))}
                </ol>
                {plan.caption && <p className="hint-text">説明文案: {plan.caption}</p>}
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose} disabled={running}>
            閉じる
          </button>
          {plan ? (
            <>
              <button onClick={handleRun} disabled={running}>
                {refineNote.trim() ? '追加指示で作り直す' : '作り直す'}
              </button>
              <button className="primary-button" onClick={handleApply}>
                タイムラインに追加
              </button>
            </>
          ) : (
            <button
              className="primary-button"
              onClick={handleRun}
              disabled={running || !asset || videoAssets.length === 0}
            >
              <SparklesIcon width={13} height={13} />
              {running ? '処理中...' : 'ショートを作る'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

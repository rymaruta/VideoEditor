import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { formatIpcError } from '../lib/ipcError'
import { planShortFromWindows, ScannedWindow, ShortPlan } from '../lib/longFormShort'
import { WandIcon, SparklesIcon } from './icons'
import type { TextOverlay } from '@shared/types'

// How many windows are shortlisted from the audio scan. Every one of these costs a
// transcription pass, so this is the main lever on how long the whole run takes:
// ~24 windows of ≤22s is a few minutes of audio to transcribe, regardless of whether
// the source is 10 minutes or 3 hours.
const MAX_WINDOWS = 24
const TARGET_OPTIONS = [20, 30, 45, 60]

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

type Stage = 'idle' | 'scanning' | 'transcribing' | 'planning' | 'done'

export function LongFormShortModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const assets = useProjectStore((s) => s.project.assets)
  const applyShortPlan = useProjectStore((s) => s.applyShortPlan)
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey)

  const videoAssets = assets.filter((a) => a.hasVideo).sort((a, b) => b.duration - a.duration)
  const [assetId, setAssetId] = useState(videoAssets[0]?.id ?? '')
  const [target, setTarget] = useState(30)
  const [note, setNote] = useState('')
  const [addHook, setAddHook] = useState(true)
  const [stage, setStage] = useState<Stage>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<ShortPlan | null>(null)

  const asset = videoAssets.find((a) => a.id === assetId)
  const running = stage !== 'idle' && stage !== 'done'

  async function handleRun(): Promise<void> {
    if (!asset) return
    if (!geminiApiKey) {
      setError('Gemini API キーを入力してください(ゲームトレンドタブで設定できます)')
      return
    }
    setError(null)
    setPlan(null)
    try {
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
      const scanned: ScannedWindow[] = []
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

      setStage('planning')
      const result = await planShortFromWindows(geminiApiKey, scanned, target, note, asset.duration)
      setPlan(result)
      setStage('done')
    } catch (e) {
      setError(formatIpcError(e))
      setStage('idle')
    }
  }

  function handleApply(): void {
    if (!plan || !asset) return
    const picks = plan.segments.map((s) => ({ assetId: asset.id, start: s.start, end: s.end }))
    const overlays: Omit<TextOverlay, 'id'>[] = []
    if (addHook && plan.hookLine.trim()) {
      // The new material is appended, so it starts where the existing timeline ended.
      const existingLength = useProjectStore
        .getState()
        .project.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1), 0)
      const firstSegment = plan.segments[0].end - plan.segments[0].start
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

  const planLength = plan?.segments.reduce((sum, s) => sum + (s.end - s.start), 0) ?? 0

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
              <label>どんなショートにしたいか(任意)</label>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={running}
                placeholder="例: 一番笑えるところだけ / 初見が驚く場面を中心に"
              />
            </div>

            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={addHook}
                onChange={(e) => setAddHook(e.target.checked)}
                disabled={running}
              />
              冒頭にフックのテロップを自動で入れる
            </label>

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
              </div>
            )}

            {error && <p className="error-text">{error}</p>}

            {plan && (
              <div className="long-form-plan">
                <h4>{plan.title || '構成案'}</h4>
                {plan.hookLine && <p className="long-form-hook">冒頭テロップ: {plan.hookLine}</p>}
                <p className="hint-text">
                  {plan.segments.length}個の区間 ・ 合計 {planLength.toFixed(1)}秒(目標 {target}秒)
                </p>
                <ol className="long-form-segments">
                  {plan.segments.map((s, i) => (
                    <li key={i}>
                      <span className="game-trend-hook-badge">{s.role || '本編'}</span>
                      <span className="long-form-time">
                        {formatClock(s.start)}〜{formatClock(s.end)}({(s.end - s.start).toFixed(1)}
                        秒)
                      </span>
                      <p className="hint-text">{s.reason}</p>
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
                作り直す
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

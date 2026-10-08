import { useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import type { HighlightCandidate, HighlightSensitivity } from '@shared/types'
import { DEFAULT_HIGHLIGHT_SENSITIVITY, HIGHLIGHT_SENSITIVITY_OPTIONS } from '@shared/highlight'
import { TargetIcon, PlusIcon } from './icons'
import { useEscapeToClose } from '../lib/useEscapeToClose'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function HighlightModal({
  assetId,
  onClose
}: {
  assetId: string
  onClose: () => void
}): React.JSX.Element | null {
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeToClose(backdropRef, onClose)
  const asset = useProjectStore((s) => s.project.assets.find((a) => a.id === assetId))
  const addTrimmedClipToTimeline = useProjectStore((s) => s.addTrimmedClipToTimeline)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<HighlightCandidate[]>([])
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [sensitivity, setSensitivity] = useState<HighlightSensitivity>(
    DEFAULT_HIGHLIGHT_SENSITIVITY
  )

  // 感度を変えたら必ず測り直す。前の結果を残すと、いまの感度で出したものと
  // 取り違えたまま「タイムラインに追加」できてしまう。
  useEffect(() => {
    if (!asset) return
    // Kicks off an async IPC call (scene/audio analysis) — an external system fetch, not
    // state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    setCandidates([])
    setAdded(new Set())
    window.api
      .detectHighlights(asset.filePath, asset.duration, sensitivity)
      .then(setCandidates)
      .catch((e) => setError(formatIpcError(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, sensitivity])

  if (!asset) return null

  const maxScore = Math.max(1, ...candidates.map((c) => c.score))

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <TargetIcon width={15} height={15} />
          ハイライト検出: {asset.fileName}
        </h3>
        <div className="highlight-sensitivity-row">
          <label className="inline-select">
            検出の感度
            <select
              value={sensitivity}
              disabled={loading}
              onChange={(e) => setSensitivity(e.target.value as HighlightSensitivity)}
            >
              {HIGHLIGHT_SENSITIVITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading && (
          <p className="hint-text">
            シーンチェンジと音量の変化を解析中...(素材の長さによっては数十秒かかる場合があります)
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && candidates.length === 0 && (
          <p className="hint-text">
            目立ったハイライトを検出できませんでした。感度を「多く拾う」にすると、
            音量の起伏が小さい素材や、逆に起伏が大きすぎる素材でも見つかることがあります。
          </p>
        )}
        {!loading && candidates.length > 0 && (
          <div className="highlight-list">
            {candidates.map((c, i) => (
              <div key={i} className="highlight-item">
                <div className="highlight-item-info">
                  <span className="highlight-item-time">
                    {formatTime(c.start)} 〜 {formatTime(c.end)}
                  </span>
                  <div className="highlight-score-bar">
                    <div
                      className="highlight-score-fill"
                      style={{ width: `${(c.score / maxScore) * 100}%` }}
                    />
                  </div>
                  <span className="hint-text">
                    {c.hasSceneChange && 'カット '}
                    {c.hasAudioPeak && '音量変化'}
                  </span>
                </div>
                <button
                  className="small-button"
                  disabled={added.has(i)}
                  onClick={() => {
                    addTrimmedClipToTimeline(assetId, c.start, c.end)
                    setAdded((prev) => new Set(prev).add(i))
                  }}
                >
                  <PlusIcon width={12} height={12} />
                  {added.has(i) ? '追加済み' : 'タイムラインに追加'}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { formatIpcError } from '../lib/ipcError'
import type { HighlightCandidate } from '@shared/types'
import { TargetIcon, PlusIcon } from './icons'

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
  const asset = useProjectStore((s) => s.project.assets.find((a) => a.id === assetId))
  const addTrimmedClipToTimeline = useProjectStore((s) => s.addTrimmedClipToTimeline)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<HighlightCandidate[]>([])
  const [added, setAdded] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!asset) return
    // Kicks off an async IPC call (scene/audio analysis) — an external system fetch, not
    // state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    window.api
      .detectHighlights(asset.filePath, asset.duration)
      .then(setCandidates)
      .catch((e) => setError(formatIpcError(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId])

  if (!asset) return null

  const maxScore = Math.max(1, ...candidates.map((c) => c.score))

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <TargetIcon width={15} height={15} />
          ハイライト検出: {asset.fileName}
        </h3>
        {loading && (
          <p className="hint-text">
            シーンチェンジと音量の変化を解析中...(素材の長さによっては数十秒かかる場合があります)
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && candidates.length === 0 && (
          <p className="hint-text">
            目立ったハイライトを検出できませんでした。素材全体をご確認ください。
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

import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import type { Clip, SilenceRange } from '@shared/types'
import { v4 as uuid } from 'uuid'
import { formatIpcError } from '../lib/ipcError'
import { WandIcon } from './icons'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

export function SilenceCutModal({
  clipId,
  onClose
}: {
  clipId: string
  onClose: () => void
}): React.JSX.Element | null {
  const project = useProjectStore((s) => s.project)
  const replaceClipRange = useProjectStore((s) => s.replaceClipRange)

  const clip = project.clips.find((c) => c.id === clipId)
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ranges, setRanges] = useState<SilenceRange[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!clip || !asset) return
    // Kicks off an async IPC call to the main process on mount/clip change — an external
    // system fetch, not state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    window.api
      .detectSilence(asset.filePath, clip.inPoint, clip.outPoint)
      .then((result) => {
        setRanges(result)
        setChecked(new Set(result.map((_, i) => i)))
      })
      .catch((e) => setError(formatIpcError(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId])

  if (!clip || !asset) return null

  function toggle(i: number): void {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  function handleApply(): void {
    if (!clip) return
    const cutRanges = ranges.filter((_, i) => checked.has(i)).sort((a, b) => a.start - b.start)
    const segments: Clip[] = []
    let cursor = clip.inPoint
    for (const range of cutRanges) {
      const start = Math.max(clip.inPoint, range.start)
      const end = Math.min(clip.outPoint, range.end)
      if (start > cursor + 0.05) {
        segments.push({
          id: uuid(),
          assetId: clip.assetId,
          inPoint: cursor,
          outPoint: start,
          speed: clip.speed
        })
      }
      cursor = Math.max(cursor, end)
    }
    if (cursor < clip.outPoint - 0.05) {
      segments.push({
        id: uuid(),
        assetId: clip.assetId,
        inPoint: cursor,
        outPoint: clip.outPoint,
        speed: clip.speed
      })
    }
    if (segments.length === 0) {
      segments.push({ ...clip })
    } else {
      segments[0].transitionIn = clip.transitionIn
    }
    replaceClipRange(clipId, segments)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <WandIcon width={15} height={15} />
          無音区間の検出: {asset.fileName}
        </h3>
        {loading && <p className="hint-text">検出中...</p>}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && ranges.length === 0 && (
          <p className="hint-text">無音区間は検出されませんでした。</p>
        )}
        {!loading && ranges.length > 0 && (
          <div className="silence-range-list">
            {ranges.map((r, i) => (
              <label key={i} className="silence-range-item">
                <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} />
                {formatTime(r.start - clip.inPoint)} 〜 {formatTime(r.end - clip.inPoint)}
                <span className="hint-text">({(r.end - r.start).toFixed(1)}秒)</span>
              </label>
            ))}
          </div>
        )}
        <p className="hint-text">
          チェックした区間をクリップから削除します。誤検出があればチェックを外してください。
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary-button"
            onClick={handleApply}
            disabled={loading || ranges.length === 0}
          >
            選択した区間を削除
          </button>
        </div>
      </div>
    </div>
  )
}

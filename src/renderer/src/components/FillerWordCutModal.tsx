import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import type { TranscriptSegment } from '@shared/types'
import { buildCutSegments } from '../lib/silenceCut'
import { toTimelineSeconds } from '../lib/timelineMath'
import { formatIpcError } from '../lib/ipcError'
import { isFillerWordText } from '../lib/fillerWords'
import { WandIcon } from './icons'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

export function FillerWordCutModal({
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
  const [ranges, setRanges] = useState<TranscriptSegment[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!clip || !asset) return
    // Kicks off an async IPC call to the main process on mount/clip change — an external
    // system fetch, not state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    window.api
      .transcribe(asset.filePath, clip.inPoint, clip.outPoint)
      .then((segments) => {
        const fillers = segments.filter((seg) => isFillerWordText(seg.text))
        setRanges(fillers)
        setChecked(new Set(fillers.map((_, i) => i)))
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
    const cutRanges = ranges.filter((_, i) => checked.has(i))
    replaceClipRange(clipId, buildCutSegments(clip, cutRanges))
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <WandIcon width={15} height={15} />
          フィラーワードの検出: {asset.fileName}
        </h3>
        {loading && (
          <p className="hint-text">音声を解析中...(初回はモデルのダウンロードが必要です)</p>
        )}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && ranges.length === 0 && (
          <p className="hint-text">
            「えーと」「あの」などのフィラーワードは検出されませんでした。
          </p>
        )}
        {!loading && ranges.length > 0 && (
          <div className="silence-range-list">
            {ranges.map((r, i) => (
              <label key={i} className="silence-range-item">
                <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} />
                {formatTime(toTimelineSeconds(r.start - clip.inPoint, clip.speed))} 〜{' '}
                {formatTime(toTimelineSeconds(r.end - clip.inPoint, clip.speed))}
                <span className="hint-text">「{r.text}」</span>
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

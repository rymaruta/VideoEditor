import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { buildTimedClips } from '../lib/timelineMath'
import { formatIpcError } from '../lib/ipcError'
import { defaultTextStyle } from '@shared/textStyle'
import type { TranscriptSegment } from '@shared/types'
import { MicIcon } from './icons'

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = (seconds % 60).toFixed(1)
  return `${m}:${s.padStart(4, '0')}`
}

export function AutoCaptionModal({
  clipId,
  onClose
}: {
  clipId: string
  onClose: () => void
}): React.JSX.Element | null {
  const project = useProjectStore((s) => s.project)
  const addTextOverlay = useProjectStore((s) => s.addTextOverlay)

  const clip = project.clips.find((c) => c.id === clipId)
  const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const [texts, setTexts] = useState<string[]>([])
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [language, setLanguage] = useState('japanese')

  useEffect(() => {
    if (!clip || !asset) return
    // Kicks off an async IPC call to the main process (speech recognition) — an external
    // system fetch, not state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    window.api
      .transcribe(asset.filePath, clip.inPoint, clip.outPoint, language)
      .then((result) => {
        setSegments(result)
        setTexts(result.map((r) => r.text))
        setChecked(new Set(result.map((_, i) => i)))
      })
      .catch((e) => setError(formatIpcError(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, language])

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
    const timedClips = buildTimedClips(project)
    const tc = timedClips.find((t) => t.clip.id === clipId)
    if (!tc) {
      onClose()
      return
    }
    const speed = clip.speed || 1
    segments.forEach((seg, i) => {
      if (!checked.has(i)) return
      const text = texts[i].trim()
      if (!text) return
      const startTime = tc.start + (seg.start - clip.inPoint) / speed
      const endTime = tc.start + (seg.end - clip.inPoint) / speed
      addTextOverlay({
        text,
        startTime,
        endTime,
        style: defaultTextStyle(),
        source: 'auto'
      })
    })
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <MicIcon width={15} height={15} />
          自動テロップ生成: {asset.fileName}
        </h3>
        <div className="trim-field">
          <label>音声の言語</label>
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={loading}>
            <option value="japanese">日本語</option>
            <option value="english">英語</option>
            <option value="chinese">中国語</option>
            <option value="korean">韓国語</option>
            <option value="spanish">スペイン語</option>
            <option value="french">フランス語</option>
            <option value="german">ドイツ語</option>
          </select>
        </div>
        {loading && (
          <p className="hint-text">
            音声を認識中...(初回はモデルのダウンロードのため数分かかる場合があります。インターネット接続が必要です)
          </p>
        )}
        {error && <p className="error-text">{error}</p>}
        {!loading && !error && segments.length === 0 && (
          <p className="hint-text">テキストを検出できませんでした。</p>
        )}
        {!loading && segments.length > 0 && (
          <div className="silence-range-list">
            {segments.map((seg, i) => (
              <div key={i} className="caption-candidate">
                <label className="checkbox-label">
                  <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} />
                  <span className="hint-text">
                    {formatTime(seg.start - clip.inPoint)} 〜 {formatTime(seg.end - clip.inPoint)}
                  </span>
                </label>
                <input
                  type="text"
                  value={texts[i]}
                  onChange={(e) =>
                    setTexts((prev) => prev.map((t, idx) => (idx === i ? e.target.value : t)))
                  }
                />
              </div>
            ))}
          </div>
        )}
        <p className="hint-text">認識結果を確認・修正してからテロップとして追加してください。</p>
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary-button"
            onClick={handleApply}
            disabled={loading || segments.length === 0}
          >
            テロップとして追加
          </button>
        </div>
      </div>
    </div>
  )
}

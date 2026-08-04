import { useEffect, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import type { Clip, TranscriptWord } from '@shared/types'
import { v4 as uuid } from 'uuid'
import { formatIpcError } from '../lib/ipcError'
import { TypeIcon } from './icons'

export function TextBasedEditModal({
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
  const [language, setLanguage] = useState('japanese')
  const [words, setWords] = useState<TranscriptWord[]>([])
  const [deleted, setDeleted] = useState<Set<number>>(new Set())
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)

  useEffect(() => {
    if (!clip || !asset) return
    // Kicks off an async IPC call to the main process (speech recognition) — an external
    // system fetch, not state derivable from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    setError(null)
    setDeleted(new Set())
    setAnchorIndex(null)
    window.api
      .transcribeWords(asset.filePath, clip.inPoint, clip.outPoint, language)
      .then((segments) => {
        setWords(segments.flatMap((seg) => seg.words ?? []))
      })
      .catch((e) => setError(formatIpcError(e)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId, language])

  if (!clip || !asset) return null

  function handleWordClick(index: number, shiftKey: boolean): void {
    if (shiftKey && anchorIndex !== null) {
      const lo = Math.min(anchorIndex, index)
      const hi = Math.max(anchorIndex, index)
      const markAsDeleted = !deleted.has(index)
      setDeleted((prev) => {
        const next = new Set(prev)
        for (let i = lo; i <= hi; i++) {
          if (markAsDeleted) next.add(i)
          else next.delete(i)
        }
        return next
      })
    } else {
      setDeleted((prev) => {
        const next = new Set(prev)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
      setAnchorIndex(index)
    }
  }

  const deletedDuration = words.reduce(
    (sum, w, i) => sum + (deleted.has(i) ? w.end - w.start : 0),
    0
  )

  function handleApply(): void {
    if (!clip) return
    const cutRanges: { start: number; end: number }[] = []
    let rangeStart: number | null = null
    let rangeEnd = 0
    words.forEach((w, i) => {
      if (deleted.has(i)) {
        if (rangeStart === null) rangeStart = w.start
        rangeEnd = w.end
      } else if (rangeStart !== null) {
        cutRanges.push({ start: rangeStart, end: rangeEnd })
        rangeStart = null
      }
    })
    if (rangeStart !== null) cutRanges.push({ start: rangeStart, end: rangeEnd })

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
          speed: clip.speed,
          audioDetached: clip.audioDetached
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
        speed: clip.speed,
        audioDetached: clip.audioDetached
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
      <div className="modal text-edit-modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          <TypeIcon width={15} height={15} />
          テキストで編集: {asset.fileName}
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
        {!loading && !error && words.length === 0 && (
          <p className="hint-text">テキストを検出できませんでした。</p>
        )}
        {!loading && words.length > 0 && (
          <div className="text-edit-transcript">
            {words.map((w, i) => (
              <span
                key={i}
                className={`text-edit-word ${deleted.has(i) ? 'deleted' : ''}`}
                onClick={(e) => handleWordClick(i, e.shiftKey)}
              >
                {w.text}
              </span>
            ))}
          </div>
        )}
        <p className="hint-text">
          削除したい単語をクリックしてください(取り消し線で表示)。Shift+クリックで範囲選択できます。
          {deleted.size > 0 && ` 削除区間: 約${deletedDuration.toFixed(1)}秒`}
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>キャンセル</button>
          <button
            className="primary-button"
            onClick={handleApply}
            disabled={loading || deleted.size === 0}
          >
            選択した単語を削除
          </button>
        </div>
      </div>
    </div>
  )
}

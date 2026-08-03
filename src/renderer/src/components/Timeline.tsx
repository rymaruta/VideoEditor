import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration } from '../lib/timelineMath'
import { TrimModal } from './TrimModal'

const PIXELS_PER_SECOND = 40

export function Timeline(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const selectClip = useProjectStore((s) => s.selectClip)
  const seekTo = useProjectStore((s) => s.seekTo)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const removeClip = useProjectStore((s) => s.removeClip)
  const moveClip = useProjectStore((s) => s.moveClip)
  const splitClipAtTime = useProjectStore((s) => s.splitClipAtTime)

  const [trimClipId, setTrimClipId] = useState<string | null>(null)

  const timedClips = buildTimedClips(project)
  const total = totalTimelineDuration(timedClips)
  const timelineWidth = Math.max(total * PIXELS_PER_SECOND, 400)

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = Math.max(0, Math.min(total, x / PIXELS_PER_SECOND))
    seekTo(time)
  }

  return (
    <div className="panel timeline-panel">
      <div className="panel-header">
        <h2>タイムライン</h2>
        {selectedClipId && (
          <div className="timeline-actions">
            <button className="small-button" onClick={() => moveClip(selectedClipId, 'left')}>
              ←
            </button>
            <button className="small-button" onClick={() => moveClip(selectedClipId, 'right')}>
              →
            </button>
            <button className="small-button" onClick={() => setTrimClipId(selectedClipId)}>
              トリム
            </button>
            <button
              className="small-button"
              onClick={() => splitClipAtTime(selectedClipId, playheadTime)}
            >
              再生位置でカット
            </button>
            <button className="small-button danger" onClick={() => removeClip(selectedClipId)}>
              削除
            </button>
          </div>
        )}
      </div>
      <div className="timeline-track" style={{ width: timelineWidth }} onClick={handleTrackClick}>
        {timedClips.map((tc) => (
          <div
            key={tc.clip.id}
            className={`timeline-clip ${selectedClipId === tc.clip.id ? 'selected' : ''}`}
            style={{ width: (tc.end - tc.start) * PIXELS_PER_SECOND }}
            onClick={(e) => {
              e.stopPropagation()
              selectClip(tc.clip.id)
            }}
          >
            <span className="timeline-clip-label" title={tc.asset.fileName}>
              {tc.asset.fileName}
            </span>
          </div>
        ))}
        <div
          className="timeline-playhead"
          style={{ left: Math.min(playheadTime, total) * PIXELS_PER_SECOND }}
        />
        {timedClips.length === 0 && (
          <p className="hint-text">メディアからクリップを追加してください</p>
        )}
      </div>
      {trimClipId && <TrimModal clipId={trimClipId} onClose={() => setTrimClipId(null)} />}
    </div>
  )
}

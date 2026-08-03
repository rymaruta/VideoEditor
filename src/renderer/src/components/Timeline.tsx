import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration } from '../lib/timelineMath'
import { TrimModal } from './TrimModal'
import { ChevronLeftIcon, ChevronRightIcon, ScissorsIcon, TrashIcon } from './icons'

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
            <button
              className="icon-button"
              title="左に移動"
              onClick={() => moveClip(selectedClipId, 'left')}
            >
              <ChevronLeftIcon width={14} height={14} />
            </button>
            <button
              className="icon-button"
              title="右に移動"
              onClick={() => moveClip(selectedClipId, 'right')}
            >
              <ChevronRightIcon width={14} height={14} />
            </button>
            <button className="small-button" onClick={() => setTrimClipId(selectedClipId)}>
              トリム
            </button>
            <button
              className="small-button"
              onClick={() => splitClipAtTime(selectedClipId, playheadTime)}
            >
              <ScissorsIcon width={13} height={13} />
              再生位置でカット
            </button>
            <button
              className="icon-button danger"
              title="削除"
              onClick={() => removeClip(selectedClipId)}
            >
              <TrashIcon width={14} height={14} />
            </button>
          </div>
        )}
      </div>
      <div className="timeline-track" style={{ width: timelineWidth }} onClick={handleTrackClick}>
        {timedClips.map((tc, i) => (
          <div
            key={tc.clip.id}
            className={`timeline-clip ${selectedClipId === tc.clip.id ? 'selected' : ''}`}
            style={{ width: (tc.end - tc.start) * PIXELS_PER_SECOND }}
            onClick={(e) => {
              e.stopPropagation()
              selectClip(tc.clip.id)
            }}
          >
            <span className="timeline-clip-index">{i + 1}</span>
            <span className="timeline-clip-label" title={tc.asset.fileName}>
              {tc.asset.fileName}
            </span>
          </div>
        ))}
        <div
          className="timeline-playhead"
          style={{ left: Math.min(playheadTime, total) * PIXELS_PER_SECOND }}
        >
          <div className="timeline-playhead-handle" />
        </div>
        {timedClips.length === 0 && (
          <p className="hint-text timeline-empty-hint">メディアからクリップを追加してください</p>
        )}
      </div>
      {trimClipId && <TrimModal clipId={trimClipId} onClose={() => setTrimClipId(null)} />}
    </div>
  )
}

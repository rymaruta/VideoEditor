import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import {
  buildTimedClips,
  findTimedClipAt,
  totalTimelineDuration,
  TimedClip
} from '../lib/timelineMath'
import { PlayIcon, PauseIcon, ClapperboardIcon } from './icons'

function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withSlash)}`
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function PreviewPlayer(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const setPlayheadTime = useProjectStore((s) => s.setPlayheadTime)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const seekRequest = useProjectStore((s) => s.seekRequest)

  const videoRef = useRef<HTMLVideoElement>(null)
  const activeTimedClipRef = useRef<TimedClip | null>(null)

  const timedClips = useMemo(() => buildTimedClips(project), [project])
  const total = totalTimelineDuration(timedClips)
  const [activeSrc, setActiveSrc] = useState<string | null>(null)

  function loadClipForTime(time: number, resumePlaying: boolean): void {
    const tc = findTimedClipAt(timedClips, time)
    activeTimedClipRef.current = tc
    if (!tc) {
      setActiveSrc(null)
      return
    }
    const url = toFileUrl(tc.asset.filePath)
    const localTime = tc.clip.inPoint + (time - tc.start)
    if (activeSrc !== url) {
      setActiveSrc(url)
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.currentTime = localTime
          if (resumePlaying) videoRef.current.play().catch(() => {})
        }
      })
    } else if (videoRef.current) {
      videoRef.current.currentTime = localTime
      if (resumePlaying) videoRef.current.play().catch(() => {})
    }
  }

  // Handle explicit seeks (from timeline clicks / trim UI), not continuous playback updates.
  useEffect(() => {
    if (!seekRequest) return
    // Reacting to an external event (timeline click) and driving the <video> element's
    // imperative API — not derivable from props/state, so this is not a "derived state" effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadClipForTime(seekRequest.time, isPlaying)
    // Intentionally only re-running on a new seek request, not on every isPlaying change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest?.token])

  // Initial load / when timeline structure changes, ensure something is loaded.
  useEffect(() => {
    if (!activeTimedClipRef.current && timedClips.length > 0) {
      loadClipForTime(0, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timedClips.length])

  useEffect(() => {
    if (isPlaying) {
      videoRef.current?.play().catch(() => {})
    } else {
      videoRef.current?.pause()
    }
  }, [isPlaying])

  function handleTimeUpdate(): void {
    const tc = activeTimedClipRef.current
    const video = videoRef.current
    if (!tc || !video) return
    const globalTime = tc.start + (video.currentTime - tc.clip.inPoint)
    setPlayheadTime(globalTime)

    if (video.currentTime >= tc.clip.outPoint - 0.02) {
      const idx = timedClips.indexOf(tc)
      const next = timedClips[idx + 1]
      if (next) {
        loadClipForTime(next.start, isPlaying)
      } else {
        video.pause()
        setIsPlaying(false)
      }
    }
  }

  const activeOverlays = project.textOverlays.filter(
    (o) => playheadTime >= o.startTime && playheadTime < o.endTime
  )

  const aspectClass = project.aspectRatio === '9:16' ? 'aspect-9-16' : 'aspect-16-9'

  return (
    <div className="panel preview-player">
      <div className="preview-frame-wrapper">
        <div className={`preview-frame ${aspectClass}`}>
          {activeSrc ? (
            <video
              ref={videoRef}
              src={activeSrc}
              onTimeUpdate={handleTimeUpdate}
              onEnded={() => setIsPlaying(false)}
            />
          ) : (
            <div className="preview-empty">
              <ClapperboardIcon width={32} height={32} />
              <p>タイムラインにクリップを追加してください</p>
            </div>
          )}
          {activeOverlays.map((o) => (
            <div
              key={o.id}
              className={`overlay-text overlay-${o.style.position}`}
              style={{
                fontSize: o.style.fontSize * 0.4,
                color: o.style.color,
                fontWeight: o.style.bold ? 700 : 400,
                textShadow: o.style.outline ? '0 0 4px rgba(0,0,0,0.9)' : undefined
              }}
            >
              {o.text}
            </div>
          ))}
        </div>
      </div>
      <div className="preview-controls">
        <button
          className="play-button"
          onClick={() => setIsPlaying(!isPlaying)}
          disabled={!activeSrc}
        >
          {isPlaying ? <PauseIcon width={16} height={16} /> : <PlayIcon width={16} height={16} />}
        </button>
        <div className="scrub-track">
          <div
            className="scrub-fill"
            style={{ width: total > 0 ? `${Math.min(100, (playheadTime / total) * 100)}%` : '0%' }}
          />
        </div>
        <span className="time-label">
          {formatTime(playheadTime)} / {formatTime(total)}
        </span>
      </div>
    </div>
  )
}

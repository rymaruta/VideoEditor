import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useProjectStore } from '../store/projectStore'
import {
  buildTimedClips,
  findTimedClipAt,
  totalTimelineDuration,
  TimedClip
} from '../lib/timelineMath'
import { PlayIcon, PauseIcon, ClapperboardIcon } from './icons'
import type { TextStyle } from '@shared/types'

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

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const FONT_STACKS: Record<TextStyle['fontFamily'], string> = {
  'sans-serif': 'sans-serif',
  serif: 'serif',
  'M PLUS Rounded 1c': '"M PLUS Rounded 1c", sans-serif',
  'Noto Sans JP': '"Noto Sans JP", sans-serif',
  'Noto Serif JP': '"Noto Serif JP", serif'
}

function overlayPreviewStyle(style: TextStyle): CSSProperties {
  const shadows: string[] = []
  if (style.outline) {
    const w = Math.max(1, Math.round(style.outlineWidth * 0.6))
    const c = style.outlineColor
    shadows.push(
      `-${w}px -${w}px 0 ${c}`,
      `${w}px -${w}px 0 ${c}`,
      `-${w}px ${w}px 0 ${c}`,
      `${w}px ${w}px 0 ${c}`
    )
  }
  if (style.shadow) {
    shadows.push('2px 3px 4px rgba(0,0,0,0.7)')
  }
  return {
    fontFamily: FONT_STACKS[style.fontFamily],
    fontSize: style.fontSize * 0.4,
    color: style.color,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    letterSpacing: style.letterSpacing ? `${style.letterSpacing * 0.4}px` : undefined,
    textShadow: shadows.length > 0 ? shadows.join(', ') : undefined,
    backgroundColor: style.background
      ? hexToRgba(style.backgroundColor, style.backgroundOpacity)
      : undefined,
    padding: style.background ? '0.15em 0.4em' : undefined,
    borderRadius: style.background ? '4px' : undefined,
    display: style.background ? 'inline-block' : undefined
  }
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
    const speed = tc.clip.speed || 1
    const localTime = tc.clip.inPoint + (time - tc.start) * speed
    if (activeSrc !== url) {
      setActiveSrc(url)
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.currentTime = localTime
          videoRef.current.playbackRate = speed
          if (resumePlaying) videoRef.current.play().catch(() => {})
        }
      })
    } else if (videoRef.current) {
      videoRef.current.currentTime = localTime
      videoRef.current.playbackRate = speed
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
    const speed = tc.clip.speed || 1
    const globalTime = tc.start + (video.currentTime - tc.clip.inPoint) / speed
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
              className={`overlay-text overlay-${o.style.position} anim-${o.style.animation}`}
              style={overlayPreviewStyle(o.style)}
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

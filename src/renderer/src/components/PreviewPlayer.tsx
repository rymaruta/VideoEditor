import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useProjectStore } from '../store/projectStore'
import {
  buildTimedClips,
  findTimedClipAt,
  totalTimelineDuration,
  TimedClip
} from '../lib/timelineMath'
import { PlayIcon, PauseIcon, ClapperboardIcon, YoutubeIcon } from './icons'
import { ShortsUiMockup } from './ShortsUiMockup'
import type { TextOverlay, TextStyle } from '@shared/types'

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
    display: style.background ? 'inline-block' : undefined,
    whiteSpace: 'pre-line'
  }
}

function renderOverlayText(o: TextOverlay): React.ReactNode {
  if (o.style.animation !== 'typewriter') return o.text
  const lines = o.text.split('\n')
  let charIndex = 0
  return lines.map((line, lineIdx) => (
    <span key={lineIdx}>
      {lineIdx > 0 && <br />}
      {[...line].map((char, i) => {
        const delay = charIndex * 40
        charIndex += 1
        return (
          <span key={i} className="typewriter-char" style={{ animationDelay: `${delay}ms` }}>
            {char}
          </span>
        )
      })}
    </span>
  ))
}

interface OverlayDragState {
  id: string
  x: number
  y: number
}

export function PreviewPlayer(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const setPlayheadTime = useProjectStore((s) => s.setPlayheadTime)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const seekRequest = useProjectStore((s) => s.seekRequest)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)

  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const activeTimedClipRef = useRef<TimedClip | null>(null)
  const [overlayDrag, setOverlayDrag] = useState<OverlayDragState | null>(null)
  const [showShortsUi, setShowShortsUi] = useState(false)

  function clientToNormalized(clientX: number, clientY: number): { x: number; y: number } {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0.5, y: 0.5 }
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
    }
  }

  useEffect(() => {
    if (!overlayDrag) return
    function handleMouseMove(e: MouseEvent): void {
      setOverlayDrag((prev) =>
        prev ? { ...prev, ...clientToNormalized(e.clientX, e.clientY) } : prev
      )
    }
    function handleMouseUp(): void {
      const overlay = project.textOverlays.find((o) => o.id === overlayDrag?.id)
      if (overlay && overlayDrag) {
        updateTextOverlay(overlayDrag.id, {
          style: { ...overlay.style, customPosition: { x: overlayDrag.x, y: overlayDrag.y } }
        })
      }
      setOverlayDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [overlayDrag, project.textOverlays, updateTextOverlay])

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
        <div className={`preview-frame ${aspectClass}`} ref={frameRef}>
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
          {activeOverlays.map((o) => {
            const livePos = overlayDrag?.id === o.id ? overlayDrag : o.style.customPosition
            const positionStyle: CSSProperties = livePos
              ? {
                  left: `${livePos.x * 100}%`,
                  top: `${livePos.y * 100}%`,
                  right: 'auto'
                }
              : {}
            const transforms: string[] = []
            if (livePos) transforms.push('translate(-50%, -50%)')
            else if (o.style.position === 'center') transforms.push('translateY(-50%)')
            if (o.style.rotation) transforms.push(`rotate(${o.style.rotation}deg)`)
            if (transforms.length > 0) positionStyle.transform = transforms.join(' ')
            return (
              <div
                key={o.id}
                className={`overlay-text ${livePos ? '' : `overlay-${o.style.position}`} anim-${o.style.animation}`}
                style={{ ...overlayPreviewStyle(o.style), ...positionStyle }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setOverlayDrag({ id: o.id, ...clientToNormalized(e.clientX, e.clientY) })
                }}
              >
                {renderOverlayText(o)}
              </div>
            )
          })}
          {showShortsUi && project.aspectRatio === '9:16' && <ShortsUiMockup />}
        </div>
      </div>
      <div className="preview-controls">
        {project.aspectRatio === '9:16' && (
          <button
            className={`icon-button ${showShortsUi ? 'active' : ''}`}
            title="YouTube Shorts の実際の画面イメージを重ねて表示(いいね/コメントなどのUIに字幕が隠れないか確認できます)"
            onClick={() => setShowShortsUi((v) => !v)}
          >
            <YoutubeIcon width={14} height={14} />
          </button>
        )}
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

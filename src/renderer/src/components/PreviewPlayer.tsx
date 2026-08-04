import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useProjectStore } from '../store/projectStore'
import {
  buildTimedClips,
  findTimedClipAt,
  totalTimelineDuration,
  TimedClip
} from '../lib/timelineMath'
import {
  PlayIcon,
  PauseIcon,
  ClapperboardIcon,
  YoutubeIcon,
  MaximizeIcon,
  Volume2Icon,
  VolumeXIcon
} from './icons'
import { ShortsUiMockup } from './ShortsUiMockup'
import type {
  MediaAsset,
  PipPosition,
  TextOverlay,
  TextStyle,
  VideoOverlayClip,
  VideoOverlayTrack
} from '@shared/types'

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

function renderOverlayText(o: TextOverlay, playheadTime: number): React.ReactNode {
  if (o.style.wordHighlight && o.words && o.words.length > 0) {
    return o.words.map((w, i) => (
      <span
        key={i}
        style={{
          color:
            playheadTime >= w.start && playheadTime < w.end ? o.style.highlightColor : undefined
        }}
      >
        {w.text}
      </span>
    ))
  }
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

const VOLUME_KEY = 've-preview-volume'
const MUTED_KEY = 've-preview-muted'

function readStoredVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY)
  const n = raw ? Number(raw) : 1
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1
}

function findActiveOverlayClip(
  track: VideoOverlayTrack,
  time: number
): VideoOverlayClip | undefined {
  return track.clips.find((c) => {
    const duration = c.outPoint - c.inPoint
    return time >= c.startTime && time < c.startTime + duration
  })
}

function pipStyle(position: PipPosition, scale: number): CSSProperties {
  const style: CSSProperties = {
    position: 'absolute',
    width: `${scale * 100}%`,
    height: 'auto',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
    border: '2px solid rgba(255, 255, 255, 0.8)',
    zIndex: 2
  }
  if (position === 'top-left' || position === 'top-right') style.top = '4%'
  else style.bottom = '4%'
  if (position === 'top-left' || position === 'bottom-left') style.left = '4%'
  else style.right = '4%'
  return style
}

function VideoOverlayLayer({
  clip,
  asset,
  position,
  scale,
  playheadTime,
  isPlaying,
  volume,
  muted
}: {
  clip: VideoOverlayClip
  asset: MediaAsset
  position: PipPosition
  scale: number
  playheadTime: number
  isPlaying: boolean
  volume: number
  muted: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  const localTime = clip.inPoint + (playheadTime - clip.startTime)

  useEffect(() => {
    if (ref.current && Math.abs(ref.current.currentTime - localTime) > 0.3) {
      ref.current.currentTime = localTime
    }
  }, [localTime])

  useEffect(() => {
    if (isPlaying) {
      ref.current?.play().catch(() => {})
    } else {
      ref.current?.pause()
    }
  }, [isPlaying])

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = volume
      ref.current.muted = muted
    }
  }, [volume, muted])

  return <video ref={ref} src={toFileUrl(asset.filePath)} style={pipStyle(position, scale)} />
}

export function PreviewPlayer(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const isPlaying = useProjectStore((s) => s.isPlaying)
  const setIsPlaying = useProjectStore((s) => s.setIsPlaying)
  const setPlayheadTime = useProjectStore((s) => s.setPlayheadTime)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const seekRequest = useProjectStore((s) => s.seekRequest)
  const seekTo = useProjectStore((s) => s.seekTo)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)

  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const activeTimedClipRef = useRef<TimedClip | null>(null)
  const [overlayDrag, setOverlayDrag] = useState<OverlayDragState | null>(null)
  const [showShortsUi, setShowShortsUi] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [volume, setVolume] = useState(readStoredVolume)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED_KEY) === 'true')

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

  // Drive the playhead from requestAnimationFrame instead of the <video> element's
  // native `timeupdate` event, which only fires a handful of times per second and
  // makes the timeline playhead visibly jump instead of gliding smoothly.
  useEffect(() => {
    if (!isPlaying) return
    let frameId: number
    function tick(): void {
      const tc = activeTimedClipRef.current
      const video = videoRef.current
      if (tc && video) {
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
      frameId = requestAnimationFrame(tick)
    }
    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, timedClips])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = muted
    }
  }, [volume, muted, activeSrc])

  useEffect(() => {
    localStorage.setItem(VOLUME_KEY, String(volume))
  }, [volume])
  useEffect(() => {
    localStorage.setItem(MUTED_KEY, String(muted))
  }, [muted])

  useEffect(() => {
    if (!isExpanded) return
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setIsExpanded(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExpanded])

  const activeOverlays = project.textOverlays.filter(
    (o) => playheadTime >= o.startTime && playheadTime < o.endTime
  )

  const aspectClass = project.aspectRatio === '9:16' ? 'aspect-9-16' : 'aspect-16-9'

  return (
    <>
      {isExpanded && (
        <div className="preview-expanded-backdrop" onClick={() => setIsExpanded(false)} />
      )}
      <div className={`panel preview-player ${isExpanded ? 'expanded' : ''}`}>
        <div className="preview-frame-wrapper">
          <div className={`preview-frame ${aspectClass}`} ref={frameRef}>
            {activeSrc ? (
              <video ref={videoRef} src={activeSrc} onEnded={() => setIsPlaying(false)} />
            ) : (
              <div className="preview-empty">
                <ClapperboardIcon width={32} height={32} />
                <p>タイムラインにクリップを追加してください</p>
              </div>
            )}
            {project.videoOverlayTracks
              .filter((t) => !t.hidden)
              .map((track) => {
                const clip = findActiveOverlayClip(track, playheadTime)
                if (!clip) return null
                const asset = project.assets.find((a) => a.id === clip.assetId)
                if (!asset) return null
                return (
                  <VideoOverlayLayer
                    key={track.id}
                    clip={clip}
                    asset={asset}
                    position={track.position}
                    scale={track.scale}
                    playheadTime={playheadTime}
                    isPlaying={isPlaying}
                    volume={volume}
                    muted={muted}
                  />
                )
              })}
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
                  {renderOverlayText(o, playheadTime)}
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
          <div
            className="scrub-track"
            onClick={(e) => {
              if (total <= 0) return
              const rect = e.currentTarget.getBoundingClientRect()
              const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
              seekTo(ratio * total)
            }}
          >
            <div
              className="scrub-fill"
              style={{
                width: total > 0 ? `${Math.min(100, (playheadTime / total) * 100)}%` : '0%'
              }}
            />
          </div>
          <span className="time-label">
            {formatTime(playheadTime)} / {formatTime(total)}
          </span>
          <div className="preview-volume">
            <button
              className="icon-button"
              title={muted ? 'ミュート解除' : 'ミュート'}
              onClick={() => setMuted((v) => !v)}
            >
              {muted || volume === 0 ? (
                <VolumeXIcon width={14} height={14} />
              ) : (
                <Volume2Icon width={14} height={14} />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value)
                setVolume(v)
                if (v > 0 && muted) setMuted(false)
              }}
              title="音量"
            />
          </div>
          <button
            className={`icon-button ${isExpanded ? 'active' : ''}`}
            title={isExpanded ? '実サイズ表示を閉じる (Esc)' : '実サイズで表示'}
            onClick={() => setIsExpanded((v) => !v)}
          >
            <MaximizeIcon width={14} height={14} />
          </button>
        </div>
      </div>
    </>
  )
}

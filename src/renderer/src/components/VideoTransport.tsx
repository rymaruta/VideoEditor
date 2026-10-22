import { useEffect, useRef, useState } from 'react'
import {
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume2Icon,
  VolumeXIcon
} from './icons'

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * 1 本の動画の再生の帯(モニターと同じ見た目: 時刻・つまみの溝・先頭へ/再生/末尾へ・音量・大きく)。
 * Chrome 既定の操作盤(`<video controls>`)の代わり。`range` を渡すと、溝にその区間(イン〜アウト)を
 * 重ねて見せ、先頭へ/末尾へはその区間の端へ飛ぶ。
 */
export function VideoTransport({
  videoRef,
  fullscreenRef,
  range
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 「大きく表示」で全画面にする要素(無ければ動画そのもの) */
  fullscreenRef?: React.RefObject<HTMLElement | null>
  range?: { start: number; end: number }
}): React.JSX.Element {
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [scrubbing, setScrubbing] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const sync = (): void => {
      setTime(v.currentTime)
      setDuration(Number.isFinite(v.duration) ? v.duration : 0)
      setPlaying(!v.paused && !v.ended)
      setMuted(v.muted)
      setVolume(v.volume)
    }
    const events = [
      'timeupdate',
      'durationchange',
      'loadedmetadata',
      'play',
      'pause',
      'ended',
      'volumechange',
      'seeked'
    ]
    for (const e of events) v.addEventListener(e, sync)
    sync()
    return () => {
      for (const e of events) v.removeEventListener(e, sync)
    }
  }, [videoRef])

  const seek = (t: number): void => {
    const v = videoRef.current
    if (!v || duration <= 0) return
    v.currentTime = Math.min(duration, Math.max(0, t))
    setTime(v.currentTime)
  }
  const seekFromPointer = (clientX: number): void => {
    const el = trackRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    seek(ratio * duration)
  }
  useEffect(() => {
    if (!scrubbing) return
    const move = (e: PointerEvent): void => seekFromPointer(e.clientX)
    const up = (): void => setScrubbing(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // seekFromPointer は描くたびに作り直すが、中身は ref と duration だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubbing, duration])

  const toggle = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused || v.ended) void v.play().catch(() => {})
    else v.pause()
  }
  const head = range ? range.start : 0
  const tail = range ? range.end : duration
  const pct = (t: number): string =>
    duration > 0 ? `${(Math.min(duration, t) / duration) * 100}%` : '0%'
  const disabled = duration <= 0

  return (
    <div className="preview-controls video-transport">
      <div className="preview-scrub-row">
        <span className="time-label current">{formatTime(time)}</span>
        <div
          ref={trackRef}
          className={`scrub-track ${scrubbing ? 'scrubbing' : ''}`}
          role="slider"
          tabIndex={0}
          aria-label="再生位置"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 10) / 10}
          aria-valuenow={Math.round(time * 10) / 10}
          aria-valuetext={formatTime(time)}
          onPointerDown={(e) => {
            if (disabled) return
            seekFromPointer(e.clientX)
            setScrubbing(true)
          }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 5 : 1
            if (e.key === 'ArrowLeft') seek(time - step)
            else if (e.key === 'ArrowRight') seek(time + step)
            else if (e.key === 'Home') seek(0)
            else if (e.key === 'End') seek(duration)
            else return
            e.preventDefault()
          }}
        >
          {range && (
            <div
              className="scrub-range"
              style={{
                left: pct(range.start),
                width: `calc(${pct(range.end)} - ${pct(range.start)})`
              }}
            />
          )}
          <div className="scrub-fill" style={{ width: pct(time) }} />
        </div>
        <span className="time-label total">{formatTime(duration)}</span>
      </div>
      <div className="preview-transport-row">
        <div className="transport-side transport-side-left" />
        <div className="transport-center">
          <button
            type="button"
            className="icon-button"
            title={range ? 'イン点へ' : '先頭へ'}
            aria-label={range ? 'イン点へ' : '先頭へ'}
            disabled={disabled}
            onClick={() => seek(head)}
          >
            <SkipBackIcon width={14} height={14} />
          </button>
          <button
            type="button"
            className="play-button"
            aria-label={playing ? '一時停止' : '再生'}
            title={playing ? '一時停止' : '再生'}
            disabled={disabled}
            onClick={toggle}
          >
            {playing ? <PauseIcon width={16} height={16} /> : <PlayIcon width={16} height={16} />}
          </button>
          <button
            type="button"
            className="icon-button"
            title={range ? 'アウト点へ' : '末尾へ'}
            aria-label={range ? 'アウト点へ' : '末尾へ'}
            disabled={disabled}
            onClick={() => seek(tail)}
          >
            <SkipForwardIcon width={14} height={14} />
          </button>
        </div>
        <div className="transport-side transport-side-right">
          <div className="preview-volume">
            <button
              type="button"
              className="icon-button"
              title={muted ? 'ミュート解除' : 'ミュート'}
              aria-label={muted ? 'ミュート解除' : 'ミュート'}
              onClick={() => {
                const v = videoRef.current
                if (v) v.muted = !v.muted
              }}
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
              aria-label="音量"
              title="音量"
              onChange={(e) => {
                const v = videoRef.current
                if (!v) return
                v.volume = Number(e.target.value)
                if (v.volume > 0 && v.muted) v.muted = false
              }}
            />
          </div>
          <button
            type="button"
            className="icon-button"
            title="全画面で表示"
            aria-label="全画面で表示"
            disabled={disabled}
            onClick={() => {
              const el = fullscreenRef?.current ?? videoRef.current
              void el?.requestFullscreen?.().catch(() => {})
            }}
          >
            <MaximizeIcon width={14} height={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

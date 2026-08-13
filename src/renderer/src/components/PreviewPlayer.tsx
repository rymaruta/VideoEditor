import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { targetResolution } from '@shared/resolution'
import { frameSeconds } from '@shared/frameRate'
import { fadeGainAt } from '@shared/audioFade'
import { pipMarginPx } from '@shared/pipLayout'
import { TEXT_MARGIN_V_RATIO } from '@shared/textStyle'
import { blurSigmaFor } from '@shared/videoFrame'
import {
  audioClipDuration,
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
  VolumeXIcon,
  SkipBackIcon,
  SkipForwardIcon,
  StepBackIcon,
  StepForwardIcon
} from './icons'

import { ShortsUiMockup } from './ShortsUiMockup'
import type {
  AudioTrackClip,
  MediaAsset,
  PipPosition,
  TextOverlay,
  TextPosition,
  TextStyle,
  VideoOverlayClip,
  VideoOverlayTrack
} from '@shared/types'
import { previewSourceUrl } from '../lib/previewSource'

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

// 書き出し側の `\shad2`(出力ピクセル)に合わせる。
const SHADOW_OFFSET_OUTPUT_PX = 2

/**
 * `text-shadow` に入れる長さを安全な数値にする。
 *
 * NaN や負値がひとつでも混ざると `NaNpx` になって **text-shadow 宣言ごと無効**になり、
 * 縁取りも影もまとめて消える(しかもエラーは出ない)。プロジェクトファイルは外から
 * 来るので、描画直前で切り落とす。
 */
function normalizeLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * テロップの見た目を画面用に組み立てる。
 *
 * 書き出しは ASS の PlayResX/PlayResY を出力解像度に合わせているので、`fontSize` と
 * `letterSpacing` は**出力ピクセル**の値になる。プレビュー枠は出力よりずっと小さいので、
 * 「枠の高さ / 出力の高さ」を掛けて同じ比率で描く。ここを固定倍率にしていたときは、
 * サイズ40のテロップが画面では枠高の 6.77% を占めるのに、1080p の書き出しでは 2.08%
 * にしかならず、画面で決めたサイズが出力で使えなかった。
 *
 * 縁取り・影も同じ「出力ピクセル」の値なので、フォントと同じ `scale` を掛ける。
 */
function overlayPreviewStyle(style: TextStyle, scale: number): CSSProperties {
  const shadows: string[] = []
  if (style.outline) {
    // 縁取りも出力ピクセルの値(書き出しは `\bord${outlineWidth}`)なので、フォントと
    // 同じ `scale` を掛ける。ここだけ固定倍率のままだったため、文字は正しい比率なのに
    // 縁取りだけが太すぎた(1080p を 320px 枠で見ると scale≈0.30、太さ6は本来1.78pxの
    // ところ 3.6px で描かれていた)。
    // 整数pxに丸めない・1px の下限も置かない。text-shadow は小数pxを受け付けて
    // アンチエイリアスするので、丸めると縮小率が高いときにその丸めのほうが誤差の
    // 主因になる(1920p を 240px 枠で見ると、下限1px が本来 0.25px の縁取りを 4倍に
    // 太らせていた)。細く見えるのは書き出しでも実際に細いということ。
    const w = normalizeLength(style.outlineWidth) * scale
    const c = style.outlineColor
    if (w > 0) {
      shadows.push(
        `-${w}px -${w}px 0 ${c}`,
        `${w}px -${w}px 0 ${c}`,
        `-${w}px ${w}px 0 ${c}`,
        `${w}px ${w}px 0 ${c}`
      )
    }
  }
  if (style.shadow) {
    // 影も同じ。書き出しは `\shad2` = 出力2px 相当なので、画面でもその比率で置く。
    const o = SHADOW_OFFSET_OUTPUT_PX * scale
    if (o > 0) shadows.push(`${o}px ${o}px ${o * 2}px rgba(0,0,0,0.7)`)
  }
  return {
    fontFamily: FONT_STACKS[style.fontFamily],
    fontSize: style.fontSize * scale,
    color: style.color,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    letterSpacing: style.letterSpacing ? `${style.letterSpacing * scale}px` : undefined,
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

/**
 * テロップの縦位置。**書き出しと同じ数字**(`TEXT_MARGIN_V_RATIO`)から出す。
 *
 * ここは以前 CSS の `.overlay-top { top: 8% }` / `.overlay-bottom { bottom: 10% }` に
 * 直接書かれていて、**下だけ書き出し(8%)と食い違っていた**。既定のテロップ位置が
 * `bottom` なので、既定のまま使うと必ず踏む。数字を2箇所に書く形をやめて、
 * 片方だけ動かせないようにする。
 */
function verticalAnchorStyle(position: TextPosition): CSSProperties {
  const margin = `${TEXT_MARGIN_V_RATIO * 100}%`
  if (position === 'top') return { top: margin }
  if (position === 'bottom') return { bottom: margin }
  return { top: '50%' }
}

/**
 * 隅からの余白は**枠の幅**基準(書き出しと同じ規則)。CSS の `top`/`bottom` に `%` を書くと
 * **親の高さ**基準になり、同じ設定でも縦横比によって書き出しとズレる。
 * 枠の実寸が要るので `frameWidth` を受け取る(0 のときは 0px = 隅に付く。初回描画の
 * 1フレームだけで、ResizeObserver が測ったらすぐ追従する)。
 */
function pipStyle(position: PipPosition, scale: number, frameWidth: number): CSSProperties {
  const margin = pipMarginPx(frameWidth)
  const style: CSSProperties = {
    position: 'absolute',
    width: `${scale * 100}%`,
    height: 'auto',
    borderRadius: 8,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
    border: '2px solid rgba(255, 255, 255, 0.8)',
    zIndex: 2
  }
  if (position === 'top-left' || position === 'top-right') style.top = margin
  else style.bottom = margin
  if (position === 'top-left' || position === 'bottom-left') style.left = margin
  else style.right = margin
  return style
}

function VideoOverlayLayer({
  clip,
  asset,
  position,
  scale,
  frameWidth,
  playheadTime,
  isPlaying,
  volume,
  muted
}: {
  clip: VideoOverlayClip
  asset: MediaAsset
  position: PipPosition
  scale: number
  frameWidth: number
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

  return (
    <video ref={ref} src={previewSourceUrl(asset)} style={pipStyle(position, scale, frameWidth)} />
  )
}

/**
 * 余白を素材のぼかしで埋めるクリップ用の背景レイヤー。
 *
 * 書き出しは同じ入力を2つに分けて「拡大+ぼかし」と「収めた前景」を重ねている。
 * プレビューでも同じ見た目にするため、同じ素材をもう1枚 `object-fit: cover` で敷いて
 * CSS の blur を掛ける。位置合わせは PiP レイヤーと同じで、0.3秒以上ずれたときだけ
 * 合わせ直す(ぼかしているので多少のズレは見えない。毎フレーム合わせると重い)。
 */
function PreviewBlurBackdrop({
  src,
  localTime,
  isPlaying,
  blurPx
}: {
  src: string
  localTime: number
  isPlaying: boolean
  blurPx: number
}): React.JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    if (ref.current && Math.abs(ref.current.currentTime - localTime) > 0.3) {
      ref.current.currentTime = localTime
    }
  }, [localTime])

  useEffect(() => {
    if (isPlaying) ref.current?.play().catch(() => {})
    else ref.current?.pause()
  }, [isPlaying])

  return (
    <video
      ref={ref}
      className="preview-blur-backdrop"
      src={src}
      muted
      style={{ filter: `blur(${blurPx}px)` }}
    />
  )
}

// Plays one BGM/narration/SE clip during preview via a hidden <audio> element,
// mounted only while the playhead is inside the clip's range. Ducking is an
// export-time filter and is not simulated here.
function AudioTrackClipLayer({
  clip,
  asset,
  trackVolume,
  trackMuted,
  playheadTime,
  isPlaying,
  masterVolume,
  masterMuted
}: {
  clip: AudioTrackClip
  asset: MediaAsset
  trackVolume: number
  trackMuted: boolean
  playheadTime: number
  isPlaying: boolean
  masterVolume: number
  masterMuted: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLAudioElement>(null)
  const speed = clip.speed || 1
  // タイムライン秒 → 素材秒は速度を掛ける。等倍以外だと素材の進みが速く(遅く)なる。
  const localTime = clip.inPoint + (playheadTime - clip.startTime) * speed

  useEffect(() => {
    if (ref.current && Math.abs(ref.current.currentTime - localTime) > 0.3) {
      ref.current.currentTime = localTime
    }
  }, [localTime])

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed
  }, [speed])

  useEffect(() => {
    if (isPlaying) {
      ref.current?.play().catch(() => {})
    } else {
      ref.current?.pause()
    }
  }, [isPlaying])

  // 書き出しの afade と同じ規則(共通モジュール)でゲインを掛ける。
  // ここで別式にすると、画面で聞いた音と出来上がりが黙って食い違う。
  const fadeGain = fadeGainAt(
    playheadTime - clip.startTime,
    audioClipDuration(clip),
    clip.fadeIn,
    clip.fadeOut
  )
  const effectiveVolume = Math.min(
    1,
    Math.max(0, masterVolume * trackVolume * (clip.volume ?? 1) * fadeGain)
  )
  useEffect(() => {
    if (ref.current) {
      ref.current.volume = effectiveVolume
      ref.current.muted = masterMuted || trackMuted
    }
  }, [effectiveVolume, masterMuted, trackMuted])

  // Hidden: this element exists only to play back the audio-track clip, and must
  // not take part in the preview frame's layout.
  return <audio ref={ref} src={previewSourceUrl(asset)} style={{ display: 'none' }} />
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
  const exportResolutionHeight = useSettingsStore((s) => s.exportResolutionHeight)

  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  // 枠の高さは左右パネルのドラッグ・ウィンドウリサイズ・プレビューの拡大で変わるので、
  // 実測して追従させる。テロップの換算倍率の分母になる。
  const [frameHeight, setFrameHeight] = useState(0)
  // 幅も同じ経路で測る。PiP の余白は**幅**基準(書き出しと同じ規則)なので要る。
  const [frameWidth, setFrameWidth] = useState(0)
  const activeTimedClipRef = useRef<TimedClip | null>(null)
  const [overlayDrag, setOverlayDrag] = useState<OverlayDragState | null>(null)
  const [showShortsUi, setShowShortsUi] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [volume, setVolume] = useState(readStoredVolume)
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTED_KEY) === 'true')
  const [scrubbingPreview, setScrubbingPreview] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const scrubTrackRef = useRef<HTMLDivElement>(null)

  // The preview uses Chromium's <video>, which supports far fewer codecs than the
  // ffmpeg used for export — H.265/HEVC and AV1 game captures decode fine on export
  // but fail here. Without this, play() just rejects, the button stays in its
  // "playing" state and nothing moves, with no indication of why.
  const UNPLAYABLE_MESSAGE =
    'この動画はプレビューで再生できません。H.265(HEVC)やAV1など、プレビューが対応していない形式の可能性があります。カット位置の指定などの編集は行えます。書き出しは別の仕組み(ffmpeg)を使うため、成功する場合があります。'

  function handleVideoError(): void {
    const code = videoRef.current?.error?.code
    setIsPlaying(false)
    setPlaybackError(
      code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === MediaError.MEDIA_ERR_DECODE
        ? UNPLAYABLE_MESSAGE
        : 'この動画を読み込めませんでした。ファイルが移動・削除されていないか確認してください。'
    )
  }

  // A file whose video stream can't be decoded but whose audio can (HEVC video + AAC
  // audio) loads "successfully" and fires no error — it just never produces a frame.
  // videoWidth is the only signal that separates it from a working clip.
  // 枠の実寸を測って追従する。ResizeObserver なので、パネルのドラッグでも
  // ウィンドウリサイズでも拡大表示の切り替えでも同じ経路で更新される。
  // useEffect だと描画のあとに測ることになり、最初の1フレームだけ倍率0(文字が消える)
  // で描かれてしまうため、描画前に走る useLayoutEffect を使う。
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const initial = el.getBoundingClientRect()
    setFrameHeight(initial.height)
    setFrameWidth(initial.width)
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect) {
        setFrameHeight(rect.height)
        setFrameWidth(rect.width)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [isExpanded])

  // 書き出しの ASS は PlayResY = 出力の高さ、文字サイズは出力ピクセル。
  // 画面では「枠の高さ / 出力の高さ」倍で描くと、フレームに対する比率が出力と一致する。
  const outputHeight = targetResolution(project.aspectRatio, exportResolutionHeight).h
  const overlayScale = frameHeight > 0 && outputHeight > 0 ? frameHeight / outputHeight : 0

  function handleLoadedMetadata(): void {
    const video = videoRef.current
    if (!video) return
    const expectsVideo = activeTimedClipRef.current?.asset.hasVideo ?? true
    if (expectsVideo && video.videoWidth === 0) {
      setIsPlaying(false)
      setPlaybackError(UNPLAYABLE_MESSAGE)
      return
    }
    setPlaybackError(null)
  }

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
  // 書き出しの `gblur=sigma` は出力ピクセル基準。画面では枠の実寸に合わせて換算する
  // (固定倍率を書くと解像度や枠の大きさを変えたときに見た目が食い違う)。
  // CSS の `blur(v)` は標準偏差 v/2 のガウスぼかしなので、sigma を2倍して渡す。
  const blurBackdrop = ((): { localTime: number; blurPx: number } | null => {
    const tc = findTimedClipAt(timedClips, playheadTime)
    if (!tc || tc.clip.fillCrop || !tc.clip.blurBackground) return null
    if (overlayScale <= 0) return null
    const speed = tc.clip.speed || 1
    return {
      localTime: tc.clip.inPoint + (playheadTime - tc.start) * speed,
      blurPx: blurSigmaFor(outputHeight) * overlayScale * 2
    }
  })()

  const total = totalTimelineDuration(timedClips)

  // Continuous drag-scrubbing on the preview's own progress bar: seekTo() already
  // preserves the isPlaying state, so this lets the user grab the bar and drag through
  // the video while it keeps playing, not just click to jump once.
  useEffect(() => {
    if (!scrubbingPreview) return
    function handleMove(e: MouseEvent): void {
      const rect = scrubTrackRef.current?.getBoundingClientRect()
      if (!rect || total <= 0) return
      const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
      seekTo(ratio * total)
    }
    function handleUp(): void {
      setScrubbingPreview(false)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [scrubbingPreview, total, seekTo])

  const [activeSrc, setActiveSrc] = useState<string | null>(null)
  // Long-lived closures (the rAF playback loop below) call loadClipForTime across many
  // renders without being recreated, so they'd otherwise compare against a stale
  // snapshot of `activeSrc` state. A ref is always current regardless of which
  // render's closure reads it, so use it for the actual comparison.
  const activeSrcRef = useRef<string | null>(null)

  function loadClipForTime(time: number, resumePlaying: boolean): void {
    const tc = findTimedClipAt(timedClips, time)
    activeTimedClipRef.current = tc
    if (!tc) {
      activeSrcRef.current = null
      setActiveSrc(null)
      setIsPlaying(false)
      return
    }
    const url = previewSourceUrl(tc.asset)
    const speed = tc.clip.speed || 1
    const localTime = tc.clip.inPoint + (time - tc.start) * speed
    if (activeSrcRef.current !== url) {
      activeSrcRef.current = url
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

  // Initial load, and recovery when the currently-loaded clip is removed from the
  // timeline (e.g. deleted) — otherwise the preview keeps playing the stale, now
  // detached clip until it happens to reach its old out-point.
  useEffect(() => {
    const activeId = activeTimedClipRef.current?.clip.id
    const activeStillPresent = activeId != null && timedClips.some((tc) => tc.clip.id === activeId)
    if (activeId != null && !activeStillPresent) {
      loadClipForTime(playheadTime, isPlaying)
      return
    }
    if (!activeTimedClipRef.current && timedClips.length > 0) {
      loadClipForTime(0, false)
      return
    }
    // The loaded clip's source file can change while it stays on the timeline: a
    // preview proxy finishing its transcode swaps the asset's playback path. Without
    // this the element keeps the old, undecodable src and never starts.
    const current = timedClips.find((tc) => tc.clip.id === activeId)
    if (current && previewSourceUrl(current.asset) !== activeSrcRef.current) {
      loadClipForTime(playheadTime, isPlaying)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timedClips])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!isPlaying) {
      video.pause()
      return
    }
    // The <video> may already have failed to decode before play was ever pressed, in
    // which case no further error event fires — the button would otherwise sit in its
    // "playing" state forever with nothing moving.
    if (video.error) {
      handleVideoError()
      return
    }
    video.play().catch(() => {
      if (videoRef.current?.error) handleVideoError()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // A clip whose audio was detached must not also play its embedded audio here —
  // the detached copy on the audio track supplies it, and both at once would double.
  const activeClipAudioDetached =
    findTimedClipAt(timedClips, playheadTime)?.clip.audioDetached ?? false

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = muted || activeClipAudioDetached
    }
  }, [volume, muted, activeSrc, activeClipAudioDetached])

  function stepFrame(direction: 1 | -1): void {
    // 1フレームぶんは素材のフレームレートで決まる。60fps の素材で 1/30 秒動かすと
    // 「1フレーム」と書いてあるのに2フレーム飛ぶ。書き出しと同じ関数から求める。
    const step = frameSeconds(project.clips, project.assets)
    const next = Math.max(0, Math.min(total, playheadTime + direction * step))
    seekTo(next)
  }

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
            {activeSrc && blurBackdrop && (
              <PreviewBlurBackdrop
                src={activeSrc}
                localTime={blurBackdrop.localTime}
                isPlaying={isPlaying}
                blurPx={blurBackdrop.blurPx}
              />
            )}
            {activeSrc ? (
              <video
                ref={videoRef}
                src={activeSrc}
                onEnded={() => setIsPlaying(false)}
                onError={handleVideoError}
                onLoadedMetadata={handleLoadedMetadata}
              />
            ) : (
              <div className="preview-empty">
                <ClapperboardIcon width={32} height={32} />
                <p>タイムラインにクリップを追加してください</p>
              </div>
            )}
            {playbackError && <div className="preview-playback-error">{playbackError}</div>}
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
                    frameWidth={frameWidth}
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
                : verticalAnchorStyle(o.style.position)
              const transforms: string[] = []
              if (livePos) transforms.push('translate(-50%, -50%)')
              else if (o.style.position === 'center') transforms.push('translateY(-50%)')
              if (o.style.rotation) transforms.push(`rotate(${o.style.rotation}deg)`)
              if (transforms.length > 0) positionStyle.transform = transforms.join(' ')
              return (
                <div
                  key={o.id}
                  className={`overlay-text ${livePos ? '' : `overlay-${o.style.position}`} anim-${o.style.animation}`}
                  style={{ ...overlayPreviewStyle(o.style, overlayScale), ...positionStyle }}
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
            {project.audioTracks.flatMap((track) =>
              track.clips
                .filter(
                  (c) =>
                    playheadTime >= c.startTime && playheadTime < c.startTime + audioClipDuration(c)
                )
                .map((clip) => {
                  const asset = project.assets.find((a) => a.id === clip.assetId)
                  if (!asset) return null
                  return (
                    <AudioTrackClipLayer
                      key={clip.id}
                      clip={clip}
                      asset={asset}
                      trackVolume={track.volume}
                      trackMuted={track.muted}
                      playheadTime={playheadTime}
                      isPlaying={isPlaying}
                      masterVolume={volume}
                      masterMuted={muted}
                    />
                  )
                })
            )}
          </div>
        </div>
        <div className="preview-controls">
          <div className="preview-scrub-row">
            <span className="time-label current">{formatTime(playheadTime)}</span>
            <div
              ref={scrubTrackRef}
              className={`scrub-track ${scrubbingPreview ? 'scrubbing' : ''}`}
              onMouseDown={(e) => {
                if (total <= 0) return
                const rect = e.currentTarget.getBoundingClientRect()
                const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
                seekTo(ratio * total)
                setScrubbingPreview(true)
              }}
            >
              <div
                className="scrub-fill"
                style={{
                  width: total > 0 ? `${Math.min(100, (playheadTime / total) * 100)}%` : '0%'
                }}
              />
            </div>
            <span className="time-label total">{formatTime(total)}</span>
          </div>
          <div className="preview-transport-row">
            <div className="transport-side transport-side-left">
              {project.aspectRatio === '9:16' && (
                <button
                  className={`icon-button ${showShortsUi ? 'active' : ''}`}
                  title="YouTube Shorts の実際の画面イメージを重ねて表示(いいね/コメントなどのUIに字幕が隠れないか確認できます)"
                  onClick={() => setShowShortsUi((v) => !v)}
                >
                  <YoutubeIcon width={14} height={14} />
                </button>
              )}
            </div>
            <div className="transport-center">
              <button
                className="icon-button"
                title="先頭へ"
                disabled={!activeSrc}
                onClick={() => seekTo(0)}
              >
                <SkipBackIcon width={14} height={14} />
              </button>
              <button
                className="icon-button"
                title="1フレーム戻る (←)"
                disabled={!activeSrc}
                onClick={() => stepFrame(-1)}
              >
                <StepBackIcon width={14} height={14} />
              </button>
              <button
                className="play-button"
                onClick={() => setIsPlaying(!isPlaying)}
                disabled={!activeSrc}
              >
                {isPlaying ? (
                  <PauseIcon width={16} height={16} />
                ) : (
                  <PlayIcon width={16} height={16} />
                )}
              </button>
              <button
                className="icon-button"
                title="1フレーム進む (→)"
                disabled={!activeSrc}
                onClick={() => stepFrame(1)}
              >
                <StepForwardIcon width={14} height={14} />
              </button>
              <button
                className="icon-button"
                title="末尾へ"
                disabled={!activeSrc}
                onClick={() => seekTo(total)}
              >
                <SkipForwardIcon width={14} height={14} />
              </button>
            </div>
            <div className="transport-side transport-side-right">
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
        </div>
      </div>
    </>
  )
}

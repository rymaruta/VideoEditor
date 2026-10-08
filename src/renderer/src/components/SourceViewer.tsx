import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { ASSET_DRAG_TYPE, SOURCE_RANGE_DRAG_TYPE } from '../lib/assetDrag'
import { previewSourceUrl } from '../lib/previewSource'
import { totalTimelineDuration, buildTimedClips } from '../lib/timelineMath'
import { waveformRenderSize, type WaveformSize } from '../lib/waveformSize'
import { isTimelineCovered, isTypingTarget } from '../lib/useKeyboardShortcuts'
import { Waveform } from './Waveform'
import { targetFrameRate } from '@shared/frameRate'
import {
  PlayIcon,
  PauseIcon,
  ClapperboardIcon,
  StepBackIcon,
  StepForwardIcon,
  ScissorsIcon,
  PlusIcon
} from './icons'

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00.00'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

/**
 * The "source" half of a two-up viewer: plays one asset on its own so a range can be
 * chosen before anything is committed to the timeline.
 *
 * Deliberately separate from PreviewPlayer. That component renders the assembled
 * program — overlays, PiP tracks, audio tracks, transitions — and its playback loop is
 * driven by the shared playhead. Auditioning a raw file has none of those concerns, and
 * threading a second mode through it would put the two on the same playhead.
 */
export function SourceViewer(): React.JSX.Element | null {
  const assets = useProjectStore((s) => s.project.assets)
  const project = useProjectStore((s) => s.project)
  const sourceAssetId = useProjectStore((s) => s.sourceAssetId)
  const sourceIn = useProjectStore((s) => s.sourceIn)
  const sourceOut = useProjectStore((s) => s.sourceOut)
  const setSourceIn = useProjectStore((s) => s.setSourceIn)
  const setSourceOut = useProjectStore((s) => s.setSourceOut)
  const closeSourceViewer = useProjectStore((s) => s.closeSourceViewer)
  const addTrimmedClipToTimeline = useProjectStore((s) => s.addTrimmedClipToTimeline)
  const insertClipAtTime = useProjectStore((s) => s.insertClipAtTime)
  const setDraggingAssetId = useProjectStore((s) => s.setDraggingAssetId)
  const overwriteClipAtTime = useProjectStore((s) => s.overwriteClipAtTime)
  const playheadTime = useProjectStore((s) => s.playheadTime)

  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [scrubbing, setScrubbing] = useState(false)
  const [waveSize, setWaveSize] = useState<WaveformSize | null>(null)

  const asset = assets.find((a) => a.id === sourceAssetId) ?? null
  const duration = asset?.duration ?? 0
  // ここは素材そのものを見ている画面なので、プロジェクト全体ではなくこの素材の
  // フレームレートで刻む。固定の 1/30 だと 60fps の素材で2フレーム飛んでいた。
  const frameStep = 1 / targetFrameRate(asset ? [asset.fps] : [])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (playing) {
      v.playbackRate = Math.abs(rate) || 1
      v.play().catch(() => setPlaying(false))
    } else {
      v.pause()
    }
  }, [playing, rate])

  // Reverse shuttle (J) has no native equivalent — <video> cannot play backwards — so
  // negative rates are stepped manually while forward rates use the element's own clock.
  useEffect(() => {
    if (!playing || rate >= 0) return
    const id = setInterval(() => {
      const v = videoRef.current
      if (!v) return
      const next = Math.max(0, v.currentTime + rate * 0.1)
      v.currentTime = next
      setTime(next)
      if (next <= 0) setPlaying(false)
    }, 100)
    return () => clearInterval(id)
  }, [playing, rate])

  useEffect(() => {
    if (!playing || rate < 0) return
    let frame: number
    const tick = (): void => {
      const v = videoRef.current
      if (v) setTime(v.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, rate])

  function seek(t: number): void {
    const clamped = Math.max(0, Math.min(duration, t))
    setTime(clamped)
    if (videoRef.current) videoRef.current.currentTime = clamped
  }

  // J/K/L: repeated presses ramp the shuttle speed, which is the whole point — one hand
  // stays on the keyboard while scanning footage at 1x/2x/4x in either direction.
  function shuttle(direction: -1 | 1): void {
    setRate((current) => {
      const sameDirection = Math.sign(current) === direction && playing
      const next = sameDirection ? Math.min(4, Math.abs(current) * 2) : 1
      return next * direction
    })
    setPlaying(true)
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (!asset) return
      // **モーダルが開いている間は、このパネルのキーも届かせない。**
      // ソースビューアはモーダルの裏に居るので、`f` は利用者が頼んでいない
      // クリップをタイムラインへ足し、`i`/`o` は見えていない範囲を書き換え、
      // `j`/`k`/`l` はダイアログの裏で音を鳴らし始める。
      // (実測: クリップ1本の企画でトリムのモーダルを開き `f` を押すと
      //  **クリップ 1 → 2 本・履歴 0 → 1件**。`i` で `sourceIn` が **未設定 → 0**、
      //  `l` で裏の映像が **paused=false・0.42 → 0.72秒**と進み出した。
      //  同じ場面の Delete は `isTimelineCovered` に守られて何も起きない)
      // 判定は**共有の関数を呼ぶ**。ここに書き写すと、次に門が増えたときも同じ取り残しが起きる。
      if (isTimelineCovered()) return
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'j') {
        e.preventDefault()
        shuttle(-1)
      } else if (key === 'k') {
        e.preventDefault()
        setPlaying(false)
        setRate(1)
      } else if (key === 'l') {
        e.preventDefault()
        shuttle(1)
      } else if (key === 'i') {
        e.preventDefault()
        setSourceIn(time)
      } else if (key === 'o') {
        e.preventDefault()
        setSourceOut(time)
      } else if (key === 'f') {
        e.preventDefault()
        appendToTimeline()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(() => {
    if (!scrubbing) return
    function handleMove(e: MouseEvent): void {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || duration <= 0) return
      seek(((e.clientX - rect.left) / rect.width) * duration)
    }
    function handleUp(): void {
      setScrubbing(false)
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  })

  // 波形は帯の実寸から作る。固定幅だと帯が広いときに引き伸ばされてぼやけ、
  // パネル幅は利用者がドラッグで変えられるので一度測って終わりにはできない。
  // 幅は `waveformRenderSize` が刻みへ切り上げるため、1px動かすたびの作り直しにはならない。
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el) {
      setWaveSize(null)
      return
    }
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      const next = waveformRenderSize(rect.width, rect.height)
      setWaveSize((prev) =>
        prev && next && prev.width === next.width && prev.height === next.height ? prev : next
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [sourceAssetId])

  if (!asset) return null

  // An unmarked edge means "from the start" / "to the end", matching how in/out points
  // behave in an NLE — you rarely need to mark both.
  const rangeStart = sourceIn ?? 0
  const rangeEnd = sourceOut ?? duration
  const rangeDuration = Math.max(0, rangeEnd - rangeStart)
  const timelineDuration = totalTimelineDuration(buildTimedClips(project))

  function appendToTimeline(): void {
    if (rangeDuration <= 0) return
    addTrimmedClipToTimeline(asset!.id, rangeStart, rangeEnd)
  }

  return (
    <div className="panel source-viewer">
      <div className="source-viewer-header">
        <h3>
          <ClapperboardIcon width={13} height={13} />
          ソース
          <span className="source-viewer-name" title={asset.fileName}>
            {asset.fileName}
          </span>
        </h3>
        <button className="small-button" onClick={closeSourceViewer} title="ソースビューアを閉じる">
          閉じる
        </button>
      </div>

      <div className="source-viewer-frame">
        <video
          ref={videoRef}
          src={previewSourceUrl(asset)}
          onLoadedMetadata={() => setTime(0)}
          onEnded={() => setPlaying(false)}
          // Keeps the displayed position honest when the element's clock moves without
          // going through seek() — buffering jumps, or the end of a reverse shuttle.
          onSeeked={(e) => setTime(e.currentTarget.currentTime)}
          onTimeUpdate={(e) => {
            if (!playing) setTime(e.currentTarget.currentTime)
          }}
        />
      </div>

      <div className="source-viewer-times">
        <span>{formatTime(time)}</span>
        {/* この帯をつまんでタイムラインへ落とすと、決めた範囲がそのままクリップになる。
            ボタン(末尾へ追加/インサート)と同じ操作を、置く場所を選びながらできる。 */}
        <span
          className="source-viewer-range"
          draggable={rangeDuration > 0}
          title="タイムラインへドラッグすると、この範囲を落とした位置に挿入します"
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'copy'
            e.dataTransfer.setData(
              SOURCE_RANGE_DRAG_TYPE,
              JSON.stringify({ assetId: asset.id, inPoint: rangeStart, outPoint: rangeEnd })
            )
            // 本編トラックの受け入れ判定は素材のドラッグと同じ仕組みに乗せる
            e.dataTransfer.setData(ASSET_DRAG_TYPE, asset.id)
            setDraggingAssetId(asset.id)
          }}
          onDragEnd={() => setDraggingAssetId(null)}
        >
          {sourceIn !== null || sourceOut !== null ? (
            <>
              イン {formatTime(rangeStart)} / アウト {formatTime(rangeEnd)} ・ 長さ{' '}
              {formatTime(rangeDuration)}
            </>
          ) : (
            <>範囲未指定(全体 {formatTime(duration)})</>
          )}
        </span>
        <span>{formatTime(duration)}</span>
      </div>

      <div
        className="source-viewer-track"
        ref={trackRef}
        onMouseDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          seek(((e.clientX - rect.left) / rect.width) * duration)
          setScrubbing(true)
        }}
      >
        {asset.hasAudio && waveSize && duration > 0 && (
          <div className="source-viewer-waveform">
            {/* 素材を切り替えたときは App.tsx が `key={sourceAssetId}` で
                このパネルごと作り直すので、前の素材の波形は残らない */}
            <Waveform
              filePath={asset.filePath}
              start={0}
              end={duration}
              width={waveSize.width}
              height={waveSize.height}
            />
          </div>
        )}
        {duration > 0 && rangeDuration > 0 && (
          <div
            className="source-viewer-selection"
            style={{
              left: `${(rangeStart / duration) * 100}%`,
              width: `${(rangeDuration / duration) * 100}%`
            }}
          />
        )}
        <div
          className="source-viewer-playhead"
          style={{ left: `${duration > 0 ? (time / duration) * 100 : 0}%` }}
        />
      </div>

      <div className="source-viewer-transport">
        <button
          className="icon-button"
          onClick={() => seek(time - frameStep)}
          title="1フレーム戻る"
        >
          <StepBackIcon width={13} height={13} />
        </button>
        <button
          className={`icon-button ${playing && rate < 0 ? 'active' : ''}`}
          onClick={() => shuttle(-1)}
          title="逆再生 (J) — 連打で2倍4倍"
        >
          J
        </button>
        <button
          className="icon-button play-button"
          onClick={() => (playing ? (setPlaying(false), setRate(1)) : shuttle(1))}
          title="再生 / 停止 (K)"
        >
          {playing ? <PauseIcon width={14} height={14} /> : <PlayIcon width={14} height={14} />}
        </button>
        <button
          className={`icon-button ${playing && rate > 0 ? 'active' : ''}`}
          onClick={() => shuttle(1)}
          title="順再生 (L) — 連打で2倍4倍"
        >
          L
        </button>
        <button
          className="icon-button"
          onClick={() => seek(time + frameStep)}
          title="1フレーム進む"
        >
          <StepForwardIcon width={13} height={13} />
        </button>
        {playing && Math.abs(rate) > 1 && <span className="source-viewer-rate">{rate}x</span>}
      </div>

      <div className="source-viewer-marks">
        <button
          className="small-button"
          onClick={() => setSourceIn(time)}
          title="イン点をマーク (I)"
        >
          <ScissorsIcon width={12} height={12} />I イン点
        </button>
        <button
          className="small-button"
          onClick={() => setSourceOut(time)}
          title="アウト点をマーク (O)"
        >
          <ScissorsIcon width={12} height={12} />O アウト点
        </button>
        <button
          className="small-button"
          onClick={() => {
            setSourceIn(null)
            setSourceOut(null)
          }}
          disabled={sourceIn === null && sourceOut === null}
        >
          範囲を解除
        </button>
      </div>

      <div className="source-viewer-actions">
        <button
          className="primary-button"
          onClick={appendToTimeline}
          disabled={rangeDuration <= 0}
          title="タイムラインの末尾に追加 (F)"
        >
          <PlusIcon width={13} height={13} />
          末尾に追加 (F)
        </button>
        <button
          className="small-button"
          onClick={() => insertClipAtTime(asset.id, rangeStart, rangeEnd, playheadTime)}
          disabled={rangeDuration <= 0}
          title="再生位置で切って割り込ませる。以降のクリップは後ろにずれます"
        >
          挿入
        </button>
        <button
          className="small-button"
          onClick={() => overwriteClipAtTime(asset.id, rangeStart, rangeEnd, playheadTime)}
          disabled={rangeDuration <= 0}
          title="再生位置から同じ長さ分を置き換える。以降のクリップの位置は変わりません"
        >
          上書き
        </button>
      </div>
      <p className="hint-text">
        挿入・上書きはタイムラインの再生位置({formatTime(playheadTime)} / 全体{' '}
        {formatTime(timelineDuration)})を基準にします。
      </p>
    </div>
  )
}

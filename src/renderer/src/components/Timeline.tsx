import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { buildTimedClips, totalTimelineDuration } from '../lib/timelineMath'
import { TrimModal } from './TrimModal'
import { SilenceCutModal } from './SilenceCutModal'
import { AutoCaptionModal } from './AutoCaptionModal'
import { Waveform } from './Waveform'
import { isAspectMismatch } from '../lib/aspect'
import type { TransitionType } from '@shared/types'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ScissorsIcon,
  TrashIcon,
  PlusIcon,
  GaugeIcon,
  LayersIcon,
  Volume2Icon,
  VolumeXIcon,
  WandIcon,
  TypeIcon,
  MicIcon,
  CopyIcon,
  ClipboardPasteIcon,
  ZoomInIcon,
  ZoomOutIcon,
  AlertTriangleIcon
} from './icons'

const BASE_PIXELS_PER_SECOND = 40
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

export function Timeline(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const selectClip = useProjectStore((s) => s.selectClip)
  const seekTo = useProjectStore((s) => s.seekTo)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const removeClip = useProjectStore((s) => s.removeClip)
  const moveClip = useProjectStore((s) => s.moveClip)
  const moveClipToIndex = useProjectStore((s) => s.moveClipToIndex)
  const splitClipAtTime = useProjectStore((s) => s.splitClipAtTime)
  const updateClipSpeed = useProjectStore((s) => s.updateClipSpeed)
  const updateClipTransition = useProjectStore((s) => s.updateClipTransition)
  const addAudioTrack = useProjectStore((s) => s.addAudioTrack)
  const removeAudioTrack = useProjectStore((s) => s.removeAudioTrack)
  const toggleAudioTrackMute = useProjectStore((s) => s.toggleAudioTrackMute)
  const setAudioTrackVolume = useProjectStore((s) => s.setAudioTrackVolume)
  const updateAudioClipStart = useProjectStore((s) => s.updateAudioClipStart)
  const removeAudioClip = useProjectStore((s) => s.removeAudioClip)
  const copySelectedClip = useProjectStore((s) => s.copySelectedClip)
  const pasteClip = useProjectStore((s) => s.pasteClip)
  const clipboardClip = useProjectStore((s) => s.clipboardClip)

  const [trimClipId, setTrimClipId] = useState<string | null>(null)
  const [silenceCutClipId, setSilenceCutClipId] = useState<string | null>(null)
  const [autoCaptionClipId, setAutoCaptionClipId] = useState<string | null>(null)
  const [selectedAudioClip, setSelectedAudioClip] = useState<{
    trackId: string
    clipId: string
  } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom
  const timedClips = buildTimedClips(project)
  const total = totalTimelineDuration(timedClips)
  const timelineWidth = Math.max(total * pixelsPerSecond, 400)
  const selectedIndex = timedClips.findIndex((tc) => tc.clip.id === selectedClipId)
  const selectedClip = selectedIndex >= 0 ? timedClips[selectedIndex].clip : null

  function handleTrackClick(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = Math.max(0, Math.min(total, x / pixelsPerSecond))
    seekTo(time)
  }

  function handleWheelZoom(e: React.WheelEvent<HTMLDivElement>): void {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.1 : 0.9))))
  }

  const selectedAudioClipData =
    selectedAudioClip &&
    project.audioTracks
      .find((t) => t.id === selectedAudioClip.trackId)
      ?.clips.find((c) => c.id === selectedAudioClip.clipId)

  return (
    <div className="panel timeline-panel">
      <div className="panel-header">
        <h2>タイムライン</h2>
        <div className="timeline-zoom">
          <button
            className="icon-button"
            title="縮小"
            onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.4))}
          >
            <ZoomOutIcon width={13} height={13} />
          </button>
          <span className="hint-text zoom-label">{Math.round(zoom * 100)}%</span>
          <button
            className="icon-button"
            title="拡大"
            onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.4))}
          >
            <ZoomInIcon width={13} height={13} />
          </button>
        </div>
        {selectedClip && (
          <div className="timeline-actions">
            <button
              className="icon-button"
              title="左に移動"
              onClick={() => moveClip(selectedClip.id, 'left')}
            >
              <ChevronLeftIcon width={14} height={14} />
            </button>
            <button
              className="icon-button"
              title="右に移動"
              onClick={() => moveClip(selectedClip.id, 'right')}
            >
              <ChevronRightIcon width={14} height={14} />
            </button>
            <button className="small-button" onClick={() => setTrimClipId(selectedClip.id)}>
              トリム
            </button>
            <button
              className="small-button"
              onClick={() => splitClipAtTime(selectedClip.id, playheadTime)}
            >
              <ScissorsIcon width={13} height={13} />
              カット
            </button>
            <button className="small-button" onClick={() => setSilenceCutClipId(selectedClip.id)}>
              <WandIcon width={13} height={13} />
              無音カット
            </button>
            <button className="small-button" onClick={() => setAutoCaptionClipId(selectedClip.id)}>
              <MicIcon width={13} height={13} />
              自動テロップ
            </button>
            <label className="inline-select">
              <GaugeIcon width={13} height={13} />
              <select
                value={selectedClip.speed || 1}
                onChange={(e) => updateClipSpeed(selectedClip.id, Number(e.target.value))}
              >
                {SPEED_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </select>
            </label>
            {selectedIndex > 0 && (
              <>
                <label className="inline-select">
                  <LayersIcon width={13} height={13} />
                  <select
                    value={selectedClip.transitionIn?.type ?? 'none'}
                    onChange={(e) =>
                      updateClipTransition(
                        selectedClip.id,
                        e.target.value === 'none'
                          ? undefined
                          : {
                              type: e.target.value as TransitionType,
                              duration: selectedClip.transitionIn?.duration ?? 0.5
                            }
                      )
                    }
                  >
                    <option value="none">カット</option>
                    <option value="crossfade">クロスフェード</option>
                    <option value="fade">フェード</option>
                    <option value="wipe">ワイプ</option>
                  </select>
                </label>
                {selectedClip.transitionIn && (
                  <input
                    className="transition-duration"
                    type="number"
                    min={0.1}
                    max={2}
                    step={0.1}
                    value={selectedClip.transitionIn.duration}
                    onChange={(e) =>
                      updateClipTransition(selectedClip.id, {
                        type: selectedClip.transitionIn?.type ?? 'crossfade',
                        duration: Number(e.target.value)
                      })
                    }
                    title="トランジション秒数"
                  />
                )}
              </>
            )}
            <button
              className="icon-button"
              title="コピー (Ctrl+C)"
              onClick={() => copySelectedClip()}
            >
              <CopyIcon width={13} height={13} />
            </button>
            <button
              className="icon-button danger"
              title="削除"
              onClick={() => removeClip(selectedClip.id)}
            >
              <TrashIcon width={14} height={14} />
            </button>
          </div>
        )}
        {clipboardClip && (
          <button className="small-button" title="貼り付け (Ctrl+V)" onClick={() => pasteClip()}>
            <ClipboardPasteIcon width={13} height={13} />
            貼り付け
          </button>
        )}
      </div>

      <div className="timeline-tracks">
        <div className="track-labels-col">
          <div className="track-label track-label-video">動画</div>
          {project.audioTracks.map((track) => (
            <div key={track.id} className="track-label">
              <span className="track-label-name" title={track.name}>
                {track.name}
              </span>
              <div className="track-label-controls">
                <button
                  className="icon-button"
                  title={track.muted ? 'ミュート解除' : 'ミュート'}
                  onClick={() => toggleAudioTrackMute(track.id)}
                >
                  {track.muted ? (
                    <VolumeXIcon width={13} height={13} />
                  ) : (
                    <Volume2Icon width={13} height={13} />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={track.volume}
                  onChange={(e) => setAudioTrackVolume(track.id, Number(e.target.value))}
                />
                <button
                  className="icon-button danger"
                  title="トラック削除"
                  onClick={() => removeAudioTrack(track.id)}
                >
                  <TrashIcon width={12} height={12} />
                </button>
              </div>
            </div>
          ))}
          {project.textOverlays.length > 0 && (
            <div className="track-label">
              <span className="track-label-name">
                <TypeIcon width={12} height={12} />
                テロップ
              </span>
            </div>
          )}
          <button
            className="small-button add-track-button"
            onClick={() => addAudioTrack(`音声トラック ${project.audioTracks.length + 1}`)}
          >
            <PlusIcon width={12} height={12} />
            音声トラック
          </button>
        </div>

        <div className="track-lanes-col" onWheel={handleWheelZoom}>
          <div
            className="track-lane video-lane"
            style={{ width: timelineWidth }}
            onClick={handleTrackClick}
          >
            {timedClips.map((tc, i) => {
              const clipWidth = (tc.end - tc.start) * pixelsPerSecond
              return (
                <div
                  key={tc.clip.id}
                  className={`timeline-clip ${selectedClipId === tc.clip.id ? 'selected' : ''} ${
                    draggedClipId === tc.clip.id ? 'dragging' : ''
                  } ${dragOverIndex === i && draggedClipId && draggedClipId !== tc.clip.id ? 'drag-over' : ''}`}
                  style={{ width: clipWidth }}
                  draggable
                  onClick={(e) => {
                    e.stopPropagation()
                    selectClip(tc.clip.id)
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    setDraggedClipId(tc.clip.id)
                  }}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    setDragOverIndex(i)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (draggedClipId) moveClipToIndex(draggedClipId, i)
                    setDraggedClipId(null)
                    setDragOverIndex(null)
                  }}
                  onDragEnd={() => {
                    setDraggedClipId(null)
                    setDragOverIndex(null)
                  }}
                >
                  {tc.clip.transitionIn && i > 0 && <span className="transition-marker" />}
                  <span className="timeline-clip-index">{i + 1}</span>
                  <span className="timeline-clip-label" title={tc.asset.fileName}>
                    {tc.asset.fileName}
                    {tc.clip.speed !== 1 && ` (${tc.clip.speed}x)`}
                  </span>
                  {isAspectMismatch(tc.asset, project.aspectRatio) && (
                    <span
                      className="timeline-mismatch-icon"
                      title="プロジェクトのアスペクト比と異なるため黒帯が入ります"
                    >
                      <AlertTriangleIcon width={11} height={11} />
                    </span>
                  )}
                  {tc.asset.hasAudio && clipWidth > 24 && (
                    <div className="timeline-clip-waveform">
                      <Waveform
                        filePath={tc.asset.filePath}
                        start={tc.clip.inPoint}
                        end={tc.clip.outPoint}
                        width={clipWidth}
                        height={28}
                      />
                    </div>
                  )}
                </div>
              )
            })}
            {timedClips.length === 0 && (
              <p className="hint-text timeline-empty-hint">
                メディアからクリップを追加してください
              </p>
            )}
            <div
              className="timeline-playhead"
              style={{ left: Math.min(playheadTime, total) * pixelsPerSecond }}
            >
              <div className="timeline-playhead-handle" />
            </div>
          </div>

          {project.audioTracks.map((track) => (
            <div key={track.id} className="track-lane audio-lane" style={{ width: timelineWidth }}>
              {track.clips.map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.assetId)
                if (!asset) return null
                const dur = clip.outPoint - clip.inPoint
                const clipWidth = dur * pixelsPerSecond
                return (
                  <div
                    key={clip.id}
                    className={`timeline-audio-clip ${
                      selectedAudioClip?.clipId === clip.id ? 'selected' : ''
                    }`}
                    style={{
                      left: clip.startTime * pixelsPerSecond,
                      width: clipWidth
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedAudioClip({ trackId: track.id, clipId: clip.id })
                    }}
                    title={asset.fileName}
                  >
                    <span className="timeline-audio-clip-label">{asset.fileName}</span>
                    {clipWidth > 24 && (
                      <div className="timeline-clip-waveform">
                        <Waveform
                          filePath={asset.filePath}
                          start={clip.inPoint}
                          end={clip.outPoint}
                          width={clipWidth}
                          height={30}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ))}

          {project.textOverlays.length > 0 && (
            <div className="track-lane caption-lane" style={{ width: timelineWidth }}>
              {project.textOverlays.map((overlay) => (
                <div
                  key={overlay.id}
                  className={`timeline-caption-clip ${overlay.source === 'auto' ? 'auto' : ''}`}
                  style={{
                    left: overlay.startTime * pixelsPerSecond,
                    width: Math.max(4, (overlay.endTime - overlay.startTime) * pixelsPerSecond)
                  }}
                  title={overlay.text}
                >
                  {overlay.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {selectedAudioClipData && selectedAudioClip && (
        <div className="audio-clip-inspector">
          <label>
            開始位置(秒)
            <input
              type="number"
              step={0.1}
              min={0}
              value={selectedAudioClipData.startTime}
              onChange={(e) =>
                updateAudioClipStart(
                  selectedAudioClip.trackId,
                  selectedAudioClip.clipId,
                  Number(e.target.value)
                )
              }
            />
          </label>
          <button
            className="icon-button danger"
            onClick={() => {
              removeAudioClip(selectedAudioClip.trackId, selectedAudioClip.clipId)
              setSelectedAudioClip(null)
            }}
          >
            <TrashIcon width={13} height={13} />
          </button>
        </div>
      )}

      {trimClipId && <TrimModal clipId={trimClipId} onClose={() => setTrimClipId(null)} />}
      {silenceCutClipId && (
        <SilenceCutModal clipId={silenceCutClipId} onClose={() => setSilenceCutClipId(null)} />
      )}
      {autoCaptionClipId && (
        <AutoCaptionModal clipId={autoCaptionClipId} onClose={() => setAutoCaptionClipId(null)} />
      )}
    </div>
  )
}

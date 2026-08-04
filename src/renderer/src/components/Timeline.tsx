import { useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import { buildTimedClips, totalTimelineDuration } from '../lib/timelineMath'
import { snapTime } from '../lib/snapping'
import {
  SHORTCUT_ACTIONS,
  getActionLabel,
  getKeymap,
  KEYMAP_SCHEME_LABELS,
  type KeymapScheme
} from '../lib/keymap'
import { TrimModal } from './TrimModal'
import { SilenceCutModal } from './SilenceCutModal'
import { FillerWordCutModal } from './FillerWordCutModal'
import { AutoCaptionModal } from './AutoCaptionModal'
import { TextBasedEditModal } from './TextBasedEditModal'
import { Waveform } from './Waveform'
import { isAspectMismatch } from '../lib/aspect'
import { formatIpcError } from '../lib/ipcError'
import type { AudioTrack, Clip, TransitionType } from '@shared/types'
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
  DuckingIcon,
  WandIcon,
  FillerWordIcon,
  TypeIcon,
  MicIcon,
  CopyIcon,
  ClipboardPasteIcon,
  ZoomInIcon,
  ZoomOutIcon,
  AlertTriangleIcon,
  ActivityIcon
} from './icons'

const BASE_PIXELS_PER_SECOND = 40
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const MIN_CLIP_SOURCE_DURATION = 0.2
const SNAP_PIXELS = 8

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

interface TrimDragState {
  clipId: string
  edge: 'left' | 'right'
  startX: number
  clipStartInTimeline: number
  originalInPoint: number
  originalOutPoint: number
  assetDuration: number
  speed: number
  liveInPoint: number
  liveOutPoint: number
  snapGuideTime: number | null
}

interface AudioDragState {
  trackId: string
  clipId: string
  startX: number
  duration: number
  originalStartTime: number
  liveStartTime: number
  snapGuideTime: number | null
}

export function Timeline(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const selectClip = useProjectStore((s) => s.selectClip)
  const multiSelectedClipIds = useProjectStore((s) => s.multiSelectedClipIds)
  const setMultiSelectedClipIds = useProjectStore((s) => s.setMultiSelectedClipIds)
  const removeClips = useProjectStore((s) => s.removeClips)
  const updateClipsSpeed = useProjectStore((s) => s.updateClipsSpeed)
  const seekTo = useProjectStore((s) => s.seekTo)
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const removeClip = useProjectStore((s) => s.removeClip)
  const moveClip = useProjectStore((s) => s.moveClip)
  const moveClipToIndex = useProjectStore((s) => s.moveClipToIndex)
  const splitClipAtTime = useProjectStore((s) => s.splitClipAtTime)
  const updateClipSpeed = useProjectStore((s) => s.updateClipSpeed)
  const updateClipTransition = useProjectStore((s) => s.updateClipTransition)
  const updateClipTrim = useProjectStore((s) => s.updateClipTrim)
  const addAudioTrack = useProjectStore((s) => s.addAudioTrack)
  const removeAudioTrack = useProjectStore((s) => s.removeAudioTrack)
  const toggleAudioTrackMute = useProjectStore((s) => s.toggleAudioTrackMute)
  const toggleAudioTrackDucking = useProjectStore((s) => s.toggleAudioTrackDucking)
  const setAudioTrackVolume = useProjectStore((s) => s.setAudioTrackVolume)
  const updateAudioClipStart = useProjectStore((s) => s.updateAudioClipStart)
  const updateAudioClipVolume = useProjectStore((s) => s.updateAudioClipVolume)
  const swapAudioClipAsset = useProjectStore((s) => s.swapAudioClipAsset)
  const removeAudioClip = useProjectStore((s) => s.removeAudioClip)
  const copySelectedClip = useProjectStore((s) => s.copySelectedClip)
  const pasteClip = useProjectStore((s) => s.pasteClip)
  const clipboardClips = useProjectStore((s) => s.clipboardClips)
  const setBeatGrid = useProjectStore((s) => s.setBeatGrid)
  const clearBeatGrid = useProjectStore((s) => s.clearBeatGrid)
  const toggleBeatGridEnabled = useProjectStore((s) => s.toggleBeatGridEnabled)
  const keymapScheme = useSettingsStore((s) => s.keymapScheme)
  const setKeymapScheme = useSettingsStore((s) => s.setKeymapScheme)
  const keymap = getKeymap(keymapScheme)

  const [trimClipId, setTrimClipId] = useState<string | null>(null)
  const [silenceCutClipId, setSilenceCutClipId] = useState<string | null>(null)
  const [fillerWordClipId, setFillerWordClipId] = useState<string | null>(null)
  const [autoCaptionClipId, setAutoCaptionClipId] = useState<string | null>(null)
  const [textEditClipId, setTextEditClipId] = useState<string | null>(null)
  const [bpmAnalyzingTrackId, setBpmAnalyzingTrackId] = useState<string | null>(null)
  const [bpmError, setBpmError] = useState<string | null>(null)
  const [selectedAudioClip, setSelectedAudioClip] = useState<{
    trackId: string
    clipId: string
  } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null)
  const [audioDrag, setAudioDrag] = useState<AudioDragState | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const videoLaneRef = useRef<HTMLDivElement>(null)
  const lastClickedClipIndexRef = useRef<number | null>(null)

  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom

  const baseTimedClips = useMemo(() => buildTimedClips(project), [project])

  const snapCandidates = useMemo(() => {
    const times: number[] = [0, playheadTime]
    baseTimedClips.forEach((tc) => {
      times.push(tc.start, tc.end)
    })
    project.audioTracks.forEach((track) => {
      track.clips.forEach((c) => {
        times.push(c.startTime, c.startTime + (c.outPoint - c.inPoint))
      })
    })
    project.textOverlays.forEach((o) => {
      times.push(o.startTime, o.endTime)
    })
    return times
  }, [baseTimedClips, playheadTime, project.audioTracks, project.textOverlays])

  const beatTimes = useMemo(() => {
    const grid = project.beatGrid
    if (!grid || !grid.enabled || grid.bpm <= 0) return []
    const interval = 60 / grid.bpm
    const maxTime = Math.max(30, ...snapCandidates) + interval
    let phase = grid.offsetSeconds % interval
    if (phase < 0) phase += interval
    const times: number[] = []
    for (let t = phase; t <= maxTime; t += interval) {
      times.push(t)
    }
    return times
  }, [project.beatGrid, snapCandidates])

  const snapCandidatesWithBeat = useMemo(
    () => [...snapCandidates, ...beatTimes],
    [snapCandidates, beatTimes]
  )

  useEffect(() => {
    if (!trimDrag) return
    function handleMouseMove(e: MouseEvent): void {
      setTrimDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = ((e.clientX - prev.startX) / pixelsPerSecond) * prev.speed
        let liveInPoint = prev.originalInPoint
        let liveOutPoint = prev.originalOutPoint
        if (prev.edge === 'left') {
          liveInPoint = Math.min(
            Math.max(0, prev.originalInPoint + deltaSeconds),
            prev.originalOutPoint - MIN_CLIP_SOURCE_DURATION
          )
        } else {
          liveOutPoint = Math.max(
            Math.min(prev.assetDuration, prev.originalOutPoint + deltaSeconds),
            prev.originalInPoint + MIN_CLIP_SOURCE_DURATION
          )
        }
        const rawTcEnd = prev.clipStartInTimeline + (liveOutPoint - liveInPoint) / prev.speed
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const { time: snappedTcEnd, snapped } = snapTime(
          rawTcEnd,
          snapCandidatesWithBeat,
          thresholdSeconds
        )
        if (snapped) {
          const snappedDuration = snappedTcEnd - prev.clipStartInTimeline
          if (prev.edge === 'left') {
            liveInPoint = Math.min(
              Math.max(0, liveOutPoint - snappedDuration * prev.speed),
              liveOutPoint - MIN_CLIP_SOURCE_DURATION
            )
          } else {
            liveOutPoint = Math.max(
              Math.min(prev.assetDuration, liveInPoint + snappedDuration * prev.speed),
              liveInPoint + MIN_CLIP_SOURCE_DURATION
            )
          }
        }
        return { ...prev, liveInPoint, liveOutPoint, snapGuideTime: snapped ? snappedTcEnd : null }
      })
    }
    function handleMouseUp(): void {
      setTrimDrag((prev) => {
        if (prev) updateClipTrim(prev.clipId, prev.liveInPoint, prev.liveOutPoint)
        return null
      })
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [trimDrag, pixelsPerSecond, updateClipTrim, snapCandidatesWithBeat])

  useEffect(() => {
    if (!audioDrag) return
    function handleMouseMove(e: MouseEvent): void {
      setAudioDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = (e.clientX - prev.startX) / pixelsPerSecond
        const rawStart = Math.max(0, prev.originalStartTime + deltaSeconds)
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const startSnap = snapTime(rawStart, snapCandidatesWithBeat, thresholdSeconds)
        if (startSnap.snapped) {
          return { ...prev, liveStartTime: startSnap.time, snapGuideTime: startSnap.time }
        }
        const endSnap = snapTime(rawStart + prev.duration, snapCandidatesWithBeat, thresholdSeconds)
        if (endSnap.snapped) {
          return {
            ...prev,
            liveStartTime: Math.max(0, endSnap.time - prev.duration),
            snapGuideTime: endSnap.time
          }
        }
        return { ...prev, liveStartTime: rawStart, snapGuideTime: null }
      })
    }
    function handleMouseUp(): void {
      setAudioDrag((prev) => {
        if (prev) updateAudioClipStart(prev.trackId, prev.clipId, prev.liveStartTime)
        return null
      })
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [audioDrag, pixelsPerSecond, updateAudioClipStart, snapCandidatesWithBeat])

  function beginTrimDrag(
    e: React.MouseEvent,
    edge: 'left' | 'right',
    clip: Clip,
    assetDuration: number,
    clipStartInTimeline: number
  ): void {
    e.stopPropagation()
    e.preventDefault()
    setTrimDrag({
      clipId: clip.id,
      edge,
      startX: e.clientX,
      clipStartInTimeline,
      snapGuideTime: null,
      originalInPoint: clip.inPoint,
      originalOutPoint: clip.outPoint,
      assetDuration,
      speed: clip.speed || 1,
      liveInPoint: clip.inPoint,
      liveOutPoint: clip.outPoint
    })
  }

  const previewProject = trimDrag
    ? {
        ...project,
        clips: project.clips.map((c) =>
          c.id === trimDrag.clipId
            ? { ...c, inPoint: trimDrag.liveInPoint, outPoint: trimDrag.liveOutPoint }
            : c
        )
      }
    : project
  const timedClips = buildTimedClips(previewProject)
  const total = totalTimelineDuration(timedClips)
  const timelineWidth = Math.max(total * pixelsPerSecond, 400)
  const selectedIndex = timedClips.findIndex((tc) => tc.clip.id === selectedClipId)
  const selectedClip = selectedIndex >= 0 ? timedClips[selectedIndex].clip : null
  const activeSnapGuideTime = trimDrag?.snapGuideTime ?? audioDrag?.snapGuideTime ?? null

  useEffect(() => {
    if (!scrubbing) return
    function handleMove(e: MouseEvent): void {
      const rect = videoLaneRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const time = Math.max(0, Math.min(total, x / pixelsPerSecond))
      seekTo(time)
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
  }, [scrubbing, total, pixelsPerSecond, seekTo])

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

  async function handleAnalyzeBpm(track: AudioTrack): Promise<void> {
    const clip = track.clips[0]
    if (!clip) return
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (!asset) return
    setBpmAnalyzingTrackId(track.id)
    setBpmError(null)
    try {
      const result = await window.api.analyzeBpm(
        asset.filePath,
        clip.inPoint,
        clip.outPoint - clip.inPoint
      )
      setBeatGrid({
        bpm: result.bpm,
        offsetSeconds: clip.startTime + result.offsetSeconds,
        enabled: true,
        sourceLabel: track.name
      })
    } catch (e) {
      setBpmError(formatIpcError(e))
    } finally {
      setBpmAnalyzingTrackId(null)
    }
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
        {project.beatGrid && (
          <div className="beat-grid-info" title={`解析元: ${project.beatGrid.sourceLabel}`}>
            <button
              className={`icon-button ${project.beatGrid.enabled ? 'active' : ''}`}
              title={
                project.beatGrid.enabled
                  ? 'ビートグリッドを非表示(スナップも無効化)'
                  : 'ビートグリッドを表示(スナップも有効化)'
              }
              onClick={() => toggleBeatGridEnabled()}
            >
              <ActivityIcon width={13} height={13} />
            </button>
            <span className="beat-grid-bpm">{project.beatGrid.bpm} BPM</span>
            <button
              className="icon-button danger"
              title="ビートグリッドを削除"
              onClick={() => clearBeatGrid()}
            >
              <TrashIcon width={12} height={12} />
            </button>
          </div>
        )}
        {multiSelectedClipIds.length > 1 && (
          <div className="timeline-actions bulk-actions">
            <span className="hint-text">{multiSelectedClipIds.length}個選択中</span>
            <label className="inline-select">
              <GaugeIcon width={13} height={13} />
              <select
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return
                  updateClipsSpeed(multiSelectedClipIds, Number(e.target.value))
                }}
              >
                <option value="" disabled>
                  速度を一括変更
                </option>
                {SPEED_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}x
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button"
              title={`コピー (${keymap.copy.display})`}
              onClick={() => copySelectedClip()}
            >
              <CopyIcon width={13} height={13} />
            </button>
            <button
              className="small-button danger"
              title="選択したクリップをまとめて削除"
              onClick={() => removeClips(multiSelectedClipIds)}
            >
              <TrashIcon width={13} height={13} />
              まとめて削除
            </button>
          </div>
        )}
        {multiSelectedClipIds.length <= 1 && selectedClip && (
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
              title={`分割 (${keymap.split.display})`}
              onClick={() => splitClipAtTime(selectedClip.id, playheadTime)}
            >
              <ScissorsIcon width={13} height={13} />
              カット
            </button>
            <button className="small-button" onClick={() => setSilenceCutClipId(selectedClip.id)}>
              <WandIcon width={13} height={13} />
              無音カット
            </button>
            <button className="small-button" onClick={() => setFillerWordClipId(selectedClip.id)}>
              <FillerWordIcon width={13} height={13} />
              フィラーカット
            </button>
            <button className="small-button" onClick={() => setAutoCaptionClipId(selectedClip.id)}>
              <MicIcon width={13} height={13} />
              自動テロップ
            </button>
            <button className="small-button" onClick={() => setTextEditClipId(selectedClip.id)}>
              <TypeIcon width={13} height={13} />
              テキストで編集
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
              title={`コピー (${keymap.copy.display})`}
              onClick={() => copySelectedClip()}
            >
              <CopyIcon width={13} height={13} />
            </button>
            <button
              className="icon-button danger"
              title={`削除 (${keymap.delete.display})`}
              onClick={() => removeClip(selectedClip.id)}
            >
              <TrashIcon width={14} height={14} />
            </button>
          </div>
        )}
        {clipboardClips.length > 0 && (
          <button
            className="small-button"
            title={`貼り付け (${keymap.paste.display})`}
            onClick={() => pasteClip()}
          >
            <ClipboardPasteIcon width={13} height={13} />
            貼り付け{clipboardClips.length > 1 ? `(${clipboardClips.length}個)` : ''}
          </button>
        )}
      </div>

      <div className="timeline-shortcut-bar">
        <div className="timeline-shortcut-hints">
          {SHORTCUT_ACTIONS.map((action) => (
            <span key={action} className="shortcut-hint">
              {getActionLabel(action)}
              <kbd>{keymap[action].display}</kbd>
            </span>
          ))}
          <span className="shortcut-hint">
            1フレーム移動
            <kbd>←/→</kbd>
          </span>
        </div>
        <label className="inline-select keymap-select" title="キーボードショートカットの配置">
          <select
            value={keymapScheme}
            onChange={(e) => setKeymapScheme(e.target.value as KeymapScheme)}
          >
            {Object.entries(KEYMAP_SCHEME_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {bpmError && <p className="error-text timeline-bpm-error">{bpmError}</p>}

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
                  title="このトラックの音声からBPMを解析してビートグリッドを表示"
                  disabled={bpmAnalyzingTrackId === track.id || track.clips.length === 0}
                  onClick={() => handleAnalyzeBpm(track)}
                >
                  {bpmAnalyzingTrackId === track.id ? '…' : <ActivityIcon width={13} height={13} />}
                </button>
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
                <button
                  className={`icon-button ${track.duckingEnabled ? 'active' : ''}`}
                  title="他の音声(ナレーション/本編)がある時にこのトラックの音量を自動で下げる"
                  onClick={() => toggleAudioTrackDucking(track.id)}
                >
                  <DuckingIcon width={13} height={13} />
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
          {project.beatGrid?.enabled &&
            beatTimes.map((t, i) => (
              <div key={i} className="timeline-beat-line" style={{ left: t * pixelsPerSecond }} />
            ))}
          {activeSnapGuideTime !== null && (
            <div
              className="timeline-snap-guide"
              style={{ left: activeSnapGuideTime * pixelsPerSecond }}
            />
          )}
          <div
            ref={videoLaneRef}
            className="track-lane video-lane"
            style={{ width: timelineWidth }}
            onClick={handleTrackClick}
          >
            {timedClips.map((tc, i) => {
              const clipWidth = (tc.end - tc.start) * pixelsPerSecond
              return (
                <div
                  key={tc.clip.id}
                  className={`timeline-clip ${
                    selectedClipId === tc.clip.id || multiSelectedClipIds.includes(tc.clip.id)
                      ? 'selected'
                      : ''
                  } ${draggedClipId === tc.clip.id ? 'dragging' : ''} ${
                    dragOverIndex === i && draggedClipId && draggedClipId !== tc.clip.id
                      ? 'drag-over'
                      : ''
                  } ${trimDrag?.clipId === tc.clip.id ? 'trimming' : ''}`}
                  style={{ width: clipWidth }}
                  draggable
                  onClick={(e) => {
                    e.stopPropagation()
                    if (e.shiftKey && lastClickedClipIndexRef.current !== null) {
                      const lo = Math.min(lastClickedClipIndexRef.current, i)
                      const hi = Math.max(lastClickedClipIndexRef.current, i)
                      const ids = timedClips.slice(lo, hi + 1).map((t) => t.clip.id)
                      selectClip(tc.clip.id)
                      setMultiSelectedClipIds(ids)
                    } else if (e.metaKey || e.ctrlKey) {
                      const exists = multiSelectedClipIds.includes(tc.clip.id)
                      const next = exists
                        ? multiSelectedClipIds.filter((id) => id !== tc.clip.id)
                        : [...multiSelectedClipIds, tc.clip.id]
                      selectClip(next.length > 0 ? next[next.length - 1] : null)
                      setMultiSelectedClipIds(next)
                      lastClickedClipIndexRef.current = i
                    } else {
                      selectClip(tc.clip.id)
                      lastClickedClipIndexRef.current = i
                    }
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
                  <div
                    className="timeline-clip-handle timeline-clip-handle-left"
                    draggable={false}
                    title="トリム(開始位置)"
                    onDragStart={(e) => e.preventDefault()}
                    onMouseDown={(e) =>
                      beginTrimDrag(e, 'left', tc.clip, tc.asset.duration, tc.start)
                    }
                  />
                  <div
                    className="timeline-clip-handle timeline-clip-handle-right"
                    draggable={false}
                    title="トリム(終了位置)"
                    onDragStart={(e) => e.preventDefault()}
                    onMouseDown={(e) =>
                      beginTrimDrag(e, 'right', tc.clip, tc.asset.duration, tc.start)
                    }
                  />
                  {tc.clip.transitionIn && i > 0 && <span className="transition-marker" />}
                  <span className="timeline-clip-index">{i + 1}</span>
                  <span className="timeline-clip-label" title={tc.asset.fileName}>
                    {tc.asset.fileName}
                    {tc.clip.speed !== 1 && ` (${tc.clip.speed}x)`}
                  </span>
                  {isAspectMismatch(tc.asset, project.aspectRatio) &&
                    (tc.clip.fillCrop ? (
                      <span
                        className="timeline-mismatch-icon timeline-crop-icon"
                        title="スマートクロップ適用済み(黒帯なしで表示)"
                      >
                        <WandIcon width={11} height={11} />
                      </span>
                    ) : (
                      <span
                        className="timeline-mismatch-icon"
                        title="プロジェクトのアスペクト比と異なるため黒帯が入ります"
                      >
                        <AlertTriangleIcon width={11} height={11} />
                      </span>
                    ))}
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
              <div
                className={`timeline-playhead-handle ${scrubbing ? 'active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setScrubbing(true)
                }}
              />
            </div>
          </div>

          {project.audioTracks.map((track) => (
            <div key={track.id} className="track-lane audio-lane" style={{ width: timelineWidth }}>
              {track.clips.map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.assetId)
                if (!asset) return null
                const dur = clip.outPoint - clip.inPoint
                const clipWidth = dur * pixelsPerSecond
                const isDraggingThis = audioDrag?.clipId === clip.id
                const displayStart = isDraggingThis ? audioDrag.liveStartTime : clip.startTime
                return (
                  <div
                    key={clip.id}
                    className={`timeline-audio-clip ${
                      selectedAudioClip?.clipId === clip.id ? 'selected' : ''
                    } ${isDraggingThis ? 'dragging' : ''}`}
                    style={{
                      left: displayStart * pixelsPerSecond,
                      width: clipWidth
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setAudioDrag({
                        trackId: track.id,
                        clipId: clip.id,
                        startX: e.clientX,
                        duration: dur,
                        originalStartTime: clip.startTime,
                        liveStartTime: clip.startTime,
                        snapGuideTime: null
                      })
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
          <label>
            音量
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={selectedAudioClipData.volume ?? 1}
              onChange={(e) =>
                updateAudioClipVolume(
                  selectedAudioClip.trackId,
                  selectedAudioClip.clipId,
                  Number(e.target.value)
                )
              }
            />
          </label>
          <label className="inline-select">
            差し替え
            <select
              value={selectedAudioClipData.assetId}
              onChange={(e) => {
                const asset = project.assets.find((a) => a.id === e.target.value)
                if (!asset) return
                swapAudioClipAsset(
                  selectedAudioClip.trackId,
                  selectedAudioClip.clipId,
                  asset.id,
                  asset.duration
                )
              }}
            >
              {project.assets
                .filter((a) => a.hasAudio)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fileName}
                  </option>
                ))}
            </select>
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
      {fillerWordClipId && (
        <FillerWordCutModal clipId={fillerWordClipId} onClose={() => setFillerWordClipId(null)} />
      )}
      {autoCaptionClipId && (
        <AutoCaptionModal clipId={autoCaptionClipId} onClose={() => setAutoCaptionClipId(null)} />
      )}
      {textEditClipId && (
        <TextBasedEditModal clipId={textEditClipId} onClose={() => setTextEditClipId(null)} />
      )}
    </div>
  )
}

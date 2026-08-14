import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  audioClipDuration,
  buildTimedClips,
  rangeSelectionIds,
  totalTimelineDuration
} from '../lib/timelineMath'
import { snapClamped, snapTime } from '../lib/snapping'
import { ASSET_DRAG_TYPE, isAssetDrag } from '../lib/assetDrag'
import { clipColorOf } from '../lib/clipColors'
import { autoScrollLeft } from '../lib/timelineScroll'
import { videoOverlayClipOutPoint } from '../lib/videoOverlay'
import {
  BPM_MAX,
  BPM_MIN,
  clampBpm,
  formatBpm,
  formatOffset,
  parseBpmInput,
  parseOffsetInput,
  scaleBpm
} from '../lib/beatGrid'
import { normalizeFades } from '@shared/audioFade'
import {
  SHORTCUT_ACTIONS,
  getActionLabel,
  getKeymap,
  matchesBinding,
  KEYMAP_SCHEME_LABELS,
  type KeymapScheme
} from '../lib/keymap'
import { isModalOpen } from '../lib/useKeyboardShortcuts'
import { TrimModal } from './TrimModal'
import { SilenceCutModal } from './SilenceCutModal'
import { FillerWordCutModal } from './FillerWordCutModal'
import { AutoCaptionModal } from './AutoCaptionModal'
import { TextBasedEditModal } from './TextBasedEditModal'
import { Waveform } from './Waveform'
import { isAspectMismatch } from '../lib/aspect'
import { formatIpcError } from '../lib/ipcError'
import type {
  AudioTrack,
  AudioTrackClip,
  Clip,
  MediaAsset,
  PipPosition,
  TransitionType
} from '@shared/types'
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyIcon,
  LinkIcon,
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
  ActivityIcon,
  MagnetIcon,
  MaximizeIcon,
  EyeIcon,
  EyeOffIcon,
  MusicIcon
} from './icons'

const PIP_POSITION_LABELS: Record<PipPosition, string> = {
  'top-left': '左上',
  'top-right': '右上',
  'bottom-left': '左下',
  'bottom-right': '右下'
}

const BASE_PIXELS_PER_SECOND = 40
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4
const MIN_CLIP_SOURCE_DURATION = 0.2
const SNAP_PIXELS = 8

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

const TRANSITION_LABELS: Record<TransitionType, string> = {
  none: 'カット',
  crossfade: 'クロスフェード',
  fade: 'フェード',
  wipe: 'ワイプ'
}

export type EditTool = 'select' | 'trim' | 'razor'

interface RollDragState {
  leftClipId: string
  rightClipId: string
  startX: number
  applied: number
}

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

interface VideoOverlayDragState {
  trackId: string
  clipId: string
  startX: number
  duration: number
  originalStartTime: number
  liveStartTime: number
  snapGuideTime: number | null
}

interface MediaTrimDragState {
  kind: 'audio' | 'videoOverlay'
  trackId: string
  clipId: string
  edge: 'left' | 'right'
  startX: number
  /**
   * クリップの再生速度。`inPoint`/`outPoint` は**素材の秒**、`startTime` と画面の幅は
   * **タイムラインの秒**なので、マウスの移動量(タイムライン秒)を素材の秒へ直すのに要る。
   * 掛け忘れると等倍以外でマウスと端がズレる(本編の `TrimDragState` も同じ理由で持つ)。
   */
  speed: number
  assetDuration: number
  originalStartTime: number
  originalInPoint: number
  originalOutPoint: number
  liveStartTime: number
  liveInPoint: number
  liveOutPoint: number
  snapGuideTime: number | null
}

interface OverlayDragState {
  overlayId: string
  mode: 'move' | 'trim-left' | 'trim-right'
  startX: number
  originalStartTime: number
  originalEndTime: number
  liveStartTime: number
  liveEndTime: number
  snapGuideTime: number | null
}

const MIN_OVERLAY_DURATION = 0.2

// 入力された合計がクリップ尺を超えているかを、書き出しと同じ規則で判定する。
// 画面に出す注意書きと実際の丸め方をズラさないため、判定にも normalizeFades を使う。
function fadeExceedsClip(clip: AudioTrackClip): boolean {
  const dur = audioClipDuration(clip)
  const raw = Math.max(0, clip.fadeIn ?? 0) + Math.max(0, clip.fadeOut ?? 0)
  if (raw <= 0) return false
  const n = normalizeFades(clip.fadeIn, clip.fadeOut, dur)
  return n.fadeIn + n.fadeOut < raw - 1e-9
}

// The playhead is the only part of the timeline that has to follow `playheadTime`
// every frame. Keeping the subscription in this small component means playback
// re-renders these two divs instead of the whole timeline (clips, tracks, rulers).
function TimelinePlayhead({
  total,
  pixelsPerSecond,
  scrubbing,
  onScrubStart,
  lanesRef
}: {
  total: number
  pixelsPerSecond: number
  scrubbing: boolean
  onScrubStart: () => void
  lanesRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const playheadTime = useProjectStore((s) => s.playheadTime)
  const left = Math.min(playheadTime, total) * pixelsPerSecond

  // 再生位置が表示範囲から出たら追従する。追従の判定もここに閉じておく:
  // Timeline 本体で `playheadTime` を購読し直すと、クリップ数に比例して毎フレームの
  // 再描画が重くなる(既知の性能問題)。
  useEffect(() => {
    if (scrubbing) return
    const el = lanesRef.current
    if (!el) return
    const next = autoScrollLeft({
      playheadX: left,
      scrollLeft: el.scrollLeft,
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth
    })
    if (next !== null) el.scrollLeft = next
  }, [left, scrubbing, lanesRef])

  return (
    <div className="timeline-playhead" style={{ left }}>
      <div
        className={`timeline-playhead-handle ${scrubbing ? 'active' : ''}`}
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onScrubStart()
        }}
      />
    </div>
  )
}

// Same reason: the split button's disabled state depends on the live playhead, so it
// subscribes on its own instead of forcing the timeline to re-render every frame.
function SplitAtPlayheadButton({
  title,
  start,
  end,
  onSplit
}: {
  title: string
  start: number
  end: number
  onSplit: (time: number) => void
}): React.JSX.Element {
  const playheadTime = useProjectStore((s) => s.playheadTime)
  return (
    <button
      className="small-button"
      title={title}
      disabled={playheadTime <= start || playheadTime >= end}
      onClick={() => onSplit(playheadTime)}
    >
      <ScissorsIcon width={13} height={13} />
      カット
    </button>
  )
}

/**
 * 検出した BPM とオフセットを手で直す欄。検出は外れることがある
 * (実測: 140BPM の素材が 70BPM = ちょうど半分)ので、直せないと削除するしかなかった。
 *
 * 表示はストアの値そのままではなく**打ち込み中の文字列**を持つ。制御された入力欄で
 * `onChange` のたびに丸めると、打った桁がその場で跳ねて別の数字になるため
 * (再発防止チェックリスト「表示値がストア由来の入力欄で…」)。丸めるのは blur / Enter。
 */
function BeatGridControls({
  bpm,
  offsetSeconds,
  onChange
}: {
  bpm: number
  offsetSeconds: number
  onChange: (patch: { bpm?: number; offsetSeconds?: number }, coalesceKey?: string) => void
}): React.JSX.Element {
  const [bpmText, setBpmText] = useState(() => formatBpm(bpm))
  const [offsetText, setOffsetText] = useState(() => formatOffset(offsetSeconds))
  const [editing, setEditing] = useState<'bpm' | 'offset' | null>(null)
  const [synced, setSynced] = useState({ bpm, offsetSeconds })

  // 打っていない間は、外からの変更(Undo・再解析・×2/÷2)を表示へ映す。
  // 打っている最中の欄だけは触らない(上書きするとカーソルごと飛ぶ)。
  // effect ではなくレンダー中に合わせる: effect にすると1フレーム古い値が見える。
  if (synced.bpm !== bpm || synced.offsetSeconds !== offsetSeconds) {
    setSynced({ bpm, offsetSeconds })
    if (editing !== 'bpm') setBpmText(formatBpm(bpm))
    if (editing !== 'offset') setOffsetText(formatOffset(offsetSeconds))
  }

  const halved = scaleBpm(bpm, 0.5)
  const doubled = scaleBpm(bpm, 2)

  function commitBpm(): void {
    setEditing(null)
    const parsed = parseBpmInput(bpmText)
    const next = parsed === null ? bpm : clampBpm(parsed)
    setBpmText(formatBpm(next))
    if (next !== bpm) onChange({ bpm: next }, 'beatGridBpm')
  }

  function commitOffset(): void {
    setEditing(null)
    const parsed = parseOffsetInput(offsetText)
    const next = parsed === null ? offsetSeconds : parsed
    setOffsetText(formatOffset(next))
    if (next !== offsetSeconds) onChange({ offsetSeconds: next }, 'beatGridOffset')
  }

  return (
    <>
      <label className="beat-grid-field" title={`BPM(${BPM_MIN}〜${BPM_MAX})`}>
        <input
          type="number"
          min={BPM_MIN}
          max={BPM_MAX}
          step={1}
          value={bpmText}
          onFocus={() => setEditing('bpm')}
          onChange={(e) => {
            setBpmText(e.target.value)
            const parsed = parseBpmInput(e.target.value)
            // 打っている途中の値はクランプせずそのまま反映する。使えない値
            // (空・0以下)のときだけ、直前の値を残してストアを触らない。
            if (parsed !== null) onChange({ bpm: parsed }, 'beatGridBpm')
          }}
          onBlur={commitBpm}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span>BPM</span>
      </label>
      <button
        className="icon-button"
        title={
          halved === null
            ? `半分にすると ${BPM_MIN} BPM を下回ります`
            : `BPMを半分にする(${formatBpm(halved)} BPM)`
        }
        disabled={halved === null}
        onClick={() => halved !== null && onChange({ bpm: halved })}
      >
        ÷2
      </button>
      <button
        className="icon-button"
        title={
          doubled === null
            ? `2倍にすると ${BPM_MAX} BPM を超えます`
            : `BPMを2倍にする(${formatBpm(doubled)} BPM)`
        }
        disabled={doubled === null}
        onClick={() => doubled !== null && onChange({ bpm: doubled })}
      >
        ×2
      </button>
      <label className="beat-grid-field" title="最初のビートの位置(秒)。グリッド全体がずれます">
        <input
          type="number"
          step={0.01}
          value={offsetText}
          onFocus={() => setEditing('offset')}
          onChange={(e) => {
            setOffsetText(e.target.value)
            const parsed = parseOffsetInput(e.target.value)
            if (parsed !== null) onChange({ offsetSeconds: parsed }, 'beatGridOffset')
          }}
          onBlur={commitOffset}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span>秒</span>
      </label>
    </>
  )
}

export function Timeline(): React.JSX.Element {
  const project = useProjectStore((s) => s.project)
  const selectedClipId = useProjectStore((s) => s.selectedClipId)
  const selectClip = useProjectStore((s) => s.selectClip)
  const multiSelectedClipIds = useProjectStore((s) => s.multiSelectedClipIds)
  const setMultiSelectedClipIds = useProjectStore((s) => s.setMultiSelectedClipIds)
  const removeClips = useProjectStore((s) => s.removeClips)
  const duplicateClips = useProjectStore((s) => s.duplicateClips)
  const updateClipsSpeed = useProjectStore((s) => s.updateClipsSpeed)
  const seekTo = useProjectStore((s) => s.seekTo)
  const removeClip = useProjectStore((s) => s.removeClip)
  const moveClip = useProjectStore((s) => s.moveClip)
  const moveClipToIndex = useProjectStore((s) => s.moveClipToIndex)
  const addClipToTimeline = useProjectStore((s) => s.addClipToTimeline)
  const addClipToVideoOverlayTrack = useProjectStore((s) => s.addClipToVideoOverlayTrack)
  const addAudioClipWithAsset = useProjectStore((s) => s.addAudioClipWithAsset)
  const draggingAssetId = useProjectStore((s) => s.draggingAssetId)
  const setDraggingAssetId = useProjectStore((s) => s.setDraggingAssetId)
  const splitClipAtTime = useProjectStore((s) => s.splitClipAtTime)
  const updateClipSpeed = useProjectStore((s) => s.updateClipSpeed)
  const updateClipTransition = useProjectStore((s) => s.updateClipTransition)
  const detachClipAudio = useProjectStore((s) => s.detachClipAudio)
  const reattachClipAudio = useProjectStore((s) => s.reattachClipAudio)
  const updateClipTrim = useProjectStore((s) => s.updateClipTrim)
  const rollTrim = useProjectStore((s) => s.rollTrim)
  const addAudioTrack = useProjectStore((s) => s.addAudioTrack)
  const removeAudioTrack = useProjectStore((s) => s.removeAudioTrack)
  const toggleAudioTrackMute = useProjectStore((s) => s.toggleAudioTrackMute)
  const toggleAudioTrackDucking = useProjectStore((s) => s.toggleAudioTrackDucking)
  const setAudioTrackVolume = useProjectStore((s) => s.setAudioTrackVolume)
  const updateAudioClipStart = useProjectStore((s) => s.updateAudioClipStart)
  const updateAudioClipTrim = useProjectStore((s) => s.updateAudioClipTrim)
  const updateAudioClipStartAndTrim = useProjectStore((s) => s.updateAudioClipStartAndTrim)
  const updateAudioClipVolume = useProjectStore((s) => s.updateAudioClipVolume)
  const updateAudioClipFade = useProjectStore((s) => s.updateAudioClipFade)
  const swapAudioClipAsset = useProjectStore((s) => s.swapAudioClipAsset)
  const removeAudioClip = useProjectStore((s) => s.removeAudioClip)
  const splitAudioClipAtTime = useProjectStore((s) => s.splitAudioClipAtTime)
  const unlinkAudioClip = useProjectStore((s) => s.unlinkAudioClip)
  const addVideoOverlayTrack = useProjectStore((s) => s.addVideoOverlayTrack)
  const removeVideoOverlayTrack = useProjectStore((s) => s.removeVideoOverlayTrack)
  const toggleVideoOverlayTrackHidden = useProjectStore((s) => s.toggleVideoOverlayTrackHidden)
  const setVideoOverlayTrackPosition = useProjectStore((s) => s.setVideoOverlayTrackPosition)
  const setVideoOverlayTrackScale = useProjectStore((s) => s.setVideoOverlayTrackScale)
  const updateVideoOverlayClipStart = useProjectStore((s) => s.updateVideoOverlayClipStart)
  const updateVideoOverlayClipTrim = useProjectStore((s) => s.updateVideoOverlayClipTrim)
  const updateVideoOverlayClipStartAndTrim = useProjectStore(
    (s) => s.updateVideoOverlayClipStartAndTrim
  )
  const swapVideoOverlayClipAsset = useProjectStore((s) => s.swapVideoOverlayClipAsset)
  const removeVideoOverlayClip = useProjectStore((s) => s.removeVideoOverlayClip)
  const splitVideoOverlayClipAtTime = useProjectStore((s) => s.splitVideoOverlayClipAtTime)
  const updateTextOverlay = useProjectStore((s) => s.updateTextOverlay)
  const removeTextOverlay = useProjectStore((s) => s.removeTextOverlay)
  const copySelectedClip = useProjectStore((s) => s.copySelectedClip)
  const pasteClip = useProjectStore((s) => s.pasteClip)
  const clipboardClips = useProjectStore((s) => s.clipboardClips)
  const setBeatGrid = useProjectStore((s) => s.setBeatGrid)
  const clearBeatGrid = useProjectStore((s) => s.clearBeatGrid)
  const updateBeatGrid = useProjectStore((s) => s.updateBeatGrid)
  const toggleBeatGridEnabled = useProjectStore((s) => s.toggleBeatGridEnabled)
  const keymapScheme = useSettingsStore((s) => s.keymapScheme)
  const setKeymapScheme = useSettingsStore((s) => s.setKeymapScheme)
  const snapEnabled = useSettingsStore((s) => s.snapEnabled)
  const setSnapEnabled = useSettingsStore((s) => s.setSnapEnabled)
  const shortcutGuideVisible = useSettingsStore((s) => s.shortcutGuideVisible)
  const setShortcutGuideVisible = useSettingsStore((s) => s.setShortcutGuideVisible)
  const keymap = getKeymap(keymapScheme)

  const [trimClipId, setTrimClipId] = useState<string | null>(null)
  // 1本でも複数本でも同じモーダルを使う(選択が1本のときは長さ1の配列)
  const [silenceCutClipIds, setSilenceCutClipIds] = useState<string[] | null>(null)
  const [fillerWordClipId, setFillerWordClipId] = useState<string | null>(null)
  const [autoCaptionClipId, setAutoCaptionClipId] = useState<string | null>(null)
  const [textEditClipId, setTextEditClipId] = useState<string | null>(null)
  const [bpmAnalyzingTrackId, setBpmAnalyzingTrackId] = useState<string | null>(null)
  const [bpmError, setBpmError] = useState<string | null>(null)
  const [selectedAudioClip, setSelectedAudioClip] = useState<{
    trackId: string
    clipId: string
  } | null>(null)
  const [selectedVideoOverlayClip, setSelectedVideoOverlayClip] = useState<{
    trackId: string
    clipId: string
  } | null>(null)
  const [videoOverlayDrag, setVideoOverlayDrag] = useState<VideoOverlayDragState | null>(null)
  const [zoom, setZoom] = useState(1)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null)
  /**
   * メディアパネルから引きずってきた素材が、いまどこに落ちるか。
   * 本編トラックは詰めて並べる作りなので「何番目に挿すか」、
   * 音声とPiPは自由に置けるので「何秒の位置か」で示す。
   */
  const [dropIndicator, setDropIndicator] = useState<
    { kind: 'index'; index: number } | { kind: 'time'; laneId: string; time: number } | null
  >(null)
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null)
  const [editTool, setEditTool] = useState<EditTool>('select')
  const [rollDrag, setRollDrag] = useState<RollDragState | null>(null)
  const [audioDrag, setAudioDrag] = useState<AudioDragState | null>(null)
  const [mediaTrimDrag, setMediaTrimDrag] = useState<MediaTrimDragState | null>(null)
  const [overlayDrag, setOverlayDrag] = useState<OverlayDragState | null>(null)
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null)
  const [transitionPopoverClipId, setTransitionPopoverClipId] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  function selectOnly(kind: 'clip' | 'audio' | 'videoOverlay' | 'caption'): void {
    if (kind !== 'clip') {
      selectClip(null)
      setMultiSelectedClipIds([])
    }
    if (kind !== 'audio') setSelectedAudioClip(null)
    if (kind !== 'videoOverlay') setSelectedVideoOverlayClip(null)
    if (kind !== 'caption') setSelectedOverlayId(null)
  }
  const videoLaneRef = useRef<HTMLDivElement>(null)
  const trackLanesColRef = useRef<HTMLDivElement>(null)
  // Shift+クリックの起点は**位置ではなくID**で覚える。`timedClips` は project が
  // 変わるたびに作り直され、並び自体もドラッグ移動・分割・取り消しで変わるので、
  // 位置で覚えると「最後に触ったクリップ」とは別のクリップが起点になる
  // (実測: 4本目を選んでから1本目を末尾へ動かし、1本目を Shift+クリックすると、
  // 触っていない5本目まで入って3本のはずが**4本**選ばれ、そのまま Delete で消える)。
  const lastClickedClipIdRef = useRef<string | null>(null)

  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom

  const baseTimedClips = useMemo(() => buildTimedClips(project), [project])

  const snapCandidates = useMemo(() => {
    const times: number[] = [0]
    baseTimedClips.forEach((tc) => {
      times.push(tc.start, tc.end)
    })
    project.audioTracks.forEach((track) => {
      track.clips.forEach((c) => {
        times.push(c.startTime, c.startTime + audioClipDuration(c))
      })
    })
    project.videoOverlayTracks.forEach((track) => {
      track.clips.forEach((c) => {
        times.push(c.startTime, c.startTime + (c.outPoint - c.inPoint))
      })
    })
    project.textOverlays.forEach((o) => {
      times.push(o.startTime, o.endTime)
    })
    return times
  }, [baseTimedClips, project.audioTracks, project.videoOverlayTracks, project.textOverlays])

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

  // Snap candidates include the playhead, but the playhead moves every frame during
  // playback. Subscribing to it here would rebuild this array — and re-render the whole
  // timeline — 60 times a second. Snapping only ever runs inside a drag handler, so the
  // playhead is read live at that moment instead of being subscribed to.
  const getSnapCandidates = useCallback(
    (): number[] =>
      snapEnabled ? [...snapCandidatesWithBeat, useProjectStore.getState().playheadTime] : [],
    [snapEnabled, snapCandidatesWithBeat]
  )

  useEffect(() => {
    if (!transitionPopoverClipId) return
    function handleOutsideClick(): void {
      setTransitionPopoverClipId(null)
    }
    window.addEventListener('click', handleOutsideClick)
    return () => window.removeEventListener('click', handleOutsideClick)
  }, [transitionPopoverClipId])

  useEffect(() => {
    function handleDeleteKey(e: KeyboardEvent): void {
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }
      if (isModalOpen()) return
      // Audio/PiP-overlay clip selection lives in local state here, invisible to the
      // global keyboard shortcut hook (which only knows about the main clips track's
      // selectedClipId) — so split/delete for these clips has to be handled locally too.
      if (matchesBinding(e, keymap.split)) {
        const now = useProjectStore.getState().playheadTime
        if (selectedAudioClip) {
          e.preventDefault()
          splitAudioClipAtTime(selectedAudioClip.trackId, selectedAudioClip.clipId, now)
        } else if (selectedVideoOverlayClip) {
          e.preventDefault()
          splitVideoOverlayClipAtTime(
            selectedVideoOverlayClip.trackId,
            selectedVideoOverlayClip.clipId,
            now
          )
        }
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      if (selectedOverlayId) {
        e.preventDefault()
        removeTextOverlay(selectedOverlayId)
        setSelectedOverlayId(null)
      } else if (selectedAudioClip) {
        e.preventDefault()
        removeAudioClip(selectedAudioClip.trackId, selectedAudioClip.clipId)
        setSelectedAudioClip(null)
      } else if (selectedVideoOverlayClip) {
        e.preventDefault()
        removeVideoOverlayClip(selectedVideoOverlayClip.trackId, selectedVideoOverlayClip.clipId)
        setSelectedVideoOverlayClip(null)
      }
    }
    window.addEventListener('keydown', handleDeleteKey)
    return () => window.removeEventListener('keydown', handleDeleteKey)
  }, [
    selectedOverlayId,
    selectedAudioClip,
    selectedVideoOverlayClip,
    removeTextOverlay,
    removeAudioClip,
    removeVideoOverlayClip,
    splitAudioClipAtTime,
    splitVideoOverlayClipAtTime,
    keymap.split
  ])

  useEffect(() => {
    if (!trimDrag) return
    const trimDragSnapshot = trimDrag
    function handleMouseMove(e: MouseEvent): void {
      // Read the store outside the state updater: React runs updaters during render.
      const candidates = getSnapCandidates()
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
        const { time: snappedTcEnd, snapped } = snapTime(rawTcEnd, candidates, thresholdSeconds)
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
      // Commit outside the state updater: React runs updater callbacks during the
      // render phase, so a store write in there updates other components mid-render
      // (React logs "Cannot update a component while rendering a different one") and
      // gets replayed when StrictMode double-invokes the updater. The effect re-runs
      // on every trimDrag change, so this closure always sees the live values.
      updateClipTrim(
        trimDragSnapshot.clipId,
        trimDragSnapshot.liveInPoint,
        trimDragSnapshot.liveOutPoint
      )
      setTrimDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [trimDrag, pixelsPerSecond, updateClipTrim, getSnapCandidates])

  // A / T / B pick the editing tool, matching the muscle memory of every NLE. Guarded
  // against firing while typing, and against modifier combos that belong to other
  // shortcuts (Ctrl+A etc.).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null
      const typing =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'a') setEditTool('select')
      else if (key === 't') setEditTool('trim')
      else if (key === 'b') setEditTool('razor')
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Roll drags apply incrementally: rollTrim clamps against both clips' limits, so the
  // only way to know how far the boundary actually moved is to feed it the delta since
  // the last mousemove and let it clamp. The history coalesce key keeps a whole drag as
  // one undo step.
  useEffect(() => {
    if (!rollDrag) return
    const rollDragSnapshot = rollDrag
    function handleMouseMove(e: MouseEvent): void {
      // rollTrim takes a *relative* step, so it must never run inside a state
      // updater: StrictMode double-invokes those, which applied every step twice and
      // moved the boundary at 2x the mouse (measured: a 40px = 1s drag rolled 2s).
      const wanted = (e.clientX - rollDragSnapshot.startX) / pixelsPerSecond
      const step = wanted - rollDragSnapshot.applied
      if (Math.abs(step) < 1e-4) return
      rollTrim(rollDragSnapshot.leftClipId, rollDragSnapshot.rightClipId, step)
      setRollDrag({ ...rollDragSnapshot, applied: wanted })
    }
    function handleMouseUp(): void {
      setRollDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [rollDrag, pixelsPerSecond, rollTrim])

  useEffect(() => {
    if (!audioDrag) return
    const audioDragSnapshot = audioDrag
    function handleMouseMove(e: MouseEvent): void {
      // Read the store outside the state updater: React runs updaters during render.
      const candidates = getSnapCandidates()
      setAudioDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = (e.clientX - prev.startX) / pixelsPerSecond
        const rawStart = Math.max(0, prev.originalStartTime + deltaSeconds)
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const startSnap = snapTime(rawStart, candidates, thresholdSeconds)
        if (startSnap.snapped) {
          return { ...prev, liveStartTime: startSnap.time, snapGuideTime: startSnap.time }
        }
        const endSnap = snapTime(rawStart + prev.duration, candidates, thresholdSeconds)
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
      updateAudioClipStart(
        audioDragSnapshot.trackId,
        audioDragSnapshot.clipId,
        audioDragSnapshot.liveStartTime
      )
      setAudioDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [audioDrag, pixelsPerSecond, updateAudioClipStart, getSnapCandidates])

  useEffect(() => {
    if (!mediaTrimDrag) return
    const mediaTrimDragSnapshot = mediaTrimDrag
    function handleMouseMove(e: MouseEvent): void {
      // Read the store outside the state updater: React runs updaters during render.
      const candidates = getSnapCandidates()
      setMediaTrimDrag((prev) => {
        if (!prev) return prev
        // マウスの移動量は**タイムラインの秒**。`inPoint`/`outPoint` は**素材の秒**なので、
        // 素材側へ渡すときだけ速度を掛ける(掛けないと等倍以外で端がマウスの 1/speed しか
        // 動かず、左ハンドルでは固定されるはずの終端まで動いた)。
        const deltaTimeline = (e.clientX - prev.startX) / pixelsPerSecond
        const speed = prev.speed || 1
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        if (prev.edge === 'left') {
          // Dragging the left handle moves startTime and inPoint together, keeping the
          // clip's end time fixed — the usual "ripple the in-point" trim behavior.
          const maxDelta =
            (prev.originalOutPoint - prev.originalInPoint - MIN_CLIP_SOURCE_DURATION) / speed
          const minDelta = -Math.min(prev.originalInPoint / speed, prev.originalStartTime)
          let delta = Math.min(maxDelta, Math.max(minDelta, deltaTimeline))
          const snap = snapTime(prev.originalStartTime + delta, candidates, thresholdSeconds)
          if (snap.snapped) {
            delta = Math.min(maxDelta, Math.max(minDelta, snap.time - prev.originalStartTime))
          }
          return {
            ...prev,
            liveStartTime: prev.originalStartTime + delta,
            liveInPoint: prev.originalInPoint + delta * speed,
            snapGuideTime: snap.snapped ? prev.originalStartTime + delta : null
          }
        }
        // Right handle: only the out-point (and therefore the clip's end time) moves.
        const maxDelta = (prev.assetDuration - prev.originalOutPoint) / speed
        const minDelta =
          -(prev.originalOutPoint - prev.originalInPoint - MIN_CLIP_SOURCE_DURATION) / speed
        let delta = Math.min(maxDelta, Math.max(minDelta, deltaTimeline))
        // 終端はタイムライン秒なので、素材の尺を速度で割ってから足す。
        const originalEnd =
          prev.originalStartTime + (prev.originalOutPoint - prev.originalInPoint) / speed
        const snap = snapTime(originalEnd + delta, candidates, thresholdSeconds)
        if (snap.snapped) {
          delta = Math.min(maxDelta, Math.max(minDelta, snap.time - originalEnd))
        }
        return {
          ...prev,
          liveOutPoint: prev.originalOutPoint + delta * speed,
          snapGuideTime: snap.snapped ? originalEnd + delta : null
        }
      })
    }
    function handleMouseUp(): void {
      if (mediaTrimDragSnapshot.kind === 'audio') {
        updateAudioClipStartAndTrim(
          mediaTrimDragSnapshot.trackId,
          mediaTrimDragSnapshot.clipId,
          mediaTrimDragSnapshot.liveStartTime,
          mediaTrimDragSnapshot.liveInPoint,
          mediaTrimDragSnapshot.liveOutPoint
        )
      } else {
        updateVideoOverlayClipStartAndTrim(
          mediaTrimDragSnapshot.trackId,
          mediaTrimDragSnapshot.clipId,
          mediaTrimDragSnapshot.liveStartTime,
          mediaTrimDragSnapshot.liveInPoint,
          mediaTrimDragSnapshot.liveOutPoint
        )
      }
      setMediaTrimDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    mediaTrimDrag,
    pixelsPerSecond,
    getSnapCandidates,
    updateAudioClipStartAndTrim,
    updateVideoOverlayClipStartAndTrim
  ])

  useEffect(() => {
    if (!videoOverlayDrag) return
    const videoOverlayDragSnapshot = videoOverlayDrag
    function handleMouseMove(e: MouseEvent): void {
      // Read the store outside the state updater: React runs updaters during render.
      const candidates = getSnapCandidates()
      setVideoOverlayDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = (e.clientX - prev.startX) / pixelsPerSecond
        const rawStart = Math.max(0, prev.originalStartTime + deltaSeconds)
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const startSnap = snapTime(rawStart, candidates, thresholdSeconds)
        if (startSnap.snapped) {
          return { ...prev, liveStartTime: startSnap.time, snapGuideTime: startSnap.time }
        }
        const endSnap = snapTime(rawStart + prev.duration, candidates, thresholdSeconds)
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
      updateVideoOverlayClipStart(
        videoOverlayDragSnapshot.trackId,
        videoOverlayDragSnapshot.clipId,
        videoOverlayDragSnapshot.liveStartTime
      )
      setVideoOverlayDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [videoOverlayDrag, pixelsPerSecond, updateVideoOverlayClipStart, getSnapCandidates])

  useEffect(() => {
    if (!overlayDrag) return
    const overlayDragSnapshot = overlayDrag
    function handleMouseMove(e: MouseEvent): void {
      // Read the store outside the state updater: React runs updaters during render.
      const candidates = getSnapCandidates()
      setOverlayDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = (e.clientX - prev.startX) / pixelsPerSecond
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const duration = prev.originalEndTime - prev.originalStartTime
        if (prev.mode === 'move') {
          const rawStart = Math.max(0, prev.originalStartTime + deltaSeconds)
          const startSnap = snapTime(rawStart, candidates, thresholdSeconds)
          if (startSnap.snapped) {
            return {
              ...prev,
              liveStartTime: startSnap.time,
              liveEndTime: startSnap.time + duration,
              snapGuideTime: startSnap.time
            }
          }
          const endSnap = snapTime(rawStart + duration, candidates, thresholdSeconds)
          if (endSnap.snapped) {
            const liveStartTime = Math.max(0, endSnap.time - duration)
            return {
              ...prev,
              liveStartTime,
              liveEndTime: liveStartTime + duration,
              snapGuideTime: endSnap.time
            }
          }
          return {
            ...prev,
            liveStartTime: rawStart,
            liveEndTime: rawStart + duration,
            snapGuideTime: null
          }
        }
        // スナップ先は候補の時刻なので、先にクランプしても範囲の外へ出る。
        // `snapClamped` はスナップしてから挟み直す(本編クリップと音声/PiPの
        // トリムは前からそうしていて、テロップだけ抜けていた)。
        if (prev.mode === 'trim-left') {
          const maxStart = prev.originalEndTime - MIN_OVERLAY_DURATION
          const rawStart = Math.min(maxStart, Math.max(0, prev.originalStartTime + deltaSeconds))
          const snap = snapClamped(rawStart, candidates, thresholdSeconds, 0, maxStart)
          return {
            ...prev,
            liveStartTime: snap.time,
            snapGuideTime: snap.snapped ? snap.time : null
          }
        }
        const minEnd = prev.originalStartTime + MIN_OVERLAY_DURATION
        const rawEnd = Math.max(minEnd, prev.originalEndTime + deltaSeconds)
        const snap = snapClamped(
          rawEnd,
          candidates,
          thresholdSeconds,
          minEnd,
          Number.POSITIVE_INFINITY
        )
        return {
          ...prev,
          liveEndTime: snap.time,
          snapGuideTime: snap.snapped ? snap.time : null
        }
      })
    }
    function handleMouseUp(): void {
      updateTextOverlay(overlayDragSnapshot.overlayId, {
        startTime: overlayDragSnapshot.liveStartTime,
        endTime: overlayDragSnapshot.liveEndTime
      })
      setOverlayDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [overlayDrag, pixelsPerSecond, updateTextOverlay, getSnapCandidates])

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
  const activeSnapGuideTime =
    trimDrag?.snapGuideTime ??
    audioDrag?.snapGuideTime ??
    overlayDrag?.snapGuideTime ??
    mediaTrimDrag?.snapGuideTime ??
    null

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

  // --- メディアパネルからの素材ドロップ ---------------------------------------
  // ドラッグ中は `dataTransfer` の中身を読めないので、置けるかどうかの判定は
  // ストアに預けた `draggingAssetId` から引いた素材で行う(drop のときだけ中身が読める)。
  const draggedAsset = draggingAssetId
    ? (project.assets.find((a) => a.id === draggingAssetId) ?? null)
    : null

  /**
   * いま引きずっている素材を**ストアから直に**引く。
   *
   * 描画時の `draggedAsset` を判定に使うと、掴んでから最初の `dragover` までに React の
   * 再描画が間に合わないことがある。`dragover` で `preventDefault` を呼ばなかった回は
   * ブラウザがドロップ自体を認めないので、**素早く掴んで落とすと何も起きない**。
   * ストアは `dragstart` の中で同期的に更新されるため、最初の1回から正しく引ける。
   * (見た目のハイライトは再描画が要るので、そちらは `draggedAsset` のままでよい)
   */
  function draggingAssetNow(): MediaAsset | null {
    const id = useProjectStore.getState().draggingAssetId
    if (!id) return null
    return project.assets.find((a) => a.id === id) ?? null
  }

  function dropTimeAt(e: React.DragEvent<HTMLDivElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = Math.max(0, (e.clientX - rect.left) / pixelsPerSecond)
    // 置いた瞬間からクリップの切れ目・再生位置に揃うほうが、置いてから直すより速い。
    // 既存のドラッグ移動と同じ候補・同じしきい値を使う。
    return snapClamped(raw, getSnapCandidates(), SNAP_PIXELS / pixelsPerSecond, 0, Infinity).time
  }

  /** 本編トラックのどのクリップとクリップの間に落ちたか(端は 0 と件数) */
  function dropIndexAt(e: React.DragEvent<HTMLDivElement>): number {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = x / pixelsPerSecond
    let index = timedClips.length
    for (let i = 0; i < timedClips.length; i++) {
      const tc = timedClips[i]
      if (time < tc.start + (tc.end - tc.start) / 2) {
        index = i
        break
      }
    }
    return index
  }

  function assetIdFromDrop(e: React.DragEvent<HTMLDivElement>): string | null {
    const id = e.dataTransfer.getData(ASSET_DRAG_TYPE)
    return id || null
  }

  function endAssetDrag(): void {
    setDropIndicator(null)
    setDraggingAssetId(null)
  }

  // ドラッグをやめた(Escで取り消した・トラックの外で離した)ときにも印を消す。
  // 落とした時にしか消していないと、**置いていないのに落ちる位置の線が残り続ける**。
  useEffect(() => {
    const clear = (): void => setDropIndicator(null)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [])

  function handleWheelZoom(e: React.WheelEvent<HTMLDivElement>): void {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (e.deltaY < 0 ? 1.1 : 0.9))))
  }

  function handleZoomToFit(): void {
    const container = trackLanesColRef.current
    if (!container || total <= 0) return
    const availableWidth = container.clientWidth - 16
    const fitZoom = availableWidth / (total * BASE_PIXELS_PER_SECOND)
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom)))
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

  // Clips whose audio was detached can't have their speed changed (it would drift
  // from the separated audio track), so a bulk speed change silently skips them —
  // surface that instead of leaving the user with a partially-applied change.
  const bulkDetachedCount = useMemo(() => {
    if (multiSelectedClipIds.length < 2) return 0
    const ids = new Set(multiSelectedClipIds)
    return project.clips.filter((c) => ids.has(c.id) && c.audioDetached).length
  }, [multiSelectedClipIds, project.clips])

  // Deleting a track takes every clip on it. That is a very different weight of
  // action from deleting one clip, and it sits behind a 12px trash icon, so ask
  // first whenever there is actually something to lose.
  function confirmRemoveTrack(name: string, clipCount: number): boolean {
    if (clipCount === 0) return true
    return confirm(
      `トラック「${name}」には${clipCount}個のクリップがあります。トラックごと削除しますか?\n(元に戻すで取り消せます)`
    )
  }

  const selectedAudioClipData =
    selectedAudioClip &&
    project.audioTracks
      .find((t) => t.id === selectedAudioClip.trackId)
      ?.clips.find((c) => c.id === selectedAudioClip.clipId)
  const selectedAudioClipAsset = selectedAudioClipData
    ? project.assets.find((a) => a.id === selectedAudioClipData.assetId)
    : undefined

  const selectedVideoOverlayClipData =
    selectedVideoOverlayClip &&
    project.videoOverlayTracks
      .find((t) => t.id === selectedVideoOverlayClip.trackId)
      ?.clips.find((c) => c.id === selectedVideoOverlayClip.clipId)
  const selectedVideoOverlayAsset = selectedVideoOverlayClipData
    ? project.assets.find((a) => a.id === selectedVideoOverlayClipData.assetId)
    : undefined

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
          <button className="icon-button" title="タイムライン全体を表示" onClick={handleZoomToFit}>
            <MaximizeIcon width={13} height={13} />
          </button>
          <button
            className={`icon-button ${snapEnabled ? 'active' : ''}`}
            title={snapEnabled ? 'スナップを無効化' : 'スナップを有効化'}
            onClick={() => setSnapEnabled(!snapEnabled)}
          >
            <MagnetIcon width={13} height={13} />
          </button>
          <div className="timeline-tools" role="group" aria-label="編集ツール">
            {(
              [
                ['select', 'A', '選択', 'クリップを選んで並べ替える'],
                ['trim', 'T', 'トリム', 'クリップの端と、隣との境界(ロールトリム)を調整する'],
                ['razor', 'B', 'カミソリ', 'クリックした位置でクリップを分割する']
              ] as const
            ).map(([tool, key, label, hint]) => (
              <button
                key={tool}
                className={`small-button ${editTool === tool ? 'active' : ''}`}
                title={`${label} (${key}) — ${hint}`}
                onClick={() => setEditTool(tool)}
              >
                {key}
              </button>
            ))}
          </div>
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
            <BeatGridControls
              bpm={project.beatGrid.bpm}
              offsetSeconds={project.beatGrid.offsetSeconds}
              onChange={updateBeatGrid}
            />
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
            <label
              className="inline-select"
              title={
                bulkDetachedCount > 0
                  ? `音声を分離済みのクリップ${bulkDetachedCount}個は速度を変更できないため対象外になります(音声トラックとズレるため)`
                  : undefined
              }
            >
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
            {bulkDetachedCount > 0 && (
              <span className="hint-text bulk-speed-warning">
                <AlertTriangleIcon width={12} height={12} />
                音声分離済み{bulkDetachedCount}個は速度変更の対象外
              </span>
            )}
            <button
              className="small-button"
              title="選択したクリップそれぞれで無音区間を検出し、まとめて削除します"
              onClick={() =>
                // 検出結果はタイムラインの並び順で見せたいので、クリック順ではなく
                // クリップの並びから作り直す。
                setSilenceCutClipIds(
                  project.clips.filter((c) => multiSelectedClipIds.includes(c.id)).map((c) => c.id)
                )
              }
            >
              <WandIcon width={13} height={13} />
              無音カット
            </button>
            <button
              className="icon-button"
              title={`コピー (${keymap.copy.display})`}
              onClick={() => copySelectedClip()}
            >
              <CopyIcon width={13} height={13} />
            </button>
            <button
              className="small-button"
              title={`複製 (${keymap.duplicate.display})`}
              onClick={() => duplicateClips(multiSelectedClipIds)}
            >
              複製
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
              onClick={() =>
                splitClipAtTime(selectedClip.id, useProjectStore.getState().playheadTime)
              }
            >
              <ScissorsIcon width={13} height={13} />
              カット
            </button>
            <button
              className="small-button"
              onClick={() => setSilenceCutClipIds([selectedClip.id])}
            >
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
            {timedClips[selectedIndex]?.asset.hasAudio && !selectedClip.audioDetached && (
              <button
                className="small-button"
                title="動画から音声を切り離し、独立した音声トラックに分けます(再生速度はそのまま引き継がれます)"
                onClick={() => detachClipAudio(selectedClip.id)}
              >
                <MusicIcon width={13} height={13} />
                音声を分離
              </button>
            )}
            {selectedClip.audioDetached && (
              <button
                className="small-button"
                title="分離をやめて、このクリップ自身の音声を鳴らします。分離した音声トラックが残っている場合は二重に鳴るので、不要なら音声トラック側を削除してください"
                onClick={() => reattachClipAudio(selectedClip.id)}
              >
                <MusicIcon width={13} height={13} />
                音声を戻す
              </button>
            )}
            <label
              className="inline-select"
              title={
                selectedClip.audioDetached ? '分離した音声にも同じ速度が掛かります' : undefined
              }
            >
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
              className="small-button"
              title={`複製 (${keymap.duplicate.display})`}
              onClick={() => duplicateClips([selectedClip.id])}
            >
              複製
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
        <button
          className="icon-button shortcut-guide-toggle"
          title={
            shortcutGuideVisible
              ? 'ショートカット一覧を隠す(プレビューやタイムラインを広く使えます)'
              : 'ショートカット一覧を表示'
          }
          onClick={() => setShortcutGuideVisible(!shortcutGuideVisible)}
        >
          <KeyIcon width={13} height={13} />
          {shortcutGuideVisible ? (
            <ChevronLeftIcon width={11} height={11} />
          ) : (
            <ChevronRightIcon width={11} height={11} />
          )}
        </button>
        {shortcutGuideVisible && (
          <>
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
              <span className="shortcut-hint">
                ツール切替
                <kbd>A</kbd>
                <kbd>T</kbd>
                <kbd>B</kbd>
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
          </>
        )}
      </div>
      {bpmError && <p className="error-text timeline-bpm-error">{bpmError}</p>}

      <div className="timeline-tracks">
        <div className="track-labels-col">
          <div className="track-label track-label-video">動画</div>
          {project.videoOverlayTracks.map((track) => (
            <div key={track.id} className="track-label">
              <span className="track-label-name" title={track.name}>
                {track.name}
              </span>
              <div className="track-label-controls">
                <button
                  className="icon-button"
                  title={track.hidden ? '表示' : '非表示(PiP合成をスキップ)'}
                  onClick={() => toggleVideoOverlayTrackHidden(track.id)}
                >
                  {track.hidden ? (
                    <EyeOffIcon width={13} height={13} />
                  ) : (
                    <EyeIcon width={13} height={13} />
                  )}
                </button>
                <select
                  value={track.position}
                  title="ワイプの表示位置"
                  onChange={(e) =>
                    setVideoOverlayTrackPosition(track.id, e.target.value as PipPosition)
                  }
                >
                  {(Object.keys(PIP_POSITION_LABELS) as PipPosition[]).map((p) => (
                    <option key={p} value={p}>
                      {PIP_POSITION_LABELS[p]}
                    </option>
                  ))}
                </select>
                <input
                  type="range"
                  min={0.15}
                  max={0.5}
                  step={0.01}
                  value={track.scale}
                  title="ワイプのサイズ"
                  onChange={(e) => setVideoOverlayTrackScale(track.id, Number(e.target.value))}
                />
                <button
                  className="icon-button danger"
                  title="トラック削除"
                  onClick={() => {
                    if (confirmRemoveTrack(track.name, track.clips.length)) {
                      removeVideoOverlayTrack(track.id)
                    }
                  }}
                >
                  <TrashIcon width={12} height={12} />
                </button>
              </div>
            </div>
          ))}
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
                  max={3}
                  step={0.05}
                  value={track.volume}
                  title={`音量 ${Math.round(track.volume * 100)}%`}
                  onChange={(e) => setAudioTrackVolume(track.id, Number(e.target.value))}
                />
                <span className="hint-text volume-percent">{Math.round(track.volume * 100)}%</span>
                <button
                  className="icon-button danger"
                  title="トラック削除"
                  onClick={() => {
                    if (confirmRemoveTrack(track.name, track.clips.length)) {
                      removeAudioTrack(track.id)
                    }
                  }}
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
        </div>

        <div className="track-lanes-col" ref={trackLanesColRef} onWheel={handleWheelZoom}>
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
            className={`track-lane video-lane ${
              draggedAsset?.hasVideo ? 'drop-target' : ''
            } ${dropIndicator?.kind === 'index' ? 'drop-active' : ''}`}
            style={{ width: timelineWidth }}
            onClick={handleTrackClick}
            onDragOver={(e) => {
              // 並べ替えも素材の追加も**同じ「挿す位置」の印**で受ける。片方だけ別の
              // 出し方にすると、線の位置と実際に入る位置が食い違う(理由は下の onDrop)。
              const reordering = !isAssetDrag(e.dataTransfer.types) && draggedClipId !== null
              // 映像を持たない素材(BGM等)は本編トラックに置けない。受けない印として
              // dropEffect を none にすると、カーソルもそう変わる。
              if (
                !reordering &&
                (!isAssetDrag(e.dataTransfer.types) || !draggingAssetNow()?.hasVideo)
              )
                return
              e.preventDefault()
              e.dataTransfer.dropEffect = reordering ? 'move' : 'copy'
              setDropIndicator({ kind: 'index', index: dropIndexAt(e) })
            }}
            onDragLeave={(e) => {
              // 子のクリップへ移っただけの dragleave では消さない(印がちらつく)
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
              setDropIndicator(null)
            }}
            onDrop={(e) => {
              const reorderingId = isAssetDrag(e.dataTransfer.types) ? null : draggedClipId
              if (!reorderingId && !isAssetDrag(e.dataTransfer.types)) return
              e.preventDefault()
              e.stopPropagation()
              const index = dropIndexAt(e)
              if (reorderingId) {
                // 並べ替えも**線が出た位置へ入れる**。以前はクリップごとに落として
                // 「その番号へ splice」していたため、後ろへ動かすときだけ1つ行き過ぎていた。
                moveClipToIndex(reorderingId, index)
                setDraggedClipId(null)
                setDropIndicator(null)
                return
              }
              const assetId = assetIdFromDrop(e)
              endAssetDrag()
              const asset = project.assets.find((a) => a.id === assetId)
              if (!assetId || !asset?.hasVideo) return
              addClipToTimeline(assetId, index)
            }}
          >
            {dropIndicator?.kind === 'index' && (
              <div
                className="timeline-drop-marker"
                style={{
                  left:
                    (dropIndicator.index >= timedClips.length
                      ? total
                      : timedClips[dropIndicator.index].start) * pixelsPerSecond
                }}
              />
            )}
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
                    trimDrag?.clipId === tc.clip.id ? 'trimming' : ''
                  } tool-${editTool}`}
                  style={{ width: clipWidth }}
                  draggable={editTool === 'select'}
                  onClick={(e) => {
                    e.stopPropagation()
                    // Razor turns a plain click into a cut at the clicked position,
                    // which is what the tool is for — selection is unchanged.
                    if (editTool === 'razor') {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const localSeconds = (e.clientX - rect.left) / pixelsPerSecond
                      splitClipAtTime(tc.clip.id, tc.start + localSeconds)
                      return
                    }
                    selectOnly('clip')
                    // 起点が今の並びに居ないなら範囲は**決められない**ので、
                    // クリックした1本だけを選ぶ(空が返る)。
                    const ids = rangeSelectionIds(timedClips, lastClickedClipIdRef.current, i)
                    if (e.shiftKey && ids.length > 0) {
                      selectClip(tc.clip.id)
                      setMultiSelectedClipIds(ids)
                    } else if (e.metaKey || e.ctrlKey) {
                      const exists = multiSelectedClipIds.includes(tc.clip.id)
                      const next = exists
                        ? multiSelectedClipIds.filter((id) => id !== tc.clip.id)
                        : [...multiSelectedClipIds, tc.clip.id]
                      selectClip(next.length > 0 ? next[next.length - 1] : null)
                      setMultiSelectedClipIds(next)
                      lastClickedClipIdRef.current = tc.clip.id
                    } else {
                      selectClip(tc.clip.id)
                      lastClickedClipIdRef.current = tc.clip.id
                    }
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    setDraggedClipId(tc.clip.id)
                  }}
                  // 並べ替えの受け口はクリップではなく**トラック**に置く。素材の追加と
                  // 同じ「挿す位置」の計算(`dropIndexAt`)と同じ案内線を通すため。
                  // クリップ側でも受けると、落とし先クリップの左端に線が出ているのに
                  // その右へ入る、という食い違いが**後ろへ動かすときだけ**起きる。
                  onDragEnd={() => {
                    setDraggedClipId(null)
                    setDropIndicator(null)
                  }}
                >
                  {editTool === 'trim' && i > 0 && (
                    <div
                      className="timeline-roll-handle"
                      draggable={false}
                      title="ロールトリム: 隣との境界だけを動かす(全体の長さは変わりません)"
                      onDragStart={(e) => e.preventDefault()}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setRollDrag({
                          leftClipId: timedClips[i - 1].clip.id,
                          rightClipId: tc.clip.id,
                          startX: e.clientX,
                          applied: 0
                        })
                      }}
                    />
                  )}
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
                  {i > 0 && (
                    <div
                      className={`transition-marker ${tc.clip.transitionIn ? 'has-transition' : ''}`}
                      title={
                        tc.clip.transitionIn
                          ? `トランジション: ${TRANSITION_LABELS[tc.clip.transitionIn.type]}(クリックで変更)`
                          : 'トランジションを追加'
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        setTransitionPopoverClipId((prev) =>
                          prev === tc.clip.id ? null : tc.clip.id
                        )
                      }}
                    >
                      {transitionPopoverClipId === tc.clip.id && (
                        <div className="transition-popover" onClick={(e) => e.stopPropagation()}>
                          <select
                            value={tc.clip.transitionIn?.type ?? 'none'}
                            onChange={(e) =>
                              updateClipTransition(
                                tc.clip.id,
                                e.target.value === 'none'
                                  ? undefined
                                  : {
                                      type: e.target.value as TransitionType,
                                      duration: tc.clip.transitionIn?.duration ?? 0.5
                                    }
                              )
                            }
                          >
                            <option value="none">カット</option>
                            <option value="crossfade">クロスフェード</option>
                            <option value="fade">フェード</option>
                            <option value="wipe">ワイプ</option>
                          </select>
                          {tc.clip.transitionIn && (
                            <input
                              className="transition-duration"
                              type="number"
                              min={0.1}
                              max={2}
                              step={0.1}
                              value={tc.clip.transitionIn.duration}
                              onChange={(e) =>
                                updateClipTransition(tc.clip.id, {
                                  type: tc.clip.transitionIn?.type ?? 'crossfade',
                                  duration: Number(e.target.value)
                                })
                              }
                              title="トランジション秒数"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {clipColorOf(tc.clip.colorLabel) && (
                    <span
                      className="timeline-clip-color"
                      style={{ background: clipColorOf(tc.clip.colorLabel) ?? undefined }}
                    />
                  )}
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
                  {tc.clip.audioDetached && (
                    <span
                      className="timeline-mismatch-icon"
                      title="音声は分離済み(音声トラックで管理されています)"
                    >
                      <VolumeXIcon width={11} height={11} />
                    </span>
                  )}
                  {tc.asset.hasAudio && !tc.clip.audioDetached && clipWidth > 24 && (
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
                メディアの素材をここへドラッグして並べてください
              </p>
            )}
            <TimelinePlayhead
              total={total}
              pixelsPerSecond={pixelsPerSecond}
              scrubbing={scrubbing}
              onScrubStart={() => setScrubbing(true)}
              lanesRef={trackLanesColRef}
            />
          </div>

          {project.videoOverlayTracks.map((track) => (
            <div
              key={track.id}
              className={`track-lane video-overlay-lane ${track.hidden ? 'hidden' : ''} ${
                draggedAsset?.hasVideo ? 'drop-target' : ''
              } ${
                dropIndicator?.kind === 'time' && dropIndicator.laneId === track.id
                  ? 'drop-active'
                  : ''
              }`}
              style={{ width: timelineWidth }}
              onDragOver={(e) => {
                if (!isAssetDrag(e.dataTransfer.types) || !draggingAssetNow()?.hasVideo) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropIndicator({ kind: 'time', laneId: track.id, time: dropTimeAt(e) })
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setDropIndicator(null)
              }}
              onDrop={(e) => {
                if (!isAssetDrag(e.dataTransfer.types)) return
                e.preventDefault()
                const assetId = assetIdFromDrop(e)
                const startTime = dropTimeAt(e)
                endAssetDrag()
                const asset = project.assets.find((a) => a.id === assetId)
                if (!assetId || !asset?.hasVideo) return
                addClipToVideoOverlayTrack(track.id, assetId, startTime)
              }}
            >
              {dropIndicator?.kind === 'time' && dropIndicator.laneId === track.id && (
                <div
                  className="timeline-drop-marker"
                  style={{ left: dropIndicator.time * pixelsPerSecond }}
                />
              )}
              {track.clips.map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.assetId)
                if (!asset) return null
                const isTrimmingThis =
                  mediaTrimDrag?.kind === 'videoOverlay' && mediaTrimDrag.clipId === clip.id
                const inPoint = isTrimmingThis ? mediaTrimDrag.liveInPoint : clip.inPoint
                const outPoint = isTrimmingThis ? mediaTrimDrag.liveOutPoint : clip.outPoint
                const dur = outPoint - inPoint
                const clipWidth = dur * pixelsPerSecond
                const isDraggingThis = videoOverlayDrag?.clipId === clip.id
                const displayStart = isTrimmingThis
                  ? mediaTrimDrag.liveStartTime
                  : isDraggingThis
                    ? videoOverlayDrag.liveStartTime
                    : clip.startTime
                return (
                  <div
                    key={clip.id}
                    className={`timeline-video-overlay-clip ${
                      selectedVideoOverlayClip?.clipId === clip.id ? 'selected' : ''
                    } ${isDraggingThis ? 'dragging' : ''} ${isTrimmingThis ? 'trimming' : ''}`}
                    style={{
                      left: displayStart * pixelsPerSecond,
                      width: clipWidth
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setVideoOverlayDrag({
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
                      selectOnly('videoOverlay')
                      setSelectedVideoOverlayClip({ trackId: track.id, clipId: clip.id })
                    }}
                    title={asset.fileName}
                  >
                    <div
                      className="timeline-clip-handle timeline-clip-handle-left"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setMediaTrimDrag({
                          kind: 'videoOverlay',
                          trackId: track.id,
                          clipId: clip.id,
                          edge: 'left',
                          startX: e.clientX,
                          speed: 1,
                          assetDuration: asset.duration,
                          originalStartTime: clip.startTime,
                          originalInPoint: clip.inPoint,
                          originalOutPoint: clip.outPoint,
                          liveStartTime: clip.startTime,
                          liveInPoint: clip.inPoint,
                          liveOutPoint: clip.outPoint,
                          snapGuideTime: null
                        })
                      }}
                    />
                    <span className="timeline-audio-clip-label">{asset.fileName}</span>
                    <div
                      className="timeline-clip-handle timeline-clip-handle-right"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setMediaTrimDrag({
                          kind: 'videoOverlay',
                          trackId: track.id,
                          clipId: clip.id,
                          edge: 'right',
                          startX: e.clientX,
                          speed: 1,
                          assetDuration: asset.duration,
                          originalStartTime: clip.startTime,
                          originalInPoint: clip.inPoint,
                          originalOutPoint: clip.outPoint,
                          liveStartTime: clip.startTime,
                          liveInPoint: clip.inPoint,
                          liveOutPoint: clip.outPoint,
                          snapGuideTime: null
                        })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          ))}

          {project.audioTracks.map((track) => (
            <div
              key={track.id}
              className={`track-lane audio-lane ${draggedAsset?.hasAudio ? 'drop-target' : ''} ${
                dropIndicator?.kind === 'time' && dropIndicator.laneId === track.id
                  ? 'drop-active'
                  : ''
              }`}
              style={{ width: timelineWidth }}
              onDragOver={(e) => {
                if (!isAssetDrag(e.dataTransfer.types) || !draggingAssetNow()?.hasAudio) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropIndicator({ kind: 'time', laneId: track.id, time: dropTimeAt(e) })
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setDropIndicator(null)
              }}
              onDrop={(e) => {
                if (!isAssetDrag(e.dataTransfer.types)) return
                e.preventDefault()
                const assetId = assetIdFromDrop(e)
                const startTime = dropTimeAt(e)
                endAssetDrag()
                const asset = project.assets.find((a) => a.id === assetId)
                if (!asset?.hasAudio) return
                // 素材はもうプロジェクトに居るので、この呼び出しは既存の素材を使い回す。
                // 置き場所が埋まっていれば直後の空きへずらすのも既存の実装に任せる。
                addAudioClipWithAsset(asset, {
                  trackId: track.id,
                  trackName: track.name,
                  startTime
                })
              }}
            >
              {dropIndicator?.kind === 'time' && dropIndicator.laneId === track.id && (
                <div
                  className="timeline-drop-marker"
                  style={{ left: dropIndicator.time * pixelsPerSecond }}
                />
              )}
              {track.clips.map((clip) => {
                const asset = project.assets.find((a) => a.id === clip.assetId)
                if (!asset) return null
                const isTrimmingThis =
                  mediaTrimDrag?.kind === 'audio' && mediaTrimDrag.clipId === clip.id
                const inPoint = isTrimmingThis ? mediaTrimDrag.liveInPoint : clip.inPoint
                const outPoint = isTrimmingThis ? mediaTrimDrag.liveOutPoint : clip.outPoint
                const dur = audioClipDuration({ inPoint, outPoint, speed: clip.speed })
                const clipWidth = dur * pixelsPerSecond
                const isDraggingThis = audioDrag?.clipId === clip.id
                const displayStart = isTrimmingThis
                  ? mediaTrimDrag.liveStartTime
                  : isDraggingThis
                    ? audioDrag.liveStartTime
                    : clip.startTime
                return (
                  <div
                    key={clip.id}
                    className={`timeline-audio-clip ${
                      selectedAudioClip?.clipId === clip.id ? 'selected' : ''
                    } ${isDraggingThis ? 'dragging' : ''} ${isTrimmingThis ? 'trimming' : ''}`}
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
                      selectOnly('audio')
                      setSelectedAudioClip({ trackId: track.id, clipId: clip.id })
                    }}
                    title={asset.fileName}
                  >
                    <div
                      className="timeline-clip-handle timeline-clip-handle-left"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setMediaTrimDrag({
                          kind: 'audio',
                          trackId: track.id,
                          clipId: clip.id,
                          edge: 'left',
                          startX: e.clientX,
                          speed: clip.speed || 1,
                          assetDuration: asset.duration,
                          originalStartTime: clip.startTime,
                          originalInPoint: clip.inPoint,
                          originalOutPoint: clip.outPoint,
                          liveStartTime: clip.startTime,
                          liveInPoint: clip.inPoint,
                          liveOutPoint: clip.outPoint,
                          snapGuideTime: null
                        })
                      }}
                    />
                    <span className="timeline-audio-clip-label">{asset.fileName}</span>
                    {clipWidth > 24 && (
                      <div className="timeline-clip-waveform">
                        <Waveform
                          filePath={asset.filePath}
                          start={inPoint}
                          end={outPoint}
                          width={clipWidth}
                          height={30}
                        />
                      </div>
                    )}
                    <div
                      className="timeline-clip-handle timeline-clip-handle-right"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        setMediaTrimDrag({
                          kind: 'audio',
                          trackId: track.id,
                          clipId: clip.id,
                          edge: 'right',
                          startX: e.clientX,
                          speed: clip.speed || 1,
                          assetDuration: asset.duration,
                          originalStartTime: clip.startTime,
                          originalInPoint: clip.inPoint,
                          originalOutPoint: clip.outPoint,
                          liveStartTime: clip.startTime,
                          liveInPoint: clip.inPoint,
                          liveOutPoint: clip.outPoint,
                          snapGuideTime: null
                        })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          ))}

          {project.textOverlays.length > 0 && (
            <div className="track-lane caption-lane" style={{ width: timelineWidth }}>
              {project.textOverlays.map((overlay) => {
                const isDragging = overlayDrag?.overlayId === overlay.id
                const displayStart = isDragging ? overlayDrag.liveStartTime : overlay.startTime
                const displayEnd = isDragging ? overlayDrag.liveEndTime : overlay.endTime
                return (
                  <div
                    key={overlay.id}
                    className={`timeline-caption-clip ${overlay.source === 'auto' ? 'auto' : ''} ${
                      selectedOverlayId === overlay.id ? 'selected' : ''
                    } ${isDragging ? 'dragging' : ''}`}
                    style={{
                      left: displayStart * pixelsPerSecond,
                      width: Math.max(4, (displayEnd - displayStart) * pixelsPerSecond)
                    }}
                    title={overlay.text}
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      setSelectedOverlayId(overlay.id)
                      setOverlayDrag({
                        overlayId: overlay.id,
                        mode: 'move',
                        startX: e.clientX,
                        originalStartTime: overlay.startTime,
                        originalEndTime: overlay.endTime,
                        liveStartTime: overlay.startTime,
                        liveEndTime: overlay.endTime,
                        snapGuideTime: null
                      })
                    }}
                  >
                    <div
                      className="timeline-caption-handle timeline-caption-handle-left"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        selectOnly('caption')
                        setSelectedOverlayId(overlay.id)
                        setOverlayDrag({
                          overlayId: overlay.id,
                          mode: 'trim-left',
                          startX: e.clientX,
                          originalStartTime: overlay.startTime,
                          originalEndTime: overlay.endTime,
                          liveStartTime: overlay.startTime,
                          liveEndTime: overlay.endTime,
                          snapGuideTime: null
                        })
                      }}
                    />
                    {overlay.text}
                    <div
                      className="timeline-caption-handle timeline-caption-handle-right"
                      onMouseDown={(e) => {
                        e.stopPropagation()
                        selectOnly('caption')
                        setSelectedOverlayId(overlay.id)
                        setOverlayDrag({
                          overlayId: overlay.id,
                          mode: 'trim-right',
                          startX: e.clientX,
                          originalStartTime: overlay.startTime,
                          originalEndTime: overlay.endTime,
                          liveStartTime: overlay.startTime,
                          liveEndTime: overlay.endTime,
                          snapGuideTime: null
                        })
                      }}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <div className="timeline-track-actions">
        <button
          className="small-button add-track-button"
          onClick={() =>
            addVideoOverlayTrack(`動画トラック ${project.videoOverlayTracks.length + 2}`)
          }
        >
          <PlusIcon width={12} height={12} />
          動画トラック(PiP)
        </button>
        <button
          className="small-button add-track-button"
          onClick={() => addAudioTrack(`音声トラック ${project.audioTracks.length + 1}`)}
        >
          <PlusIcon width={12} height={12} />
          音声トラック
        </button>
      </div>

      {selectedAudioClipData && selectedAudioClip && (
        <div className="audio-clip-inspector">
          {selectedAudioClipData.linkedClipId && (
            <button
              className="small-button linked-audio-badge"
              title="この分離音声は本編クリップに追従しています(位置・トリムが自動同期)。クリックでリンクを解除して独立させます"
              onClick={() => unlinkAudioClip(selectedAudioClip.trackId, selectedAudioClip.clipId)}
            >
              <LinkIcon width={12} height={12} />
              本編に追従中
            </button>
          )}
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
          {selectedAudioClipAsset && (
            <>
              <label>
                イン点(秒)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={selectedAudioClipAsset.duration}
                  value={selectedAudioClipData.inPoint}
                  onChange={(e) =>
                    updateAudioClipTrim(
                      selectedAudioClip.trackId,
                      selectedAudioClip.clipId,
                      Math.min(Number(e.target.value), selectedAudioClipData.outPoint - 0.1),
                      selectedAudioClipData.outPoint
                    )
                  }
                />
              </label>
              <label>
                アウト点(秒)
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={selectedAudioClipAsset.duration}
                  value={selectedAudioClipData.outPoint}
                  onChange={(e) =>
                    updateAudioClipTrim(
                      selectedAudioClip.trackId,
                      selectedAudioClip.clipId,
                      selectedAudioClipData.inPoint,
                      Math.max(Number(e.target.value), selectedAudioClipData.inPoint + 0.1)
                    )
                  }
                />
              </label>
            </>
          )}
          <label>
            音量({Math.round((selectedAudioClipData.volume ?? 1) * 100)}%)
            <input
              type="range"
              min={0}
              max={3}
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
          <div className="audio-fade-row">
            <label>
              フェードイン(秒)
              <input
                type="number"
                step={0.1}
                min={0}
                max={audioClipDuration(selectedAudioClipData)}
                value={selectedAudioClipData.fadeIn ?? 0}
                onChange={(e) =>
                  updateAudioClipFade(
                    selectedAudioClip.trackId,
                    selectedAudioClip.clipId,
                    Number(e.target.value),
                    selectedAudioClipData.fadeOut ?? 0
                  )
                }
              />
            </label>
            <label>
              フェードアウト(秒)
              <input
                type="number"
                step={0.1}
                min={0}
                max={audioClipDuration(selectedAudioClipData)}
                value={selectedAudioClipData.fadeOut ?? 0}
                onChange={(e) =>
                  updateAudioClipFade(
                    selectedAudioClip.trackId,
                    selectedAudioClip.clipId,
                    selectedAudioClipData.fadeIn ?? 0,
                    Number(e.target.value)
                  )
                }
              />
            </label>
          </div>
          {fadeExceedsClip(selectedAudioClipData) && (
            <p className="hint-text">
              フェードインとフェードアウトの合計がクリップの長さ(
              {audioClipDuration(selectedAudioClipData).toFixed(1)}秒)を超えています。
              比を保ったまま縮めて書き出します。
            </p>
          )}
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
          <SplitAtPlayheadButton
            title={`分割 (${keymap.split.display})`}
            start={selectedAudioClipData.startTime}
            end={selectedAudioClipData.startTime + audioClipDuration(selectedAudioClipData)}
            onSplit={(time) =>
              splitAudioClipAtTime(selectedAudioClip.trackId, selectedAudioClip.clipId, time)
            }
          />
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

      {selectedVideoOverlayClipData && selectedVideoOverlayClip && selectedVideoOverlayAsset && (
        <div className="audio-clip-inspector">
          <label>
            開始位置(秒)
            <input
              type="number"
              step={0.1}
              min={0}
              value={selectedVideoOverlayClipData.startTime}
              onChange={(e) =>
                updateVideoOverlayClipStart(
                  selectedVideoOverlayClip.trackId,
                  selectedVideoOverlayClip.clipId,
                  Number(e.target.value)
                )
              }
            />
          </label>
          <label>
            イン点(秒)
            <input
              type="number"
              step={0.1}
              min={0}
              max={selectedVideoOverlayAsset.duration}
              value={selectedVideoOverlayClipData.inPoint}
              onChange={(e) =>
                updateVideoOverlayClipTrim(
                  selectedVideoOverlayClip.trackId,
                  selectedVideoOverlayClip.clipId,
                  Math.min(Number(e.target.value), selectedVideoOverlayClipData.outPoint - 0.1),
                  selectedVideoOverlayClipData.outPoint
                )
              }
            />
          </label>
          <label>
            アウト点(秒)
            <input
              type="number"
              step={0.1}
              min={0}
              max={selectedVideoOverlayAsset.duration}
              value={selectedVideoOverlayClipData.outPoint}
              onChange={(e) =>
                updateVideoOverlayClipTrim(
                  selectedVideoOverlayClip.trackId,
                  selectedVideoOverlayClip.clipId,
                  selectedVideoOverlayClipData.inPoint,
                  Math.max(Number(e.target.value), selectedVideoOverlayClipData.inPoint + 0.1)
                )
              }
            />
          </label>
          <label className="inline-select">
            差し替え
            <select
              value={selectedVideoOverlayClipData.assetId}
              onChange={(e) => {
                const asset = project.assets.find((a) => a.id === e.target.value)
                if (!asset) return
                // 追加時と同じ規則。ここだけ固定値のままにすると
                // 「追加したら素材の全長・差し替えたら5秒」と食い違う
                swapVideoOverlayClipAsset(
                  selectedVideoOverlayClip.trackId,
                  selectedVideoOverlayClip.clipId,
                  asset.id,
                  videoOverlayClipOutPoint(
                    asset.duration,
                    selectedVideoOverlayClipData.startTime,
                    total
                  )
                )
              }}
            >
              {project.assets
                .filter((a) => a.hasVideo)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fileName}
                  </option>
                ))}
            </select>
          </label>
          <SplitAtPlayheadButton
            title={`分割 (${keymap.split.display})`}
            start={selectedVideoOverlayClipData.startTime}
            end={
              selectedVideoOverlayClipData.startTime +
              (selectedVideoOverlayClipData.outPoint - selectedVideoOverlayClipData.inPoint)
            }
            onSplit={(time) =>
              splitVideoOverlayClipAtTime(
                selectedVideoOverlayClip.trackId,
                selectedVideoOverlayClip.clipId,
                time
              )
            }
          />
          <button
            className="icon-button danger"
            onClick={() => {
              removeVideoOverlayClip(
                selectedVideoOverlayClip.trackId,
                selectedVideoOverlayClip.clipId
              )
              setSelectedVideoOverlayClip(null)
            }}
          >
            <TrashIcon width={13} height={13} />
          </button>
        </div>
      )}

      {trimClipId && <TrimModal clipId={trimClipId} onClose={() => setTrimClipId(null)} />}
      {silenceCutClipIds && (
        <SilenceCutModal clipIds={silenceCutClipIds} onClose={() => setSilenceCutClipIds(null)} />
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

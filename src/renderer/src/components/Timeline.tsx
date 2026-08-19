import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import { useProjectStore } from '../store/projectStore'
import { useSettingsStore } from '../store/settingsStore'
import {
  audioClipDuration,
  buildTimedClips,
  rangeSelectionIds,
  totalTimelineDuration
} from '../lib/timelineMath'
import { snapClamped, snapTime } from '../lib/snapping'
import {
  ASSET_DRAG_TYPE,
  SFX_DRAG_TYPE,
  SOURCE_RANGE_DRAG_TYPE,
  isAssetDrag,
  isSfxDrag,
  isSourceRangeDrag,
  readDragPayload,
  type SfxDragPayload,
  type SourceRangeDragPayload
} from '../lib/assetDrag'
import { clipColorOf } from '../lib/clipColors'
import { autoScrollLeft } from '../lib/timelineScroll'
import { videoOverlayClipOutPoint } from '../lib/videoOverlay'
import {
  BPM_MAX,
  BPM_MIN,
  beatGridFromAnalysis,
  clampBpm,
  formatBpm,
  formatOffset,
  parseBpmInput,
  parseOffsetInput,
  scaleBpm
} from '../lib/beatGrid'
import { normalizeFades } from '@shared/audioFade'
import { transitionSecondsForClip } from '@shared/transition'
import {
  SHORTCUT_ACTIONS,
  getActionLabel,
  getKeymap,
  matchesBinding,
  KEYMAP_SCHEME_LABELS,
  type KeymapScheme
} from '../lib/keymap'
import { isModalOpen, isTypingTarget } from '../lib/useKeyboardShortcuts'
import { ClipContextMenu, type ContextMenuItem } from './ClipContextMenu'
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

/**
 * 繋ぎの長さの入力欄に出す説明。**指定した秒数がそのまま掛かるとは限らない**
 * ——隣に入らないぶんは書き出しが黙って詰めるので、実効値を添える
 * (理由と実測は `transitionSecondsForClip`)。
 */
function transitionDurationTitle(clips: Clip[], clipId: string): string {
  const seconds = transitionSecondsForClip(clips, clipId)
  if (!seconds) return 'トランジション秒数'
  if (seconds.effective >= seconds.specified - 0.005) return 'トランジション秒数'
  return `トランジション秒数(指定 ${seconds.specified}秒。隣のクリップに入らないため実際は ${seconds.effective.toFixed(2)}秒)`
}

/** 詰められているときだけ実効秒数を返す。詰められていなければ null(何も出さない) */
function trimmedTransitionOf(clips: Clip[], clipId: string): number | null {
  const seconds = transitionSecondsForClip(clips, clipId)
  if (!seconds || seconds.effective >= seconds.specified - 0.005) return null
  return seconds.effective
}

const BASE_PIXELS_PER_SECOND = 40
/**
 * 手で縮められる下限。ここより細くするとクリップの掴み代とスナップのしきい値
 * (`SNAP_PIXELS`)が実質きつくなるので、通常の操作ではここで止める。
 */
const MIN_ZOOM = 0.25
/**
 * 「タイムライン全体を表示」のためだけに許す、さらに下の下限。
 *
 * `MIN_ZOOM` で頭打ちにしていたため、**ボタンの名前どおりの結果にならなかった**
 * (実測・レーンの表示幅 542px: 総尺60秒で中身 608px = **66px はみ出し**、
 *  200秒で 2008px = **1466px**、600秒で 6008px = **5466px** が画面の外に残る。
 *  しかも下限で止まったことは画面のどこにも出ない)。
 * 全体を見るのが目的の操作なので、**入るところまで縮められる**ようにする。
 * 0.01 = 0.4px/秒 で、1時間の素材(3600秒)でも 1440px に収まる。
 */
const MIN_FIT_ZOOM = 0.01
/** 全体表示のときレーンの右端に残す余白(px)。下限の計算と同じ数字を使う */
const LANE_FIT_MARGIN_PX = 16
const MAX_ZOOM = 4
const MIN_CLIP_SOURCE_DURATION = 0.2
const SNAP_PIXELS = 8

/**
 * その座標にあるトラックのID。クリップを縦に動かして別のトラックへ移すのに使う。
 *
 * レーンの矩形を自前で集めて比べるのではなく、実際に描かれている要素から引く。
 * 折りたたみ・縦スクロール・トラックの増減で位置が変わっても、これなら常に今の見た目と一致する。
 */
function laneTrackIdAt(x: number, y: number, kind: 'audio' | 'videoOverlay'): string | null {
  const el = document.elementFromPoint(x, y)
  const lane = el?.closest(`[data-track-kind="${kind}"]`)
  return lane?.getAttribute('data-track-id') ?? null
}

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
  /** カーソルが乗っているトラック。元と違えばそちらへ移す */
  hoverTrackId: string | null
}

interface VideoOverlayDragState {
  trackId: string
  clipId: string
  startX: number
  duration: number
  originalStartTime: number
  liveStartTime: number
  snapGuideTime: number | null
  /** カーソルが乗っているトラック。元と違えばそちらへ移す */
  hoverTrackId: string | null
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
  const addTrimmedClipToTimeline = useProjectStore((s) => s.addTrimmedClipToTimeline)
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
  const moveAudioClipToTrack = useProjectStore((s) => s.moveAudioClipToTrack)
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
  const moveVideoOverlayClipToTrack = useProjectStore((s) => s.moveVideoOverlayClipToTrack)
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
  /** 右クリックで開く操作メニュー(座標と中身) */
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    items: ContextMenuItem[]
  } | null>(null)
  /** 効果音のドロップが失敗したとき(ファイルが消えている等)の案内 */
  const [sfxDropError, setSfxDropError] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<
    { kind: 'index'; index: number } | { kind: 'time'; laneId: string; time: number } | null
  >(null)
  const [trimDrag, setTrimDrag] = useState<TrimDragState | null>(null)
  const [editTool, setEditTool] = useState<EditTool>('select')
  const [rollDrag, setRollDrag] = useState<RollDragState | null>(null)
  const [audioDrag, setAudioDrag] = useState<AudioDragState | null>(null)
  const audioHoverTrackRef = useRef<string | null>(null)
  const videoOverlayHoverTrackRef = useRef<string | null>(null)
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
  // 選択は**常に1種類だけ**、という決まりをここで守る。
  //
  // 音声・PiP・テロップの選択はこのコンポーネントのローカル state で、本編クリップの選択は
  // ストアにある。キーボードの担当も割れていて、Delete と分割は
  // 「ローカル選択ぶん(このファイルの handleDeleteKey)」と
  // 「本編クリップぶん(useKeyboardShortcuts)」の**2つの window リスナ**が別々に処理する。
  // 片方が `preventDefault()` してももう片方は走るので、2種類が同時に選ばれていると
  // **1回のキーで2件消える/2箇所が分かれる**。
  // クリックの経路は `selectOnly` が揃えているが、貼り付け(Ctrl+V)と複製(Ctrl+D)は
  // ストアの中で `selectedClipId` を張り替えるので**そこを通らない**。
  // (実測: 音声クリップを選んでから Ctrl+V → Delete で、貼った本編クリップと
  //  音声クリップが2件とも消え、履歴は2件積まれるので取り消し1回では戻らなかった)
  //
  // 見張るのは**「本編クリップの選択が立った瞬間」**の1点だけ。描画のたびに判定するのでは
  // なく、ストアが変わった時にローカル側を落とす(取り残した値が後から生き返らない)。
  useEffect(
    () =>
      useProjectStore.subscribe((state, prev) => {
        const active = state.selectedClipId !== null || state.multiSelectedClipIds.length > 0
        const wasActive = prev.selectedClipId !== null || prev.multiSelectedClipIds.length > 0
        if (!active || wasActive) return
        setSelectedAudioClip(null)
        setSelectedVideoOverlayClip(null)
        setSelectedOverlayId(null)
      }),
    []
  )

  // 右クリックで出す操作の一覧。ショートカットと同じ動きをそのまま呼ぶだけで、
  // ここに独自の処理は書かない(片方だけ挙動が変わるのを防ぐため)。
  function openClipMenu(e: React.MouseEvent, clipId: string, index: number): void {
    e.preventDefault()
    e.stopPropagation()
    selectOnly('clip')
    selectClip(clipId)
    const clip = project.clips.find((c) => c.id === clipId)
    const asset = project.assets.find((a) => a.id === clip?.assetId)
    if (!clip) return
    const targets = multiSelectedClipIds.includes(clipId) ? multiSelectedClipIds : [clipId]
    const items: ContextMenuItem[] = [
      {
        label: '再生位置で分割',
        shortcut: keymap.split.display,
        onSelect: () => splitClipAtTime(clipId, useProjectStore.getState().playheadTime)
      },
      {
        label: targets.length > 1 ? `複製(${targets.length}件)` : '複製',
        shortcut: keymap.duplicate.display,
        onSelect: () => duplicateClips(targets)
      },
      { label: 'コピー', shortcut: keymap.copy.display, onSelect: copySelectedClip },
      {
        label: '貼り付け',
        shortcut: keymap.paste.display,
        disabled: clipboardClips.length === 0,
        onSelect: pasteClip
      },
      { label: 'トリム画面を開く', onSelect: () => setTrimClipId(clipId) }
    ]
    if (asset?.hasAudio) {
      items.push(
        clip.audioDetached
          ? { label: '音声の分離をやめる', onSelect: () => reattachClipAudio(clipId) }
          : { label: '音声を分離', onSelect: () => detachClipAudio(clipId) }
      )
    }
    items.push({
      label: targets.length > 1 ? `削除(${targets.length}件)` : '削除',
      shortcut: keymap.delete.display,
      danger: true,
      onSelect: () => (targets.length > 1 ? removeClips(targets) : removeClip(clipId))
    })
    void index
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }

  function openAudioClipMenu(e: React.MouseEvent, trackId: string, clipId: string): void {
    e.preventDefault()
    e.stopPropagation()
    selectOnly('audio')
    setSelectedAudioClip({ trackId, clipId })
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '再生位置で分割',
          shortcut: keymap.split.display,
          onSelect: () =>
            splitAudioClipAtTime(trackId, clipId, useProjectStore.getState().playheadTime)
        },
        {
          label: '削除',
          shortcut: keymap.delete.display,
          danger: true,
          onSelect: () => removeAudioClip(trackId, clipId)
        }
      ]
    })
  }

  function openVideoOverlayClipMenu(e: React.MouseEvent, trackId: string, clipId: string): void {
    e.preventDefault()
    e.stopPropagation()
    selectOnly('videoOverlay')
    setSelectedVideoOverlayClip({ trackId, clipId })
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: '再生位置で分割',
          shortcut: keymap.split.display,
          onSelect: () =>
            splitVideoOverlayClipAtTime(trackId, clipId, useProjectStore.getState().playheadTime)
        },
        {
          label: '削除',
          shortcut: keymap.delete.display,
          danger: true,
          onSelect: () => removeVideoOverlayClip(trackId, clipId)
        }
      ]
    })
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
    if (!grid || !Number.isFinite(grid.bpm) || !grid.enabled || grid.bpm <= 0) return []
    // 線の本数は `尺 ÷ (60/BPM)` なので、BPM をそのまま使うと**外から来た数字が
    // 引く本数を決める**。入力欄と同じ範囲(20〜300)へ収めてから間隔を出す。
    // 打っている途中の値はストアには丸めずに入る決まりなので(欄の桁が跳ねるため)、
    // 収めるのは**描く側**の責任。
    // 実測: BPM 100000 と打つと線が 62本 → **50,002本**になり、描き直しに 1,503ms。
    const interval = 60 / clampBpm(grid.bpm)
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
      // 動いていないなら確定しない(つまみを掴んだだけで離したときの空の履歴を作らない)。
      if (
        trimDragSnapshot.liveInPoint !== trimDragSnapshot.originalInPoint ||
        trimDragSnapshot.liveOutPoint !== trimDragSnapshot.originalOutPoint
      ) {
        updateClipTrim(
          trimDragSnapshot.clipId,
          trimDragSnapshot.liveInPoint,
          trimDragSnapshot.liveOutPoint
        )
      }
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
      // **モーダルが開いている間は道具を切り替えない。** 切り替えはモーダルの裏で
      // 起きるので画面では気付けず、**閉じたあとも切り替わったまま残る**。
      // カミソリに変わっていると、次にクリップを選ぼうとしたクリックが**分割**になる。
      // (実測: トリムのモーダルを開いた状態で b → 道具が **A → B**、t → **T**。
      //  モーダルを閉じても **T のまま**。同じ場面の Delete は守られていて何も起きない)
      // 判定は**共有の関数を呼ぶ**。ここに書き写したせいで、あとから足された
      // `isModalOpen` の門が届かなかった(理由は useKeyboardShortcuts)。
      if (isModalOpen()) return
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
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
      const hoverTrackId = laneTrackIdAt(e.clientX, e.clientY, 'audio')
      // mouseup は effect 開始時のスナップショットしか見えないので、最後に重ねていた
      // トラックは ref で持つ(state だと1つ前の値で移し先を決めてしまう)。
      audioHoverTrackRef.current = hoverTrackId
      setAudioDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = (e.clientX - prev.startX) / pixelsPerSecond
        const rawStart = Math.max(0, prev.originalStartTime + deltaSeconds)
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const startSnap = snapTime(rawStart, candidates, thresholdSeconds)
        if (startSnap.snapped) {
          return {
            ...prev,
            liveStartTime: startSnap.time,
            snapGuideTime: startSnap.time,
            hoverTrackId
          }
        }
        const endSnap = snapTime(rawStart + prev.duration, candidates, thresholdSeconds)
        if (endSnap.snapped) {
          return {
            ...prev,
            liveStartTime: Math.max(0, endSnap.time - prev.duration),
            snapGuideTime: endSnap.time,
            hoverTrackId
          }
        }
        return { ...prev, liveStartTime: rawStart, snapGuideTime: null, hoverTrackId }
      })
    }
    function handleMouseUp(): void {
      // 離した先が別のトラックなら、位置と移動をまとめて1件の履歴で適用する
      // (先に位置だけ確定させると、Undo1回では戻り切らない)。
      const target = audioHoverTrackRef.current
      if (target && target !== audioDragSnapshot.trackId) {
        moveAudioClipToTrack(
          audioDragSnapshot.trackId,
          audioDragSnapshot.clipId,
          target,
          audioDragSnapshot.liveStartTime
        )
        // 1ミリも動いていないなら確定しない。**ただ選ぶだけのクリックでも mouseup は来る**ので、
        // ここで無条件に書き込むと、動かしていない利用者に2つのことが起きる:
        // (1) 何も変わらない履歴が1件積まれ、次の Ctrl+Z が「何も戻らない」ように見える。
        // (2) `updateAudioClipStart` は `linkedClipId` を消すので、**分離音声と映像の追従が
        //     黙って切れる**。以降そのクリップをトリムしても音声は取り残される。
        // 実測: 分離した音声を1回クリックしてから映像を20秒→10秒に縮めると、
        // 音声だけ20秒のまま残った(触らなければ一緒に10秒になる)。
      } else if (audioDragSnapshot.liveStartTime !== audioDragSnapshot.originalStartTime) {
        updateAudioClipStart(
          audioDragSnapshot.trackId,
          audioDragSnapshot.clipId,
          audioDragSnapshot.liveStartTime
        )
      }
      setAudioDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [audioDrag, pixelsPerSecond, updateAudioClipStart, moveAudioClipToTrack, getSnapCandidates])

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
      // 動いていないなら確定しない(上の音声クリップと同じ理由)。
      const moved =
        mediaTrimDragSnapshot.liveStartTime !== mediaTrimDragSnapshot.originalStartTime ||
        mediaTrimDragSnapshot.liveInPoint !== mediaTrimDragSnapshot.originalInPoint ||
        mediaTrimDragSnapshot.liveOutPoint !== mediaTrimDragSnapshot.originalOutPoint
      if (!moved) {
        setMediaTrimDrag(null)
        return
      }
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
      const hoverTrackId = laneTrackIdAt(e.clientX, e.clientY, 'videoOverlay')
      videoOverlayHoverTrackRef.current = hoverTrackId
      setVideoOverlayDrag((prev) => {
        if (!prev) return prev
        const deltaSeconds = (e.clientX - prev.startX) / pixelsPerSecond
        const rawStart = Math.max(0, prev.originalStartTime + deltaSeconds)
        const thresholdSeconds = SNAP_PIXELS / pixelsPerSecond
        const startSnap = snapTime(rawStart, candidates, thresholdSeconds)
        if (startSnap.snapped) {
          return {
            ...prev,
            liveStartTime: startSnap.time,
            snapGuideTime: startSnap.time,
            hoverTrackId
          }
        }
        const endSnap = snapTime(rawStart + prev.duration, candidates, thresholdSeconds)
        if (endSnap.snapped) {
          return {
            ...prev,
            liveStartTime: Math.max(0, endSnap.time - prev.duration),
            snapGuideTime: endSnap.time,
            hoverTrackId
          }
        }
        return { ...prev, liveStartTime: rawStart, snapGuideTime: null, hoverTrackId }
      })
    }
    function handleMouseUp(): void {
      const target = videoOverlayHoverTrackRef.current
      if (target && target !== videoOverlayDragSnapshot.trackId) {
        moveVideoOverlayClipToTrack(
          videoOverlayDragSnapshot.trackId,
          videoOverlayDragSnapshot.clipId,
          target,
          videoOverlayDragSnapshot.liveStartTime
        )
        // 動いていないなら確定しない(上の音声クリップと同じ理由)。
      } else if (
        videoOverlayDragSnapshot.liveStartTime !== videoOverlayDragSnapshot.originalStartTime
      ) {
        updateVideoOverlayClipStart(
          videoOverlayDragSnapshot.trackId,
          videoOverlayDragSnapshot.clipId,
          videoOverlayDragSnapshot.liveStartTime
        )
      }
      setVideoOverlayDrag(null)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [
    videoOverlayDrag,
    pixelsPerSecond,
    updateVideoOverlayClipStart,
    moveVideoOverlayClipToTrack,
    getSnapCandidates
  ])

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
      // 動いていないなら確定しない(上の音声クリップと同じ理由)。
      if (
        overlayDragSnapshot.liveStartTime !== overlayDragSnapshot.originalStartTime ||
        overlayDragSnapshot.liveEndTime !== overlayDragSnapshot.originalEndTime
      ) {
        updateTextOverlay(overlayDragSnapshot.overlayId, {
          startTime: overlayDragSnapshot.liveStartTime,
          endTime: overlayDragSnapshot.liveEndTime
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
  // 案内線を出す元は**`snapGuideTime` を持つドラッグ状態の全部**。1つでも書き漏らすと、
  // そのレーンだけ「スナップはするのに線が出ない」——クリップが勝手に飛んだようにしか
  // 見えず、何に揃ったのかを確かめる手段が無くなる。**新しいドラッグを足したらここにも足す。**
  // (実測: 本編クリップ 0〜4秒を置いて、音声クリップと PiP クリップを同じ 6秒から
  //  同じだけ左へ引くと、**どちらも 4秒へスナップして落ちる**のに、案内線は音声だけ
  //  `left: 160px`(=4.0秒)に出て、**PiP は最後まで出なかった**)
  // 動いているドラッグは常に1つなので、`??` の連鎖でどれが先でも結果は変わらない
  // (掴んでいない状態は `undefined`、掴んでいてスナップしていない状態は `null`。
  //  どちらも次へ流れて、最後は `null` になる)。
  const activeSnapGuideTime =
    trimDrag?.snapGuideTime ??
    audioDrag?.snapGuideTime ??
    videoOverlayDrag?.snapGuideTime ??
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

  /**
   * お気に入りの効果音を音声トラックへ落としたとき。
   *
   * まだプロジェクトに無いファイルなので尺を測る必要があり、ここだけ非同期になる。
   * 置く処理は「プリセット」タブのボタンと同じ `addAudioClipWithAsset` に任せる
   * (素材の再利用・重ならない位置への送り・履歴1件が、経路ごとにばらけないように)。
   */
  async function dropSfxOnTrack(
    payload: SfxDragPayload,
    trackId: string,
    trackName: string,
    startTime: number
  ): Promise<void> {
    try {
      const known = project.assets.find((a) => a.filePath === payload.filePath)
      const duration = known?.duration ?? (await window.api.probeMedia(payload.filePath)).duration
      addAudioClipWithAsset(
        {
          id: known?.id ?? uuid(),
          filePath: payload.filePath,
          fileName: payload.fileName,
          duration,
          width: 0,
          height: 0,
          fps: 0,
          hasAudio: true,
          hasVideo: false
        },
        { trackId, trackName, startTime }
      )
    } catch (e) {
      setSfxDropError(`${payload.fileName}: ${formatIpcError(e)}`)
    }
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

  /**
   * いま縮められる下限。**「全体が入る倍率」までは必ず下げられる**ようにする
   * (`MIN_ZOOM` で頭打ちにすると、全体表示のボタンが名前どおりに働かない)。
   * 全体が `MIN_ZOOM` で収まる短いタイムラインでは、従来どおり `MIN_ZOOM` が下限。
   */
  function currentMinZoom(): number {
    const container = trackLanesColRef.current
    const availableWidth = (container?.clientWidth ?? 0) - LANE_FIT_MARGIN_PX
    if (total <= 0 || availableWidth <= 0) return MIN_ZOOM
    const fitZoom = availableWidth / (total * BASE_PIXELS_PER_SECOND)
    if (!Number.isFinite(fitZoom) || fitZoom <= 0) return MIN_ZOOM
    return Math.max(MIN_FIT_ZOOM, Math.min(MIN_ZOOM, fitZoom))
  }

  function handleWheelZoom(e: React.WheelEvent<HTMLDivElement>): void {
    if (!e.ctrlKey && !e.metaKey) return
    e.preventDefault()
    const floor = currentMinZoom()
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(floor, z * (e.deltaY < 0 ? 1.1 : 0.9))))
  }

  function handleZoomToFit(): void {
    const container = trackLanesColRef.current
    if (!container || total <= 0) return
    const availableWidth = container.clientWidth - LANE_FIT_MARGIN_PX
    const fitZoom = availableWidth / (total * BASE_PIXELS_PER_SECOND)
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_FIT_ZOOM, fitZoom)))
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
      // 解析が返すのは**素材の秒**。タイムラインの目盛りへ直してから入れる
      // (速度を変えたクリップでは倍率ぶん食い違う。規則は `beatGridFromAnalysis`)。
      setBeatGrid({
        ...beatGridFromAnalysis(result, clip),
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
            onClick={() => setZoom((z) => Math.max(currentMinZoom(), z / 1.4))}
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
                    title={transitionDurationTitle(project.clips, selectedClip.id)}
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

      {sfxDropError && (
        <p className="error-text timeline-drop-error">
          {sfxDropError}
          <button className="small-button" onClick={() => setSfxDropError(null)}>
            閉じる
          </button>
        </p>
      )}

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
              // ソースビューアで決めた範囲(イン/アウト付き)もここが受ける。
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
              // 範囲付きなら、その範囲だけをクリップにする(ソースビューアからのドラッグ)
              const range = isSourceRangeDrag(e.dataTransfer.types)
                ? readDragPayload<SourceRangeDragPayload>(
                    e.dataTransfer.getData(SOURCE_RANGE_DRAG_TYPE)
                  )
                : null
              endAssetDrag()
              const asset = project.assets.find((a) => a.id === (range?.assetId ?? assetId))
              if (!asset?.hasVideo) return
              if (range && range.outPoint > range.inPoint) {
                addTrimmedClipToTimeline(asset.id, range.inPoint, range.outPoint, index)
                return
              }
              if (!assetId) return
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
              // **置く位置は時刻から出す。** 音声・PiP・テロップの3レーンは前から
              // `left = 秒 × 1秒あたりの画素` で置いており、本編だけが**並べた順に流し込む**
              // 形だった。流し込みでは**幅がそのまま次の位置になる**ので、CSS 側の飾り
              // (レーンの `gap: 3px`、短いクリップの `min-width: 44px`)が
              // **そのまま位置のズレになり、しかも後ろへ積み上がる**。
              // (実測: 3秒+0.5秒×6+10秒+7秒 の並びで、最後のクリップの左端のズレが
              //  100%ズーム(40px/秒)で **168px＝4.20秒**、最小ズーム(10px/秒)で
              //  **258px＝25.80秒**。飾りが効かない最大ズームでも `gap` ぶんの
              //  **24px(3px×8)** が残っていた。同じ時刻の音声クリップと再生位置の線は
              //  正しい位置なので、**本編だけが他の全部とズレる**)
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
                  style={{ left: tc.start * pixelsPerSecond, width: clipWidth }}
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
                  onContextMenu={(e) => openClipMenu(e, tc.clip.id, i)}
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
                            <>
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
                                title={transitionDurationTitle(project.clips, tc.clip.id)}
                              />
                              {trimmedTransitionOf(project.clips, tc.clip.id) && (
                                <span className="hint-text transition-trimmed">
                                  実際 {trimmedTransitionOf(project.clips, tc.clip.id)!.toFixed(2)}
                                  秒
                                </span>
                              )}
                            </>
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
              data-track-kind="videoOverlay"
              data-track-id={track.id}
              className={`track-lane video-overlay-lane ${track.hidden ? 'hidden' : ''} ${
                draggedAsset?.hasVideo ? 'drop-target' : ''
              } ${
                (dropIndicator?.kind === 'time' && dropIndicator.laneId === track.id) ||
                (videoOverlayDrag !== null &&
                  videoOverlayDrag.hoverTrackId === track.id &&
                  videoOverlayDrag.trackId !== track.id)
                  ? 'drop-active'
                  : ''
              }`}
              style={{ width: timelineWidth }}
              onDragOver={(e) => {
                if (isSourceRangeDrag(e.dataTransfer.types)) return
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
                    } ${isDraggingThis ? 'dragging' : ''} ${
                      isTrimmingThis ? 'trimming' : ''
                    } tool-${editTool}`}
                    style={{
                      left: displayStart * pixelsPerSecond,
                      width: clipWidth
                    }}
                    onContextMenu={(e) => openVideoOverlayClipMenu(e, track.id, clip.id)}
                    onMouseDown={(e) => {
                      // 右クリックはメニュー用。ここで掴むとメニューを出しながらクリップが動く。
                      if (e.button !== 0) return
                      e.stopPropagation()
                      // カミソリ中は掴ませない(音声クリップと同じ理由)。
                      if (editTool === 'razor') return
                      videoOverlayHoverTrackRef.current = track.id
                      setVideoOverlayDrag({
                        trackId: track.id,
                        clipId: clip.id,
                        startX: e.clientX,
                        duration: dur,
                        originalStartTime: clip.startTime,
                        liveStartTime: clip.startTime,
                        snapGuideTime: null,
                        hoverTrackId: track.id
                      })
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      // カミソリは押した位置で切る(本編クリップと同じ規則)。
                      if (editTool === 'razor') {
                        const rect = e.currentTarget.getBoundingClientRect()
                        const localSeconds = (e.clientX - rect.left) / pixelsPerSecond
                        splitVideoOverlayClipAtTime(
                          track.id,
                          clip.id,
                          clip.startTime + localSeconds
                        )
                        return
                      }
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
              data-track-kind="audio"
              data-track-id={track.id}
              className={`track-lane audio-lane ${draggedAsset?.hasAudio ? 'drop-target' : ''} ${
                (dropIndicator?.kind === 'time' && dropIndicator.laneId === track.id) ||
                (audioDrag !== null &&
                  audioDrag.hoverTrackId === track.id &&
                  audioDrag.trackId !== track.id)
                  ? 'drop-active'
                  : ''
              }`}
              style={{ width: timelineWidth }}
              onDragOver={(e) => {
                const sfx = isSfxDrag(e.dataTransfer.types)
                if (!sfx && (!isAssetDrag(e.dataTransfer.types) || !draggingAssetNow()?.hasAudio))
                  return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropIndicator({ kind: 'time', laneId: track.id, time: dropTimeAt(e) })
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setDropIndicator(null)
              }}
              onDrop={(e) => {
                const sfxPayload = isSfxDrag(e.dataTransfer.types)
                  ? readDragPayload<SfxDragPayload>(e.dataTransfer.getData(SFX_DRAG_TYPE))
                  : null
                if (!sfxPayload && !isAssetDrag(e.dataTransfer.types)) return
                e.preventDefault()
                const assetId = assetIdFromDrop(e)
                const startTime = dropTimeAt(e)
                endAssetDrag()
                if (sfxPayload) {
                  void dropSfxOnTrack(sfxPayload, track.id, track.name, startTime)
                  return
                }
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
                    } ${isDraggingThis ? 'dragging' : ''} ${
                      isTrimmingThis ? 'trimming' : ''
                    } tool-${editTool}`}
                    style={{
                      left: displayStart * pixelsPerSecond,
                      width: clipWidth
                    }}
                    onContextMenu={(e) => openAudioClipMenu(e, track.id, clip.id)}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return
                      e.stopPropagation()
                      // カミソリ中は掴ませない(本編クリップが `draggable` を切っているのと
                      // 同じ理由)。切るつもりの数ピクセルの揺れでクリップが動いてしまう。
                      if (editTool === 'razor') return
                      audioHoverTrackRef.current = track.id
                      setAudioDrag({
                        trackId: track.id,
                        clipId: clip.id,
                        startX: e.clientX,
                        duration: dur,
                        originalStartTime: clip.startTime,
                        liveStartTime: clip.startTime,
                        snapGuideTime: null,
                        hoverTrackId: track.id
                      })
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      // カミソリは押した位置で切る(本編クリップと同じ規則)。
                      if (editTool === 'razor') {
                        const rect = e.currentTarget.getBoundingClientRect()
                        const localSeconds = (e.clientX - rect.left) / pixelsPerSecond
                        splitAudioClipAtTime(track.id, clip.id, clip.startTime + localSeconds)
                        return
                      }
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
                      // 端のつまみと同じく、他の種類の選択を外してから選ぶ。
                      // ここだけ外していなかったため、本編クリップを選んだあとテロップを
                      // 掴むと**両方が選ばれたまま**になり、Delete を1回押すと
                      // テロップと本編クリップが2件とも消えていた
                      // (貼り付け・複製の経路は上の `useProjectStore.subscribe` で塞いでいる)。
                      selectOnly('caption')
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

      {contextMenu && (
        <ClipContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

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

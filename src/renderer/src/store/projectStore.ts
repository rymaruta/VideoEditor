import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { audioClipDuration, buildTimedClips, findFreeAudioStart } from '../lib/timelineMath'
import { DEFAULT_PROJECT_NAME } from '@shared/fileName'
import type {
  AspectRatio,
  AudioTrack,
  AudioTrackClip,
  AutoEditPattern,
  BeatGrid,
  Clip,
  ClipColorLabel,
  EditTemplate,
  MediaAsset,
  PipPosition,
  Project,
  TextOverlay,
  TextStyle,
  Transition
} from '@shared/types'

const MAX_HISTORY = 50
// Shortest a clip may become in source seconds; below this it would vanish visually
// while still occupying an entry in the timeline.
const MIN_CLIP_SOURCE_DURATION = 0.1

function createBlankProject(): Project {
  return {
    id: uuid(),
    name: '新規プロジェクト',
    aspectRatio: '9:16',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    beatGrid: null
  }
}

// Defends against project files saved by an older schema version (or a hand-edited /
// partially corrupted file) that are missing fields added since — without this, loading
// such a file would crash the whole app the moment any code accesses e.g.
// project.audioTracks.forEach(...) on an undefined array.
function normalizeLoadedProject(project: Project): Project {
  return {
    id: project.id ?? uuid(),
    name: project.name ?? '無題のプロジェクト',
    aspectRatio: project.aspectRatio ?? '9:16',
    assets: project.assets ?? [],
    clips: project.clips ?? [],
    audioTracks: project.audioTracks ?? [],
    videoOverlayTracks: project.videoOverlayTracks ?? [],
    textOverlays: project.textOverlays ?? [],
    beatGrid: project.beatGrid ?? null
  }
}

interface ProjectState {
  project: Project
  past: Project[]
  future: Project[]
  currentFilePath: string | null
  isDirty: boolean
  selectedClipId: string | null
  multiSelectedClipIds: string[]
  clipboardClips: Clip[]
  playheadTime: number
  isPlaying: boolean
  seekRequest: { time: number; token: number } | null
  missingAssetIds: string[]
  saveError: string | null

  // Source viewer (DaVinci-style two-up): the asset being auditioned and the range
  // marked on it. Transient UI state — never written to the project file.
  sourceAssetId: string | null
  sourceIn: number | null
  sourceOut: number | null
  openInSourceViewer: (assetId: string) => void
  closeSourceViewer: () => void
  setSourceIn: (t: number | null) => void
  setSourceOut: (t: number | null) => void

  setSaveError: (message: string | null) => void
  newProject: () => void
  loadProject: (project: Project, filePath: string) => void
  restoreAutosave: (project: Project) => void
  markSaved: (filePath: string) => void
  /** プロジェクト名を変える。空白だけなら既定名に戻す */
  setProjectName: (name: string) => void

  setMissingAssetIds: (ids: string[]) => void
  relinkAsset: (
    assetId: string,
    filePath: string,
    fileName: string,
    probe: {
      duration: number
      width: number
      height: number
      fps: number
      hasAudio: boolean
      hasVideo: boolean
    },
    thumbnailDataUrl: string | undefined
  ) => void

  addAsset: (asset: MediaAsset) => void
  addAssets: (assets: MediaAsset[]) => void
  setAssetProxyPath: (assetId: string, proxyPath: string) => void
  removeAsset: (assetId: string) => void
  addAudioClipWithAsset: (
    asset: MediaAsset,
    /** `startTime` を渡すとその位置(空いていなければ直後)へ、省略するとトラック末尾へ置く */
    target: { trackId?: string; trackName: string; startTime?: number }
  ) => void
  addClipToTimeline: (assetId: string) => void
  addTrimmedClipToTimeline: (assetId: string, inPoint: number, outPoint: number) => void
  insertClipAtTime: (assetId: string, inPoint: number, outPoint: number, atTime: number) => void
  overwriteClipAtTime: (assetId: string, inPoint: number, outPoint: number, atTime: number) => void
  updateClipTrim: (clipId: string, inPoint: number, outPoint: number) => void
  rollTrim: (leftClipId: string, rightClipId: string, deltaSeconds: number) => void
  updateClipSpeed: (clipId: string, speed: number) => void
  updateClipTransition: (clipId: string, transition: Transition | undefined) => void
  detachClipAudio: (clipId: string) => void
  reattachClipAudio: (clipId: string) => void
  updateClipCrop: (clipId: string, fillCrop: boolean, cropCenter?: { x: number; y: number }) => void
  replaceClipRange: (clipId: string, newClips: Clip[]) => void
  /** 複数クリップの置き換えをまとめて1件の履歴で適用する(一括無音カット) */
  replaceClipRanges: (replacements: { clipId: string; newClips: Clip[] }[]) => void
  splitClipAtTime: (clipId: string, absoluteTime: number) => void
  removeClip: (clipId: string) => void
  removeClips: (clipIds: string[]) => void
  duplicateClips: (clipIds: string[]) => void
  updateClipsSpeed: (clipIds: string[], speed: number) => void
  /** 分類用の色ラベルを付ける。`label` が undefined なら外す */
  updateClipsColorLabel: (clipIds: string[], label: ClipColorLabel | undefined) => void
  moveClip: (clipId: string, direction: 'left' | 'right') => void
  moveClipToIndex: (clipId: string, targetIndex: number) => void
  setAspectRatio: (ratio: AspectRatio) => void
  selectClip: (clipId: string | null) => void
  setMultiSelectedClipIds: (clipIds: string[]) => void
  setPlayheadTime: (t: number) => void
  setIsPlaying: (p: boolean) => void
  seekTo: (t: number) => void

  copySelectedClip: () => void
  pasteClip: () => void

  undo: () => void
  redo: () => void

  addTextOverlay: (overlay: Omit<TextOverlay, 'id'>) => void
  addTextOverlays: (overlays: Omit<TextOverlay, 'id'>[]) => void
  updateTextOverlay: (id: string, patch: Partial<TextOverlay>) => void
  /** 選んだテロップのスタイルをまとめて更新する。何件でも履歴は1件 */
  updateTextOverlaysStyle: (ids: string[], patch: Partial<TextStyle>) => void
  /** クリップへの追従を設定/解除する。`clipId` が null なら解除 */
  setTextOverlayLink: (id: string, clipId: string | null) => void
  removeTextOverlay: (id: string) => void
  shiftAllTextOverlays: (deltaSeconds: number) => void

  addAudioTrack: (name: string) => void
  removeAudioTrack: (trackId: string) => void
  toggleAudioTrackMute: (trackId: string) => void
  toggleAudioTrackDucking: (trackId: string) => void
  setAudioTrackVolume: (trackId: string, volume: number) => void
  addClipToAudioTrack: (trackId: string, assetId: string) => void
  updateAudioClipStart: (trackId: string, clipId: string, startTime: number) => void
  updateAudioClipTrim: (trackId: string, clipId: string, inPoint: number, outPoint: number) => void
  updateAudioClipStartAndTrim: (
    trackId: string,
    clipId: string,
    startTime: number,
    inPoint: number,
    outPoint: number
  ) => void
  updateAudioClipVolume: (trackId: string, clipId: string, volume: number) => void
  /** フェードイン/アウトの秒数(タイムライン上の秒)。クリップ尺を超える分は書き出し側で丸める */
  updateAudioClipFade: (trackId: string, clipId: string, fadeIn: number, fadeOut: number) => void
  unlinkAudioClip: (trackId: string, clipId: string) => void
  swapAudioClipAsset: (trackId: string, clipId: string, assetId: string, outPoint: number) => void
  removeAudioClip: (trackId: string, clipId: string) => void
  splitAudioClipAtTime: (trackId: string, clipId: string, absoluteTime: number) => void
  addKeywordSeClips: (
    placements: { assetId: string; startTime: number; outPoint: number; volume: number }[],
    newAssets?: MediaAsset[]
  ) => void

  addVideoOverlayTrack: (name: string) => void
  removeVideoOverlayTrack: (trackId: string) => void
  toggleVideoOverlayTrackHidden: (trackId: string) => void
  setVideoOverlayTrackPosition: (trackId: string, position: PipPosition) => void
  setVideoOverlayTrackScale: (trackId: string, scale: number) => void
  addClipToVideoOverlayTrack: (trackId: string, assetId: string) => void
  updateVideoOverlayClipStart: (trackId: string, clipId: string, startTime: number) => void
  updateVideoOverlayClipTrim: (
    trackId: string,
    clipId: string,
    inPoint: number,
    outPoint: number
  ) => void
  updateVideoOverlayClipStartAndTrim: (
    trackId: string,
    clipId: string,
    startTime: number,
    inPoint: number,
    outPoint: number
  ) => void
  swapVideoOverlayClipAsset: (
    trackId: string,
    clipId: string,
    assetId: string,
    outPoint: number
  ) => void
  removeVideoOverlayClip: (trackId: string, clipId: string) => void
  splitVideoOverlayClipAtTime: (trackId: string, clipId: string, absoluteTime: number) => void

  setBeatGrid: (grid: BeatGrid) => void
  clearBeatGrid: () => void
  toggleBeatGridEnabled: () => void

  applyTemplate: (template: EditTemplate) => void
  autoCutFromCandidates: (
    picks: { assetId: string; start: number; end: number }[],
    template: EditTemplate
  ) => void
  addRoughCutClips: (picks: { assetId: string; start: number; end: number }[]) => void
  applyShortPlan: (
    picks: { assetId: string; start: number; end: number; transitionIn?: Transition }[],
    overlays: Omit<TextOverlay, 'id'>[]
  ) => void
  applyAutoEditPattern: (pattern: AutoEditPattern) => void
}

function totalDuration(project: Project): number {
  return project.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1), 0)
}

function audioTrackEnd(track: AudioTrack): number {
  return track.clips.reduce((max, c) => Math.max(max, c.startTime + audioClipDuration(c)), 0)
}

function videoOverlayTrackEnd(track: Project['videoOverlayTracks'][number]): number {
  return track.clips.reduce((max, c) => Math.max(max, c.startTime + (c.outPoint - c.inPoint)), 0)
}

// Detached audio that is still linked belongs to its clip, so it goes with it —
// leaving it behind would keep playing the deleted clip's dialogue over whatever
// footage slid into that spot. Audio the user has since edited is already
// unlinked and is therefore left alone.
function removeLinkedAudioFor(
  audioTracks: AudioTrack[],
  removedClipIds: Set<string>
): AudioTrack[] {
  if (!audioTracks.some((t) => t.clips.some((c) => c.linkedClipId))) return audioTracks
  return audioTracks.map((t) => {
    const clips = t.clips.filter((c) => !c.linkedClipId || !removedClipIds.has(c.linkedClipId))
    return clips.length === t.clips.length ? t : { ...t, clips }
  })
}

// Deleting a detached-audio clip (or the whole track it sits on) has to hand the
// audio back to its source clip. `audioDetached` only means "this clip's audio is
// playing from a separate track"; once that track is gone the flag is a dead end —
// the clip exports in digital silence, 音声を分離 is a no-op because it refuses to
// run on an already-detached clip, and speed changes stay blocked. The audio was
// unrecoverable except by undo.
// Only removal clears the flag. Severing a link while the audio clip lives on
// (dragging it, swapping its asset, the jump-cut recut) must keep the clip muted,
// otherwise its embedded audio plays on top of the still-present separated track.
function reattachClipsWithoutLinkedAudio(project: Project, unlinkedClipIds: string[]): Project {
  if (unlinkedClipIds.length === 0) return project
  const stillLinked = new Set(
    project.audioTracks.flatMap((t) => t.clips.map((c) => c.linkedClipId).filter(Boolean))
  )
  const orphaned = new Set(unlinkedClipIds.filter((id) => !stillLinked.has(id)))
  if (orphaned.size === 0) return project
  let changed = false
  const clips = project.clips.map((c) => {
    if (!orphaned.has(c.id) || !c.audioDetached) return c
    changed = true
    return { ...c, audioDetached: false }
  })
  return changed ? { ...project, clips } : project
}

// Continuous controls (typing in a caption, dragging a volume/size slider) fire an
// action per keystroke or per pixel. Without coalescing, typing a 30-character
// caption pushed 30 history entries and blew away the 50-entry undo history, and
// one undo only removed a single character. Consecutive edits carrying the same
// key within COALESCE_MS fold into the entry that opened the burst, so undo
// returns to the state from before the user started editing that field.
const COALESCE_MS = 700
let lastCoalesceKey: string | null = null
let lastCoalesceAt = 0

function resetHistoryCoalescing(): void {
  lastCoalesceKey = null
}

/**
 * Splices a source range into the main video track at a timeline position.
 *
 * Main-track clips are stored sequentially with no absolute start times, so a position
 * is only meaningful as an offset accumulated across the clips before it. A cut that
 * lands mid-clip therefore has to split that clip rather than just choosing an index.
 *
 * With `overwrite`, the same amount of time the new clip occupies is consumed from the
 * material that followed, so everything downstream keeps its position; otherwise the
 * remainder is pushed later (insert). Returns null when nothing would change.
 */
function buildInsertedClips(
  project: Project,
  assetId: string,
  inPoint: number,
  outPoint: number,
  atTime: number,
  overwrite: boolean
): Clip[] | null {
  const asset = project.assets.find((a) => a.id === assetId)
  if (!asset) return null
  const from = Math.max(0, Math.min(inPoint, asset.duration))
  const to = Math.min(asset.duration, Math.max(outPoint, from))
  const insertedDuration = to - from
  if (insertedDuration <= 0) return null

  const clipDuration = (c: Clip): number => (c.outPoint - c.inPoint) / (c.speed || 1)
  const newClip: Clip = { id: uuid(), assetId, inPoint: from, outPoint: to, speed: 1 }

  // Split whatever sits under the insertion point into "before" and "after" halves.
  const before: Clip[] = []
  const after: Clip[] = []
  let elapsed = 0
  for (const c of project.clips) {
    const dur = clipDuration(c)
    if (atTime >= elapsed + dur - 1e-6) {
      before.push(c)
    } else if (atTime <= elapsed + 1e-6) {
      after.push(c)
    } else {
      const speed = c.speed || 1
      const splitLocal = c.inPoint + (atTime - elapsed) * speed
      before.push({ ...c, outPoint: splitLocal })
      after.push({ ...c, id: uuid(), inPoint: splitLocal, transitionIn: undefined })
    }
    elapsed += dur
  }

  if (!overwrite) return [...before, newClip, ...after]

  // Consume `insertedDuration` worth of the following material, trimming the clip that
  // the consumed range ends inside rather than dropping it whole.
  let remaining = insertedDuration
  const kept: Clip[] = []
  for (const c of after) {
    const dur = clipDuration(c)
    if (remaining <= 1e-6) {
      kept.push(c)
    } else if (remaining >= dur - 1e-6) {
      remaining -= dur
    } else {
      const speed = c.speed || 1
      kept.push({ ...c, inPoint: c.inPoint + remaining * speed, transitionIn: undefined })
      remaining = 0
    }
  }
  return [...before, newClip, ...kept]
}

function pushHistory(
  state: ProjectState,
  coalesceKey?: string
): Pick<ProjectState, 'past' | 'future' | 'isDirty'> {
  if (coalesceKey) {
    const now = Date.now()
    const continuing = lastCoalesceKey === coalesceKey && now - lastCoalesceAt < COALESCE_MS
    lastCoalesceKey = coalesceKey
    lastCoalesceAt = now
    if (continuing) {
      return { past: state.past, future: [], isDirty: true }
    }
  } else {
    lastCoalesceKey = null
  }
  return { past: [...state.past, state.project].slice(-MAX_HISTORY), future: [], isDirty: true }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: createBlankProject(),
  past: [],
  future: [],
  currentFilePath: null,
  isDirty: false,
  selectedClipId: null,
  multiSelectedClipIds: [],
  clipboardClips: [],
  playheadTime: 0,
  isPlaying: false,
  seekRequest: null,
  missingAssetIds: [],
  saveError: null,

  sourceAssetId: null,
  sourceIn: null,
  sourceOut: null,
  // Marks reset with the clip: they describe a range inside one asset and mean
  // nothing once a different one is loaded.
  openInSourceViewer: (assetId) => set({ sourceAssetId: assetId, sourceIn: null, sourceOut: null }),
  closeSourceViewer: () => set({ sourceAssetId: null, sourceIn: null, sourceOut: null }),
  setSourceIn: (t) =>
    set((state) => ({
      sourceIn: t,
      // An in point past the out point would describe a negative range; drop the
      // stale marker rather than silently producing an empty edit later.
      sourceOut:
        t !== null && state.sourceOut !== null && state.sourceOut <= t ? null : state.sourceOut
    })),
  setSourceOut: (t) =>
    set((state) => ({
      sourceOut: t,
      sourceIn: t !== null && state.sourceIn !== null && state.sourceIn >= t ? null : state.sourceIn
    })),

  setSaveError: (message) => set({ saveError: message }),

  setMissingAssetIds: (ids) => set({ missingAssetIds: ids }),

  relinkAsset: (assetId, filePath, fileName, probe, thumbnailDataUrl) =>
    set((state) => {
      // Trims are offsets into the *old* file. Relinking to a shorter one left them
      // pointing past the end: a 0–20s clip on a 15s replacement still read 20s on the
      // timeline while ffmpeg only produced 15s, so every telop, BGM clip and PiP after
      // it burned in 5s out of place. Clamp everything that indexes into this asset.
      const clampRange = <T extends { inPoint: number; outPoint: number }>(clip: T): T => {
        if (clip.outPoint <= probe.duration) return clip
        const outPoint = Math.max(0, probe.duration)
        const inPoint = Math.min(clip.inPoint, Math.max(0, outPoint - MIN_CLIP_SOURCE_DURATION))
        return inPoint === clip.inPoint && outPoint === clip.outPoint
          ? clip
          : { ...clip, inPoint, outPoint }
      }
      const forAsset = <T extends { assetId: string; inPoint: number; outPoint: number }>(
        clip: T
      ): T => (clip.assetId === assetId ? clampRange(clip) : clip)

      return {
        project: {
          ...state.project,
          assets: state.project.assets.map((a) =>
            a.id === assetId
              ? {
                  ...a,
                  filePath,
                  fileName,
                  duration: probe.duration,
                  width: probe.width,
                  height: probe.height,
                  fps: probe.fps,
                  hasAudio: probe.hasAudio,
                  hasVideo: probe.hasVideo,
                  thumbnailDataUrl,
                  // The proxy was transcoded from the file we just replaced. Keeping it
                  // made the preview play the OLD footage while the export used the new
                  // file — the one place the two must never disagree.
                  proxyPath: undefined
                }
              : a
          ),
          clips: state.project.clips.map(forAsset),
          audioTracks: state.project.audioTracks.map((t) => ({
            ...t,
            clips: t.clips.map(forAsset)
          })),
          videoOverlayTracks: state.project.videoOverlayTracks.map((t) => ({
            ...t,
            clips: t.clips.map(forAsset)
          }))
        },
        isDirty: true,
        missingAssetIds: state.missingAssetIds.filter((id) => id !== assetId)
      }
    }),

  newProject: () => {
    resetHistoryCoalescing()
    set({
      project: createBlankProject(),
      past: [],
      future: [],
      currentFilePath: null,
      isDirty: false,
      selectedClipId: null,
      multiSelectedClipIds: [],
      clipboardClips: [],
      playheadTime: 0,
      isPlaying: false,
      seekRequest: null,
      missingAssetIds: []
    })
  },

  loadProject: (project, filePath) =>
    set({
      project: normalizeLoadedProject(project),
      past: [],
      future: [],
      currentFilePath: filePath,
      isDirty: false,
      selectedClipId: null,
      multiSelectedClipIds: [],
      clipboardClips: [],
      playheadTime: 0,
      isPlaying: false,
      seekRequest: null,
      missingAssetIds: []
    }),

  restoreAutosave: (project) =>
    set({
      project: normalizeLoadedProject(project),
      past: [],
      future: [],
      currentFilePath: null,
      // The recovered draft doesn't exist on disk under a real save yet, so keep
      // it flagged dirty until the user explicitly saves it.
      isDirty: true,
      selectedClipId: null,
      multiSelectedClipIds: [],
      clipboardClips: [],
      playheadTime: 0,
      missingAssetIds: [],
      isPlaying: false,
      seekRequest: null
    }),

  markSaved: (filePath) => set({ currentFilePath: filePath, isDirty: false, saveError: null }),

  setProjectName: (name) =>
    set((state) => ({
      // 音量などと同じ合体キー。1文字打つたびに Undo が積まれないようにする。
      ...pushHistory(state, 'projectName'),
      project: { ...state.project, name: name.trim() || DEFAULT_PROJECT_NAME }
    })),

  addAsset: (asset) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, assets: [...state.project.assets, asset] }
    })),

  // Importing a folder of recordings one asset at a time would push one history
  // entry per file, so a 60-file import flushed the entire 50-entry undo history
  // and made everything done before the import unrecoverable.
  addAssets: (assets) =>
    set((state) => {
      if (assets.length === 0) return state
      return {
        ...pushHistory(state),
        project: { ...state.project, assets: [...state.project.assets, ...assets] }
      }
    }),

  // Background result of transcoding a preview proxy, not something the user did:
  // it must not create an undo entry (undoing an import would otherwise leave a
  // half-state) and must not mark the project dirty, since the proxy is a rebuildable
  // cache rather than edited content.
  setAssetProxyPath: (assetId, proxyPath) =>
    set((state) => {
      const target = state.project.assets.find((a) => a.id === assetId)
      if (!target || target.proxyPath === proxyPath) return state
      return {
        project: {
          ...state.project,
          assets: state.project.assets.map((a) => (a.id === assetId ? { ...a, proxyPath } : a))
        }
      }
    }),

  // Removing an asset must take every clip that references it with it — a clip whose
  // asset is gone has no file to read and would break both preview and export. That
  // makes this one user action spanning four collections, so it is one history entry.
  removeAsset: (assetId) =>
    set((state) => {
      if (!state.project.assets.some((a) => a.id === assetId)) return state
      const removedClipIds = state.project.clips
        .filter((c) => c.assetId === assetId)
        .map((c) => c.id)
      const clips = state.project.clips.filter((c) => c.assetId !== assetId)
      const audioTracks = state.project.audioTracks
        .map((t) => ({
          ...t,
          // Detached audio linked to a removed video clip goes too, even when the audio
          // clip itself points at a different asset.
          clips: t.clips.filter(
            (c) =>
              c.assetId !== assetId &&
              !(c.linkedClipId != null && removedClipIds.includes(c.linkedClipId))
          )
        }))
        // A track emptied by this deletion (typically the "◯◯の音声" track the
        // detach created) would otherwise sit in the timeline forever, named after a
        // file the project no longer has. A track that was already empty is left
        // alone — the user made it deliberately and is about to fill it.
        .filter((t, i) => t.clips.length > 0 || state.project.audioTracks[i].clips.length === 0)
      const videoOverlayTracks = state.project.videoOverlayTracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.assetId !== assetId)
      }))
      const stillSelected =
        state.selectedClipId != null && clips.some((c) => c.id === state.selectedClipId)
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          assets: state.project.assets.filter((a) => a.id !== assetId),
          clips,
          audioTracks,
          videoOverlayTracks
        },
        selectedClipId: stillSelected ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) =>
          clips.some((c) => c.id === id)
        ),
        // The source viewer would otherwise keep showing a file the project no longer has.
        sourceAssetId: state.sourceAssetId === assetId ? null : state.sourceAssetId,
        sourceIn: state.sourceAssetId === assetId ? null : state.sourceIn,
        sourceOut: state.sourceAssetId === assetId ? null : state.sourceOut,
        missingAssetIds: state.missingAssetIds.filter((id) => id !== assetId)
      }
    }),

  // Adding narration/BGM is one user action but three mutations (asset, track,
  // clip). Kept as a single history entry so undo doesn't leave an orphaned empty
  // track and an unused asset behind.
  addAudioClipWithAsset: (asset, target) =>
    set((state) => {
      const existing =
        state.project.audioTracks.find((t) => t.id === target.trackId) ??
        state.project.audioTracks.find((t) => t.name === target.trackName)
      // Re-adding the same sound effect must reuse its asset rather than pile up a
      // duplicate media entry for every placement.
      const existingAsset = state.project.assets.find((a) => a.filePath === asset.filePath)
      const effectiveAsset = existingAsset ?? asset
      const clip: AudioTrackClip = {
        id: uuid(),
        assetId: effectiveAsset.id,
        startTime:
          target.startTime === undefined
            ? existing
              ? audioTrackEnd(existing)
              : 0
            : findFreeAudioStart(existing?.clips ?? [], target.startTime, effectiveAsset.duration),
        inPoint: 0,
        outPoint: effectiveAsset.duration
      }
      const audioTracks = existing
        ? state.project.audioTracks.map((t) =>
            t.id === existing.id ? { ...t, clips: [...t.clips, clip] } : t
          )
        : [
            ...state.project.audioTracks,
            {
              id: uuid(),
              name: target.trackName,
              muted: false,
              volume: 1,
              duckingEnabled: false,
              clips: [clip]
            }
          ]
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          assets: existingAsset ? state.project.assets : [...state.project.assets, asset],
          audioTracks
        }
      }
    }),

  addClipToTimeline: (assetId) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset) return state
      const newClip: Clip = {
        id: uuid(),
        assetId,
        inPoint: 0,
        outPoint: asset.duration,
        speed: 1
      }
      return {
        ...pushHistory(state),
        project: { ...state.project, clips: [...state.project.clips, newClip] }
      }
    }),

  addTrimmedClipToTimeline: (assetId, inPoint, outPoint) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset) return state
      const newClip: Clip = {
        id: uuid(),
        assetId,
        inPoint: Math.max(0, inPoint),
        outPoint: Math.min(asset.duration, outPoint),
        speed: 1
      }
      return {
        ...pushHistory(state),
        project: { ...state.project, clips: [...state.project.clips, newClip] }
      }
    }),

  // Three-point editing, DaVinci-style: the source range says how long, the timeline
  // playhead says where. Insert ripples everything after the playhead later; overwrite
  // consumes the same amount of existing material instead.
  insertClipAtTime: (assetId, inPoint, outPoint, atTime) =>
    set((state) => {
      const built = buildInsertedClips(state.project, assetId, inPoint, outPoint, atTime, false)
      if (!built) return state
      return { ...pushHistory(state), project: { ...state.project, clips: built } }
    }),

  overwriteClipAtTime: (assetId, inPoint, outPoint, atTime) =>
    set((state) => {
      const built = buildInsertedClips(state.project, assetId, inPoint, outPoint, atTime, true)
      if (!built) return state
      return { ...pushHistory(state), project: { ...state.project, clips: built } }
    }),

  updateClipTrim: (clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state, `clipTrim:${clipId}`),
      project: {
        ...state.project,
        clips: state.project.clips.map((c) => (c.id === clipId ? { ...c, inPoint, outPoint } : c))
      }
    })),

  // Roll trim: moves the boundary between two neighbours without changing the total
  // length. The left clip gives up (or gains) exactly what the right clip gains (or
  // gives up), so everything downstream keeps its timeline position — the difference
  // from an ordinary edge drag, which ripples everything after it.
  rollTrim: (leftClipId, rightClipId, deltaSeconds) =>
    set((state) => {
      const left = state.project.clips.find((c) => c.id === leftClipId)
      const right = state.project.clips.find((c) => c.id === rightClipId)
      if (!left || !right) return state
      const leftAsset = state.project.assets.find((a) => a.id === left.assetId)
      const rightAsset = state.project.assets.find((a) => a.id === right.assetId)
      if (!leftAsset || !rightAsset) return state
      const leftSpeed = left.speed || 1
      const rightSpeed = right.speed || 1

      // Clamp against all four limits at once and in timeline seconds, so a drag that
      // would overrun one side stops at that side's limit instead of being rejected.
      const maxForward = Math.min(
        (leftAsset.duration - left.outPoint) / leftSpeed,
        (right.outPoint - right.inPoint - MIN_CLIP_SOURCE_DURATION) / rightSpeed
      )
      const maxBackward = Math.min(
        (left.outPoint - left.inPoint - MIN_CLIP_SOURCE_DURATION) / leftSpeed,
        right.inPoint / rightSpeed
      )
      const delta = Math.max(-maxBackward, Math.min(maxForward, deltaSeconds))
      if (Math.abs(delta) < 1e-6) return state

      return {
        ...pushHistory(state, `roll:${leftClipId}:${rightClipId}`),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) => {
            if (c.id === leftClipId) return { ...c, outPoint: c.outPoint + delta * leftSpeed }
            if (c.id === rightClipId) return { ...c, inPoint: c.inPoint + delta * rightSpeed }
            return c
          })
        }
      }
    }),

  updateClipSpeed: (clipId, speed) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        // 分離音声にも同じ速度がミラーされる(syncLinkedAudioClips)ので、分離済みでも
        // 速度を変えられる。
        clips: state.project.clips.map((c) => (c.id === clipId ? { ...c, speed } : c))
      }
    })),

  updateClipTransition: (clipId, transition) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId ? { ...c, transitionIn: transition } : c
        )
      }
    })),

  detachClipAudio: (clipId) =>
    set((state) => {
      const clip = state.project.clips.find((c) => c.id === clipId)
      if (!clip || clip.audioDetached) return state
      const asset = state.project.assets.find((a) => a.id === clip.assetId)
      if (!asset || !asset.hasAudio) return state
      const timed = buildTimedClips(state.project)
      const timedClip = timed.find((tc) => tc.clip.id === clipId)
      if (!timedClip) return state
      const newTrack: AudioTrack = {
        id: uuid(),
        name: `${asset.fileName}の音声`,
        muted: false,
        volume: 1,
        duckingEnabled: false,
        clips: [
          {
            id: uuid(),
            assetId: clip.assetId,
            startTime: timedClip.start,
            inPoint: clip.inPoint,
            outPoint: clip.outPoint,
            // 速度もそのまま引き継ぐ。等倍以外のクリップを分離しても音がズレない。
            speed: clip.speed || 1,
            linkedClipId: clip.id
          }
        ]
      }
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) =>
            c.id === clipId ? { ...c, audioDetached: true } : c
          ),
          audioTracks: [...state.project.audioTracks, newTrack]
        }
      }
    }),

  // The counterpart to 音声を分離. `audioDetached` mutes the clip on export, and
  // detachClipAudio refuses to run on an already-detached clip, so without a way back
  // the flag is a one-way door. Removal of a *linked* audio clip clears it
  // automatically, but the link can be severed first — splitting the separated audio,
  // dragging it, or swapping its asset all unlink it — and deleting it afterwards then
  // left the clip permanently silent (measured: -91.0 dB) with no way to recover.
  reattachClipAudio: (clipId) =>
    set((state) => {
      const clip = state.project.clips.find((c) => c.id === clipId)
      if (!clip || !clip.audioDetached) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) =>
            c.id === clipId ? { ...c, audioDetached: false } : c
          ),
          // Audio still linked to this clip belongs to the separation we are undoing,
          // so it goes with it. Anything the user has since unlinked and edited is
          // left alone — deleting their work would be worse than a doubled track they
          // can see and remove.
          audioTracks: state.project.audioTracks
            .map((t) => {
              const clips = t.clips.filter((c) => c.linkedClipId !== clipId)
              return clips.length === t.clips.length ? t : { ...t, clips }
            })
            // The "◯◯の音声" track the separation created has no reason to stay behind
            // once it is empty. A track that was already empty is the user's, so it stays.
            .filter((t, i) => t.clips.length > 0 || state.project.audioTracks[i].clips.length === 0)
        }
      }
    }),

  updateClipCrop: (clipId, fillCrop, cropCenter) =>
    set((state) => ({
      // Dragging the crop-centre slider fires continuously; without coalescing one
      // adjustment would bury the rest of the undo history.
      ...pushHistory(state, `clipCrop:${clipId}`),
      project: {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId ? { ...c, fillCrop, cropCenter: cropCenter ?? c.cropCenter } : c
        )
      }
    })),

  replaceClipRange: (clipId, newClips) =>
    set((state) => {
      const project = applyClipReplacement(state.project, clipId, newClips)
      if (project === state.project) return state
      return { ...pushHistory(state), project }
    }),

  replaceClipRanges: (replacements) =>
    set((state) => {
      // 対象が何本でも履歴は1件。1本ずつ replaceClipRange を呼ぶと本数分の
      // Undo が積まれ、まとめて掛けた操作を1回で戻せなくなる。
      const project = replacements.reduce(
        (acc, r) => applyClipReplacement(acc, r.clipId, r.newClips),
        state.project
      )
      if (project === state.project) return state
      return { ...pushHistory(state), project }
    }),

  splitClipAtTime: (clipId, absoluteTime) =>
    set((state) => {
      let elapsed = 0
      let didSplit = false
      let secondHalfId: string | null = null
      let splitOriginal: Clip | null = null
      const splitParts: Clip[] = []
      const clips: Clip[] = []
      for (const c of state.project.clips) {
        const dur = (c.outPoint - c.inPoint) / (c.speed || 1)
        if (c.id === clipId && absoluteTime > elapsed && absoluteTime < elapsed + dur) {
          didSplit = true
          secondHalfId = uuid()
          splitOriginal = c
          const speed = c.speed || 1
          const splitLocal = c.inPoint + (absoluteTime - elapsed) * speed
          clips.push({ ...c, outPoint: splitLocal })
          splitParts.push({ ...c, outPoint: splitLocal })
          // Spread the source clip so per-clip settings that aren't listed here
          // (crop/fill framing in particular) survive the split — rebuilding the
          // second half field by field silently dropped them.
          const secondHalf = {
            ...c,
            id: secondHalfId,
            inPoint: splitLocal,
            outPoint: c.outPoint,
            speed,
            transitionIn: undefined
          }
          clips.push(secondHalf)
          splitParts.push(secondHalf)
        } else {
          clips.push(c)
        }
        elapsed += dur
      }
      if (!didSplit) return state
      // Detached audio linked to the split clip must split too: the link mirror
      // trims linked audio to its source clip's bounds, so without a second piece
      // linked to the new half, that half (audioDetached=true) would export silent.
      const audioTracks = state.project.audioTracks.map((t) => {
        if (!t.clips.some((c) => c.linkedClipId === clipId)) return t
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.linkedClipId !== clipId) return [c]
            const splitLocal = c.inPoint + (absoluteTime - c.startTime)
            if (splitLocal <= c.inPoint || splitLocal >= c.outPoint) return [c]
            return [
              { ...c, outPoint: splitLocal },
              {
                ...c,
                id: uuid(),
                startTime: absoluteTime,
                inPoint: splitLocal,
                linkedClipId: secondHalfId ?? undefined
              }
            ]
          })
        }
      })
      // 後半は新しいIDになるので、そこへ載っていた追従テロップを張り直す。
      const textOverlays = splitOriginal
        ? remapOverlayLinks(state.project.textOverlays, splitOriginal, splitParts)
        : state.project.textOverlays
      return {
        ...pushHistory(state),
        project: { ...state.project, clips, audioTracks, textOverlays }
      }
    }),

  removeClip: (clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        clips: state.project.clips.filter((c) => c.id !== clipId),
        audioTracks: removeLinkedAudioFor(state.project.audioTracks, new Set([clipId]))
      },
      selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId,
      multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => id !== clipId)
    })),

  removeClips: (clipIds) =>
    set((state) => {
      const idSet = new Set(clipIds)
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.filter((c) => !idSet.has(c.id)),
          audioTracks: removeLinkedAudioFor(state.project.audioTracks, idSet)
        },
        selectedClipId:
          state.selectedClipId && idSet.has(state.selectedClipId) ? null : state.selectedClipId,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => !idSet.has(id))
      }
    }),

  duplicateClips: (clipIds) =>
    set((state) => {
      const idSet = new Set(clipIds)
      const indices = state.project.clips
        .map((c, i) => (idSet.has(c.id) ? i : -1))
        .filter((i) => i !== -1)
      if (indices.length === 0) return state
      const lastIndex = Math.max(...indices)
      const newClips: Clip[] = indices.map((i) => ({
        ...state.project.clips[i],
        id: uuid(),
        transitionIn: undefined,
        audioDetached: false
      }))
      const clips = [...state.project.clips]
      clips.splice(lastIndex + 1, 0, ...newClips)
      return {
        ...pushHistory(state),
        project: { ...state.project, clips },
        selectedClipId: newClips[newClips.length - 1].id,
        multiSelectedClipIds: newClips.map((c) => c.id)
      }
    }),

  updateClipsSpeed: (clipIds, speed) =>
    set((state) => {
      const idSet = new Set(clipIds)
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          // 分離音声にも同じ速度がミラーされるので、分離済みでも速度を変えられる。
          clips: state.project.clips.map((c) => (idSet.has(c.id) ? { ...c, speed } : c))
        }
      }
    }),

  // 単一選択も複数選択も同じアクションを通す(呼び出し側が [clip.id] を渡す)。
  // 経路を分けると片方だけ直す事故が起きるため。
  updateClipsColorLabel: (clipIds, label) =>
    set((state) => {
      const idSet = new Set(clipIds)
      if (!state.project.clips.some((c) => idSet.has(c.id))) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: state.project.clips.map((c) => (idSet.has(c.id) ? { ...c, colorLabel: label } : c))
        }
      }
    }),

  moveClip: (clipId, direction) =>
    set((state) => {
      const clips = [...state.project.clips]
      const idx = clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return state
      const swapWith = direction === 'left' ? idx - 1 : idx + 1
      if (swapWith < 0 || swapWith >= clips.length) return state
      ;[clips[idx], clips[swapWith]] = [clips[swapWith], clips[idx]]
      return { ...pushHistory(state), project: { ...state.project, clips } }
    }),

  moveClipToIndex: (clipId, targetIndex) =>
    set((state) => {
      const clips = [...state.project.clips]
      const fromIndex = clips.findIndex((c) => c.id === clipId)
      if (fromIndex === -1) return state
      const clamped = Math.max(0, Math.min(targetIndex, clips.length - 1))
      if (clamped === fromIndex) return state
      const [moved] = clips.splice(fromIndex, 1)
      clips.splice(clamped, 0, moved)
      return { ...pushHistory(state), project: { ...state.project, clips } }
    }),

  setAspectRatio: (ratio) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, aspectRatio: ratio }
    })),

  selectClip: (clipId) =>
    set({ selectedClipId: clipId, multiSelectedClipIds: clipId ? [clipId] : [] }),
  setMultiSelectedClipIds: (clipIds) => set({ multiSelectedClipIds: clipIds }),
  setPlayheadTime: (t) => set({ playheadTime: t }),
  setIsPlaying: (p) => set({ isPlaying: p }),
  seekTo: (t) =>
    set((state) => ({
      playheadTime: t,
      seekRequest: { time: t, token: (state.seekRequest?.token ?? 0) + 1 }
    })),

  copySelectedClip: () => {
    const state = get()
    const idSet = new Set(
      state.multiSelectedClipIds.length > 0
        ? state.multiSelectedClipIds
        : state.selectedClipId
          ? [state.selectedClipId]
          : []
    )
    const clips = state.project.clips.filter((c) => idSet.has(c.id))
    if (clips.length > 0) set({ clipboardClips: clips })
  },

  pasteClip: () =>
    set((state) => {
      if (state.clipboardClips.length === 0) return state
      const newClips: Clip[] = state.clipboardClips.map((c) => ({
        ...c,
        id: uuid(),
        transitionIn: undefined,
        audioDetached: false
      }))
      const idx = state.project.clips.findIndex((c) => c.id === state.selectedClipId)
      const clips = [...state.project.clips]
      if (idx === -1) {
        clips.push(...newClips)
      } else {
        clips.splice(idx + 1, 0, ...newClips)
      }
      return {
        ...pushHistory(state),
        project: { ...state.project, clips },
        selectedClipId: newClips[newClips.length - 1].id,
        multiSelectedClipIds: newClips.map((c) => c.id)
      }
    }),

  undo: () => {
    resetHistoryCoalescing()
    set((state) => {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      const idSet = new Set(previous.clips.map((c) => c.id))
      return {
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, MAX_HISTORY),
        project: previous,
        // Undoing changes the document relative to what was last written to disk.
        // Without this the save button stays disabled, the close prompt never
        // appears and no recovery draft is written — the undo is silently lost.
        isDirty: true,
        selectedClipId: idSet.has(state.selectedClipId ?? '') ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => idSet.has(id))
      }
    })
  },

  redo: () => {
    resetHistoryCoalescing()
    set((state) => {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      const idSet = new Set(next.clips.map((c) => c.id))
      return {
        past: [...state.past, state.project].slice(-MAX_HISTORY),
        future: rest,
        project: next,
        isDirty: true,
        selectedClipId: idSet.has(state.selectedClipId ?? '') ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => idSet.has(id))
      }
    })
  },

  addTextOverlay: (overlay) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        textOverlays: [...state.project.textOverlays, { ...overlay, id: uuid() }]
      }
    })),

  addTextOverlays: (overlays) =>
    set((state) => {
      if (overlays.length === 0) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          textOverlays: [
            ...state.project.textOverlays,
            ...overlays.map((o) => ({ ...o, id: uuid() }))
          ]
        }
      }
    }),

  updateTextOverlay: (id, patch) =>
    set((state) => {
      // 追従中に開始時刻を直接いじったら、相対位置の方を更新する。そうしないと
      // 直後の追従補正が古い相対位置から計算し直して、編集をなかったことにしてしまう。
      const timedById =
        patch.startTime !== undefined
          ? new Map(buildTimedClips(state.project).map((tc) => [tc.clip.id, tc]))
          : null
      return {
        ...pushHistory(state, `overlay:${id}`),
        project: {
          ...state.project,
          textOverlays: state.project.textOverlays.map((o) => {
            if (o.id !== id) return o
            const next = { ...o, ...patch }
            if (timedById && next.linkedClipId && patch.startTime !== undefined) {
              const tc = timedById.get(next.linkedClipId)
              if (tc) next.linkOffset = patch.startTime - tc.start
            }
            return next
          })
        }
      }
    }),

  updateTextOverlaysStyle: (ids, patch) =>
    set((state) => {
      const idSet = new Set(ids)
      if (idSet.size === 0) return state
      if (!state.project.textOverlays.some((o) => idSet.has(o.id))) return state
      return {
        // 何件掛けても履歴は1件。合体キーを付けているのは、色や数値を連続で
        // 動かしたときに1回の調整で履歴が埋まらないようにするため(1件用と同じ考え方)。
        ...pushHistory(state, 'overlaysStyle'),
        project: {
          ...state.project,
          textOverlays: state.project.textOverlays.map((o) =>
            idSet.has(o.id) ? { ...o, style: { ...o.style, ...patch } } : o
          )
        }
      }
    }),

  // 追従のON/OFF。ONにするときだけ相対位置を測り直す。OFFはその時点の絶対時刻で固定
  // されるので、時刻はいじらない。
  setTextOverlayLink: (id, clipId) =>
    set((state) => {
      const overlay = state.project.textOverlays.find((o) => o.id === id)
      if (!overlay) return state
      const tc = clipId ? buildTimedClips(state.project).find((t) => t.clip.id === clipId) : null
      if (clipId && !tc) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          textOverlays: state.project.textOverlays.map((o) =>
            o.id === id
              ? tc
                ? { ...o, linkedClipId: tc.clip.id, linkOffset: o.startTime - tc.start }
                : { ...o, linkedClipId: undefined, linkOffset: undefined }
              : o
          )
        }
      }
    }),

  removeTextOverlay: (id) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        textOverlays: state.project.textOverlays.filter((o) => o.id !== id)
      }
    })),

  shiftAllTextOverlays: (deltaSeconds) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        textOverlays: state.project.textOverlays.map((o) => {
          const duration = o.endTime - o.startTime
          const startTime = Math.max(0, o.startTime + deltaSeconds)
          return { ...o, startTime, endTime: startTime + duration }
        })
      }
    })),

  addAudioTrack: (name) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: [
          ...state.project.audioTracks,
          { id: uuid(), name, muted: false, volume: 1, duckingEnabled: false, clips: [] }
        ]
      }
    })),

  removeAudioTrack: (trackId) =>
    set((state) => {
      const track = state.project.audioTracks.find((t) => t.id === trackId)
      if (!track) return state
      const unlinked = track.clips
        .map((c) => c.linkedClipId)
        .filter((id): id is string => id != null)
      return {
        ...pushHistory(state),
        project: reattachClipsWithoutLinkedAudio(
          {
            ...state.project,
            audioTracks: state.project.audioTracks.filter((t) => t.id !== trackId)
          },
          unlinked
        )
      }
    }),

  toggleAudioTrackMute: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId ? { ...t, muted: !t.muted } : t
        )
      }
    })),

  toggleAudioTrackDucking: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId ? { ...t, duckingEnabled: !t.duckingEnabled } : t
        )
      }
    })),

  setAudioTrackVolume: (trackId, volume) =>
    set((state) => ({
      ...pushHistory(state, `trackVolume:${trackId}`),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) => (t.id === trackId ? { ...t, volume } : t))
      }
    })),

  addClipToAudioTrack: (trackId, assetId) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          audioTracks: state.project.audioTracks.map((t) => {
            if (t.id !== trackId) return t
            const startTime = audioTrackEnd(t)
            return {
              ...t,
              clips: [
                ...t.clips,
                { id: uuid(), assetId, startTime, inPoint: 0, outPoint: asset.duration }
              ]
            }
          })
        }
      }
    }),

  updateAudioClipStart: (trackId, clipId, startTime) =>
    set((state) => ({
      ...pushHistory(state, `audioStart:${clipId}`),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, startTime: Math.max(0, startTime), linkedClipId: undefined }
                    : c
                )
              }
            : t
        )
      }
    })),

  updateAudioClipTrim: (trackId, clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state, `audioTrim:${clipId}`),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? {
                        ...c,
                        inPoint: Math.max(0, inPoint),
                        outPoint: Math.max(0, outPoint),
                        linkedClipId: undefined
                      }
                    : c
                )
              }
            : t
        )
      }
    })),

  // Dragging a clip's left trim handle moves startTime and inPoint together in one
  // undoable step (as opposed to updateAudioClipStart + updateAudioClipTrim, which
  // would otherwise push two separate history entries for a single drag gesture).
  updateAudioClipStartAndTrim: (trackId, clipId, startTime, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? {
                        ...c,
                        startTime: Math.max(0, startTime),
                        inPoint: Math.max(0, inPoint),
                        outPoint: Math.max(0, outPoint),
                        linkedClipId: undefined
                      }
                    : c
                )
              }
            : t
        )
      }
    })),

  updateAudioClipVolume: (trackId, clipId, volume) =>
    set((state) => ({
      ...pushHistory(state, `audioVolume:${clipId}`),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId ? { ...c, volume: Math.max(0, volume) } : c
                )
              }
            : t
        )
      }
    })),

  updateAudioClipFade: (trackId, clipId, fadeIn, fadeOut) =>
    set((state) => ({
      // 音量と同じく合体キーを渡す。数値を続けて動かしても Undo は1件。
      ...pushHistory(state, `audioFade:${clipId}`),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, fadeIn: Math.max(0, fadeIn), fadeOut: Math.max(0, fadeOut) }
                    : c
                )
              }
            : t
        )
      }
    })),

  swapAudioClipAsset: (trackId, clipId, assetId, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, assetId, inPoint: 0, outPoint, linkedClipId: undefined }
                    : c
                )
              }
            : t
        )
      }
    })),

  unlinkAudioClip: (trackId, clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) => (c.id === clipId ? { ...c, linkedClipId: undefined } : c))
              }
            : t
        )
      }
    })),

  removeAudioClip: (trackId, clipId) =>
    set((state) => {
      const removed = state.project.audioTracks
        .find((t) => t.id === trackId)
        ?.clips.find((c) => c.id === clipId)
      if (!removed) return state
      return {
        ...pushHistory(state),
        project: reattachClipsWithoutLinkedAudio(
          {
            ...state.project,
            audioTracks: state.project.audioTracks.map((t) =>
              t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
            )
          },
          removed.linkedClipId ? [removed.linkedClipId] : []
        )
      }
    }),

  splitAudioClipAtTime: (trackId, clipId, absoluteTime) =>
    set((state) => {
      let didSplit = false
      const audioTracks = state.project.audioTracks.map((t) => {
        if (t.id !== trackId) return t
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.id !== clipId) return [c]
            const dur = audioClipDuration(c)
            if (absoluteTime <= c.startTime || absoluteTime >= c.startTime + dur) return [c]
            didSplit = true
            // タイムライン秒 → 素材秒は速度を掛ける。
            const splitLocal = c.inPoint + (absoluteTime - c.startTime) * (c.speed || 1)
            // フェードを両方へそのまま配ると、切れ目で音が一度落ちてまた上がる。
            // 全体の出入りが変わらないよう、前半にフェードイン・後半にフェードアウトだけ残す。
            return [
              {
                ...c,
                outPoint: splitLocal,
                linkedClipId: undefined,
                fadeOut: undefined
              },
              {
                ...c,
                id: uuid(),
                startTime: absoluteTime,
                inPoint: splitLocal,
                linkedClipId: undefined,
                fadeIn: undefined
              }
            ]
          })
        }
      })
      if (!didSplit) return state
      return { ...pushHistory(state), project: { ...state.project, audioTracks } }
    }),

  addVideoOverlayTrack: (name) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: [
          ...state.project.videoOverlayTracks,
          { id: uuid(), name, hidden: false, position: 'top-right', scale: 0.32, clips: [] }
        ]
      }
    })),

  removeVideoOverlayTrack: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.filter((t) => t.id !== trackId)
      }
    })),

  toggleVideoOverlayTrackHidden: (trackId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, hidden: !t.hidden } : t
        )
      }
    })),

  setVideoOverlayTrackPosition: (trackId, position) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, position } : t
        )
      }
    })),

  setVideoOverlayTrackScale: (trackId, scale) =>
    set((state) => ({
      ...pushHistory(state, `pipScale:${trackId}`),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, scale: Math.min(0.6, Math.max(0.1, scale)) } : t
        )
      }
    })),

  addClipToVideoOverlayTrack: (trackId, assetId) =>
    set((state) => {
      const asset = state.project.assets.find((a) => a.id === assetId)
      if (!asset) return state
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          videoOverlayTracks: state.project.videoOverlayTracks.map((t) => {
            if (t.id !== trackId) return t
            const startTime = videoOverlayTrackEnd(t)
            const outPoint = Math.min(asset.duration, 5)
            return {
              ...t,
              clips: [...t.clips, { id: uuid(), assetId, startTime, inPoint: 0, outPoint }]
            }
          })
        }
      }
    }),

  updateVideoOverlayClipStart: (trackId, clipId, startTime) =>
    set((state) => ({
      ...pushHistory(state, `pipStart:${clipId}`),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId ? { ...c, startTime: Math.max(0, startTime) } : c
                )
              }
            : t
        )
      }
    })),

  updateVideoOverlayClipTrim: (trackId, clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state, `pipTrim:${clipId}`),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? { ...c, inPoint: Math.max(0, inPoint), outPoint: Math.max(0, outPoint) }
                    : c
                )
              }
            : t
        )
      }
    })),

  updateVideoOverlayClipStartAndTrim: (trackId, clipId, startTime, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId
                    ? {
                        ...c,
                        startTime: Math.max(0, startTime),
                        inPoint: Math.max(0, inPoint),
                        outPoint: Math.max(0, outPoint)
                      }
                    : c
                )
              }
            : t
        )
      }
    })),

  swapVideoOverlayClipAsset: (trackId, clipId, assetId, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                clips: t.clips.map((c) =>
                  c.id === clipId ? { ...c, assetId, inPoint: 0, outPoint } : c
                )
              }
            : t
        )
      }
    })),

  removeVideoOverlayClip: (trackId, clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        videoOverlayTracks: state.project.videoOverlayTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
        )
      }
    })),

  splitVideoOverlayClipAtTime: (trackId, clipId, absoluteTime) =>
    set((state) => {
      let didSplit = false
      const videoOverlayTracks = state.project.videoOverlayTracks.map((t) => {
        if (t.id !== trackId) return t
        return {
          ...t,
          clips: t.clips.flatMap((c) => {
            if (c.id !== clipId) return [c]
            const dur = c.outPoint - c.inPoint
            if (absoluteTime <= c.startTime || absoluteTime >= c.startTime + dur) return [c]
            didSplit = true
            const splitLocal = c.inPoint + (absoluteTime - c.startTime)
            return [
              { ...c, outPoint: splitLocal },
              { ...c, id: uuid(), startTime: absoluteTime, inPoint: splitLocal }
            ]
          })
        }
      })
      if (!didSplit) return state
      return { ...pushHistory(state), project: { ...state.project, videoOverlayTracks } }
    }),

  addKeywordSeClips: (placements, newAssets) =>
    set((state) => {
      const existingTrack = state.project.audioTracks.find((t) => t.name === 'SE')
      const trackId = existingTrack?.id ?? uuid()
      const newClips: AudioTrackClip[] = placements.map((p) => ({
        id: uuid(),
        assetId: p.assetId,
        startTime: Math.max(0, p.startTime),
        inPoint: 0,
        outPoint: p.outPoint,
        volume: p.volume
      }))
      const audioTracks = existingTrack
        ? state.project.audioTracks.map((t) =>
            t.id === trackId ? { ...t, clips: [...t.clips, ...newClips] } : t
          )
        : [
            ...state.project.audioTracks,
            {
              id: trackId,
              name: 'SE',
              muted: false,
              volume: 1,
              duckingEnabled: false,
              clips: newClips
            }
          ]
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          // Registering the newly used SE files here keeps one scan = one undo step.
          assets: newAssets?.length
            ? [...state.project.assets, ...newAssets]
            : state.project.assets,
          audioTracks
        }
      }
    }),

  setBeatGrid: (grid) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, beatGrid: grid }
    })),

  clearBeatGrid: () =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, beatGrid: null }
    })),

  toggleBeatGridEnabled: () =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        beatGrid: state.project.beatGrid
          ? { ...state.project.beatGrid, enabled: !state.project.beatGrid.enabled }
          : null
      }
    })),

  applyTemplate: (template) =>
    set((state) => {
      let project = { ...state.project, aspectRatio: '9:16' as AspectRatio }
      const duration = totalDuration(project)

      if (template.jumpCutSeconds && duration > 0) {
        const newClips: Clip[] = []
        const segmentsByClipId = new Map<string, Clip[]>()
        for (const c of project.clips) {
          const segments: Clip[] = []
          let localStart = c.inPoint
          while (localStart < c.outPoint) {
            const localEnd = Math.min(localStart + template.jumpCutSeconds, c.outPoint)
            // Spread the source clip: rebuilding field by field dropped the crop
            // framing and, worse, the audioDetached flag — the recut clips then
            // played their embedded audio again on top of the separated track.
            segments.push({
              ...c,
              id: uuid(),
              inPoint: localStart,
              outPoint: localEnd,
              speed: 1,
              transitionIn: undefined
            })
            localStart = localEnd
          }
          segmentsByClipId.set(c.id, segments)
          newClips.push(...segments)
        }
        // The recut clips get fresh ids, so detached audio linked to the originals was
        // left pointing at clips that no longer exist. The link mirror then dropped the
        // links and the audio silently stopped following its clip: a later trim moved
        // the video but not the audio, desyncing everything after it with no warning.
        // Rebuild one linked audio clip per segment, the same way replaceClipRange does.
        const audioTracks = project.audioTracks.map((t) => {
          if (!t.clips.some((c) => c.linkedClipId && segmentsByClipId.has(c.linkedClipId))) {
            return t
          }
          return {
            ...t,
            clips: t.clips.flatMap((c) => {
              const segments = c.linkedClipId ? segmentsByClipId.get(c.linkedClipId) : undefined
              if (!segments) return [c]
              // Positions and trims are filled in by the link mirror right after.
              return segments.map((seg) => ({
                ...c,
                id: uuid(),
                inPoint: seg.inPoint,
                outPoint: seg.outPoint,
                linkedClipId: seg.id
              }))
            })
          }
        })
        project = { ...project, clips: newClips, audioTracks }
      }

      const total = totalDuration(project)
      const overlays: TextOverlay[] = template.segments.map((segment, i) => {
        const segmentSpan = total / template.segments.length
        return {
          id: uuid(),
          text: segment.label,
          startTime: i * segmentSpan,
          endTime: (i + 1) * segmentSpan,
          style: { ...template.captionStyle },
          source: 'manual'
        }
      })

      return { ...pushHistory(state), project: { ...project, textOverlays: overlays } }
    }),

  autoCutFromCandidates: (picks, template) =>
    set((state) => {
      const clips: Clip[] = picks.map((p) => ({
        id: uuid(),
        assetId: p.assetId,
        inPoint: p.start,
        outPoint: p.end,
        speed: 1
      }))
      const project: Project = {
        ...state.project,
        aspectRatio: '9:16',
        clips
      }
      const total = totalDuration(project)
      const overlays: TextOverlay[] = template.segments.map((segment, i) => {
        const segmentSpan = total / template.segments.length
        return {
          id: uuid(),
          text: segment.label,
          startTime: i * segmentSpan,
          endTime: (i + 1) * segmentSpan,
          style: { ...template.captionStyle },
          source: 'manual'
        }
      })
      return {
        ...pushHistory(state),
        project: { ...project, textOverlays: overlays },
        selectedClipId: null,
        multiSelectedClipIds: []
      }
    }),

  addRoughCutClips: (picks) =>
    set((state) => {
      const newClips: Clip[] = picks.map((p) => ({
        id: uuid(),
        assetId: p.assetId,
        inPoint: p.start,
        outPoint: p.end,
        speed: 1
      }))
      return {
        ...pushHistory(state),
        project: { ...state.project, clips: [...state.project.clips, ...newClips] }
      }
    }),

  // Adding the cut and its hook caption is one user action ("apply this plan"), so it
  // must be one undo step — otherwise undoing leaves the clips behind with the caption
  // gone, which is a state the user never asked for.
  applyShortPlan: (picks, overlays) =>
    set((state) => {
      if (picks.length === 0) return state
      const newClips: Clip[] = picks.map((p, i) => ({
        id: uuid(),
        assetId: p.assetId,
        inPoint: p.start,
        outPoint: p.end,
        speed: 1,
        // The first appended clip joins whatever was already on the timeline; putting a
        // transition there would change material the user did not ask us to touch.
        transitionIn: i === 0 ? undefined : p.transitionIn
      }))
      return {
        ...pushHistory(state),
        project: {
          ...state.project,
          clips: [...state.project.clips, ...newClips],
          textOverlays: [
            ...state.project.textOverlays,
            ...overlays.map((o) => ({ ...o, id: uuid() }))
          ]
        }
      }
    }),

  applyAutoEditPattern: (pattern) =>
    set((state) => {
      const newClips: Clip[] = pattern.segments.map((seg, i) => {
        const transitionType = seg.transitionIn ?? pattern.transition
        return {
          id: uuid(),
          assetId: seg.assetId,
          inPoint: seg.start,
          outPoint: seg.end,
          speed: 1,
          transitionIn:
            i === 0 || transitionType === 'none'
              ? undefined
              : { type: transitionType, duration: 0.5 }
        }
      })
      return {
        ...pushHistory(state),
        project: { ...state.project, clips: [...state.project.clips, ...newClips] }
      }
    })
}))

// Detached-audio clips (linkedClipId set) must follow their source clip: the main
// track lays clips back-to-back, so trimming/reordering/deleting ANY earlier clip
// shifts every later clip's absolute start — and a frozen startTime would silently
// export lip-synced audio seconds out of place. Mirror position and trim from the
// live source clip; unlink (freezing current values) when the source is gone.
function syncLinkedAudioClips(project: Project): Project {
  const hasLinks = project.audioTracks.some((t) => t.clips.some((c) => c.linkedClipId))
  if (!hasLinks) return project
  const timedById = new Map(buildTimedClips(project).map((tc) => [tc.clip.id, tc]))
  let changed = false
  const audioTracks = project.audioTracks.map((t) => {
    let trackChanged = false
    const clips = t.clips.map((c) => {
      if (!c.linkedClipId) return c
      const tc = timedById.get(c.linkedClipId)
      if (!tc) {
        trackChanged = true
        return { ...c, linkedClipId: undefined }
      }
      // 速度もミラーする。これが無いと本編だけ速くなって音が置き去りになる。
      const speed = tc.clip.speed || 1
      if (
        c.startTime === tc.start &&
        c.inPoint === tc.clip.inPoint &&
        c.outPoint === tc.clip.outPoint &&
        (c.speed || 1) === speed
      ) {
        return c
      }
      trackChanged = true
      return {
        ...c,
        startTime: tc.start,
        inPoint: tc.clip.inPoint,
        outPoint: tc.clip.outPoint,
        speed
      }
    })
    if (trackChanged) changed = true
    return trackChanged ? { ...t, clips } : t
  })
  return changed ? { ...project, audioTracks } : project
}

/**
 * クリップを作り直す操作(無音カット・分割)で、追従テロップのリンクを新しい断片へ張り直す。
 *
 * IDが変わるとリンクは**エラーも出さずに切れる**ので、元クリップ内での位置(素材の秒数)から
 * 行き先の断片を選び直す。切り捨てられた区間に載っていたテロップは、次に残った断片の先頭へ
 * 寄せる(テロップだけ元の場所に取り残されるより、内容の続きに付いていく方が近い)。
 */
/**
 * クリップ1つを断片の並びに置き換えた新しい `Project` を返す(履歴は積まない)。
 *
 * 単発(`replaceClipRange`)と一括(`replaceClipRanges`)で同じ規則を通すためにここへ出す。
 * 書き写すと、分離音声やテロップの張り直しが片方にだけ足されて差が開く。
 * 置き換えるものが無ければ受け取った `project` をそのまま返す(呼び出し側が
 * 参照の同一性で「変化なし」を判定する)。
 */
function applyClipReplacement(project: Project, clipId: string, newClips: Clip[]): Project {
  const idx = project.clips.findIndex((c) => c.id === clipId)
  if (idx === -1) return project
  const original = project.clips[idx]
  const clips = [...project.clips]
  clips.splice(idx, 1, ...newClips)
  const textOverlays = remapOverlayLinks(project.textOverlays, original, newClips)
  // Silence/filler/text-based cuts replace one clip with several. Detached audio
  // linked to the original must be rebuilt to match the surviving segments —
  // otherwise the video loses the cut-out parts while its separated audio plays
  // on unchanged, desyncing everything from that point on.
  const audioTracks = project.audioTracks.map((t) => {
    if (!t.clips.some((c) => c.linkedClipId === clipId)) return t
    return {
      ...t,
      clips: t.clips.flatMap((c) => {
        if (c.linkedClipId !== clipId) return [c]
        // Positions and trims are filled in by the link mirror right after.
        return newClips.map((seg) => ({
          ...c,
          id: uuid(),
          inPoint: seg.inPoint,
          outPoint: seg.outPoint,
          linkedClipId: seg.id
        }))
      })
    }
  })
  return { ...project, clips, audioTracks, textOverlays }
}

function remapOverlayLinks(
  overlays: TextOverlay[],
  original: Clip,
  newClips: Clip[]
): TextOverlay[] {
  if (!overlays.some((o) => o.linkedClipId === original.id)) return overlays
  const speed = original.speed || 1
  return overlays.map((o) => {
    if (o.linkedClipId !== original.id) return o
    const sourceTime = original.inPoint + (o.linkOffset ?? 0) * speed
    const inside = newClips.find((s) => sourceTime >= s.inPoint && sourceTime < s.outPoint)
    if (inside) {
      return {
        ...o,
        linkedClipId: inside.id,
        linkOffset: (sourceTime - inside.inPoint) / (inside.speed || 1)
      }
    }
    const after = newClips.find((s) => s.inPoint >= sourceTime)
    if (after) return { ...o, linkedClipId: after.id, linkOffset: 0 }
    return { ...o, linkedClipId: undefined, linkOffset: undefined }
  })
}

/**
 * 追従ONのテロップを、紐づけ先クリップの現在位置へ合わせ直す。
 *
 * テロップはタイムライン絶対秒を持つので、手前のクリップを詰めたり消したりすると
 * 内容とズレる。追従中のものはクリップ開始 + `linkOffset` で位置を決め直し、尺は保つ。
 * 紐づけ先が消えたら追従を外して、その時点の時刻で固定する(分離音声と同じ考え方)。
 */
function syncLinkedTextOverlays(project: Project): Project {
  const hasLinks = project.textOverlays.some((o) => o.linkedClipId)
  if (!hasLinks) return project
  const timedById = new Map(buildTimedClips(project).map((tc) => [tc.clip.id, tc]))
  let changed = false
  const textOverlays = project.textOverlays.map((o) => {
    if (!o.linkedClipId) return o
    const tc = timedById.get(o.linkedClipId)
    if (!tc) {
      changed = true
      return { ...o, linkedClipId: undefined, linkOffset: undefined }
    }
    const startTime = Math.max(0, tc.start + (o.linkOffset ?? 0))
    const endTime = startTime + (o.endTime - o.startTime)
    if (o.startTime === startTime && o.endTime === endTime) return o
    changed = true
    return { ...o, startTime, endTime }
  })
  return changed ? { ...project, textOverlays } : project
}

// Runs the mirror as a silent follow-up correction (no history entry of its own):
// the triggering edit already pushed one, and undo restores an already-synced
// snapshot so this stays a no-op on undo/redo. The clips-identity guard prevents
// recursion — the correction only touches audioTracks.
useProjectStore.subscribe((state, prevState) => {
  if (state.project === prevState.project) return
  const synced = syncLinkedTextOverlays(syncLinkedAudioClips(state.project))
  if (synced !== state.project) {
    useProjectStore.setState({ project: synced })
  }
})

export function getTotalDuration(project: Project): number {
  return totalDuration(project)
}

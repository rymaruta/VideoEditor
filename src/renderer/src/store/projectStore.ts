import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import { buildTimedClips } from '../lib/timelineMath'
import type {
  AspectRatio,
  AudioTrack,
  AudioTrackClip,
  AutoEditPattern,
  BeatGrid,
  Clip,
  EditTemplate,
  MediaAsset,
  PipPosition,
  Project,
  TextOverlay,
  Transition
} from '@shared/types'

const MAX_HISTORY = 50

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

  newProject: () => void
  loadProject: (project: Project, filePath: string) => void
  restoreAutosave: (project: Project) => void
  markSaved: (filePath: string) => void

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
  addClipToTimeline: (assetId: string) => void
  addTrimmedClipToTimeline: (assetId: string, inPoint: number, outPoint: number) => void
  updateClipTrim: (clipId: string, inPoint: number, outPoint: number) => void
  updateClipSpeed: (clipId: string, speed: number) => void
  updateClipTransition: (clipId: string, transition: Transition | undefined) => void
  detachClipAudio: (clipId: string) => void
  updateClipCrop: (clipId: string, fillCrop: boolean, cropCenter?: { x: number; y: number }) => void
  replaceClipRange: (clipId: string, newClips: Clip[]) => void
  splitClipAtTime: (clipId: string, absoluteTime: number) => void
  removeClip: (clipId: string) => void
  removeClips: (clipIds: string[]) => void
  duplicateClips: (clipIds: string[]) => void
  updateClipsSpeed: (clipIds: string[], speed: number) => void
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
  updateTextOverlay: (id: string, patch: Partial<TextOverlay>) => void
  removeTextOverlay: (id: string) => void
  shiftAllTextOverlays: (deltaSeconds: number) => void

  addAudioTrack: (name: string) => void
  removeAudioTrack: (trackId: string) => void
  toggleAudioTrackMute: (trackId: string) => void
  toggleAudioTrackDucking: (trackId: string) => void
  setAudioTrackVolume: (trackId: string, volume: number) => void
  addClipToAudioTrack: (trackId: string, assetId: string) => void
  updateAudioClipStart: (trackId: string, clipId: string, startTime: number) => void
  updateAudioClipVolume: (trackId: string, clipId: string, volume: number) => void
  swapAudioClipAsset: (trackId: string, clipId: string, assetId: string, outPoint: number) => void
  removeAudioClip: (trackId: string, clipId: string) => void
  addKeywordSeClips: (
    placements: { assetId: string; startTime: number; outPoint: number; volume: number }[]
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
  swapVideoOverlayClipAsset: (
    trackId: string,
    clipId: string,
    assetId: string,
    outPoint: number
  ) => void
  removeVideoOverlayClip: (trackId: string, clipId: string) => void

  setBeatGrid: (grid: BeatGrid) => void
  clearBeatGrid: () => void
  toggleBeatGridEnabled: () => void

  applyTemplate: (template: EditTemplate) => void
  autoCutFromCandidates: (
    picks: { assetId: string; start: number; end: number }[],
    template: EditTemplate
  ) => void
  addRoughCutClips: (picks: { assetId: string; start: number; end: number }[]) => void
  applyAutoEditPattern: (pattern: AutoEditPattern) => void
}

function totalDuration(project: Project): number {
  return project.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1), 0)
}

function audioTrackEnd(track: AudioTrack): number {
  return track.clips.reduce((max, c) => Math.max(max, c.startTime + (c.outPoint - c.inPoint)), 0)
}

function videoOverlayTrackEnd(track: Project['videoOverlayTracks'][number]): number {
  return track.clips.reduce((max, c) => Math.max(max, c.startTime + (c.outPoint - c.inPoint)), 0)
}

function pushHistory(state: ProjectState): Pick<ProjectState, 'past' | 'future' | 'isDirty'> {
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

  setMissingAssetIds: (ids) => set({ missingAssetIds: ids }),

  relinkAsset: (assetId, filePath, fileName, probe, thumbnailDataUrl) =>
    set((state) => ({
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
                thumbnailDataUrl
              }
            : a
        )
      },
      isDirty: true,
      missingAssetIds: state.missingAssetIds.filter((id) => id !== assetId)
    })),

  newProject: () =>
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
    }),

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

  markSaved: (filePath) => set({ currentFilePath: filePath, isDirty: false }),

  addAsset: (asset) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, assets: [...state.project.assets, asset] }
    })),

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

  updateClipTrim: (clipId, inPoint, outPoint) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        clips: state.project.clips.map((c) => (c.id === clipId ? { ...c, inPoint, outPoint } : c))
      }
    })),

  updateClipSpeed: (clipId, speed) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        // Clips with detached audio keep speed 1: the separated audio track has no
        // speed adjustment of its own, so changing the video's speed would desync it.
        clips: state.project.clips.map((c) =>
          c.id === clipId && !c.audioDetached ? { ...c, speed } : c
        )
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
            outPoint: clip.outPoint
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

  updateClipCrop: (clipId, fillCrop, cropCenter) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        clips: state.project.clips.map((c) =>
          c.id === clipId ? { ...c, fillCrop, cropCenter: cropCenter ?? c.cropCenter } : c
        )
      }
    })),

  replaceClipRange: (clipId, newClips) =>
    set((state) => {
      const idx = state.project.clips.findIndex((c) => c.id === clipId)
      if (idx === -1) return state
      const clips = [...state.project.clips]
      clips.splice(idx, 1, ...newClips)
      return { ...pushHistory(state), project: { ...state.project, clips } }
    }),

  splitClipAtTime: (clipId, absoluteTime) =>
    set((state) => {
      let elapsed = 0
      const clips: Clip[] = []
      for (const c of state.project.clips) {
        const dur = (c.outPoint - c.inPoint) / (c.speed || 1)
        if (c.id === clipId && absoluteTime > elapsed && absoluteTime < elapsed + dur) {
          const speed = c.speed || 1
          const splitLocal = c.inPoint + (absoluteTime - elapsed) * speed
          clips.push({ ...c, outPoint: splitLocal })
          clips.push({
            id: uuid(),
            assetId: c.assetId,
            inPoint: splitLocal,
            outPoint: c.outPoint,
            speed,
            audioDetached: c.audioDetached
          })
        } else {
          clips.push(c)
        }
        elapsed += dur
      }
      return { ...pushHistory(state), project: { ...state.project, clips } }
    }),

  removeClip: (clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: { ...state.project, clips: state.project.clips.filter((c) => c.id !== clipId) },
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
          clips: state.project.clips.filter((c) => !idSet.has(c.id))
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
          // Clips with detached audio keep speed 1: the separated audio track has no
          // speed adjustment of its own, so changing the video's speed would desync it.
          clips: state.project.clips.map((c) =>
            idSet.has(c.id) && !c.audioDetached ? { ...c, speed } : c
          )
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

  undo: () =>
    set((state) => {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      const idSet = new Set(previous.clips.map((c) => c.id))
      return {
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, MAX_HISTORY),
        project: previous,
        selectedClipId: idSet.has(state.selectedClipId ?? '') ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => idSet.has(id))
      }
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      const idSet = new Set(next.clips.map((c) => c.id))
      return {
        past: [...state.past, state.project].slice(-MAX_HISTORY),
        future: rest,
        project: next,
        selectedClipId: idSet.has(state.selectedClipId ?? '') ? state.selectedClipId : null,
        multiSelectedClipIds: state.multiSelectedClipIds.filter((id) => idSet.has(id))
      }
    }),

  addTextOverlay: (overlay) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        textOverlays: [...state.project.textOverlays, { ...overlay, id: uuid() }]
      }
    })),

  updateTextOverlay: (id, patch) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        textOverlays: state.project.textOverlays.map((o) => (o.id === id ? { ...o, ...patch } : o))
      }
    })),

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
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.filter((t) => t.id !== trackId)
      }
    })),

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
      ...pushHistory(state),
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
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
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

  updateAudioClipVolume: (trackId, clipId, volume) =>
    set((state) => ({
      ...pushHistory(state),
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
                  c.id === clipId ? { ...c, assetId, inPoint: 0, outPoint } : c
                )
              }
            : t
        )
      }
    })),

  removeAudioClip: (trackId, clipId) =>
    set((state) => ({
      ...pushHistory(state),
      project: {
        ...state.project,
        audioTracks: state.project.audioTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) } : t
        )
      }
    })),

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
      ...pushHistory(state),
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
      ...pushHistory(state),
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
      ...pushHistory(state),
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

  addKeywordSeClips: (placements) =>
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
      return { ...pushHistory(state), project: { ...state.project, audioTracks } }
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
        for (const c of project.clips) {
          let localStart = c.inPoint
          while (localStart < c.outPoint) {
            const localEnd = Math.min(localStart + template.jumpCutSeconds, c.outPoint)
            newClips.push({
              id: uuid(),
              assetId: c.assetId,
              inPoint: localStart,
              outPoint: localEnd,
              speed: 1
            })
            localStart = localEnd
          }
        }
        project = { ...project, clips: newClips }
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

export function getTotalDuration(project: Project): number {
  return totalDuration(project)
}

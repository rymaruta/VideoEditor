import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type {
  AspectRatio,
  AudioTrack,
  Clip,
  EditTemplate,
  MediaAsset,
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
    textOverlays: []
  }
}

interface ProjectState {
  project: Project
  past: Project[]
  future: Project[]
  currentFilePath: string | null
  isDirty: boolean
  selectedClipId: string | null
  clipboardClip: Clip | null
  playheadTime: number
  isPlaying: boolean
  seekRequest: { time: number; token: number } | null

  newProject: () => void
  loadProject: (project: Project, filePath: string) => void
  markSaved: (filePath: string) => void

  addAsset: (asset: MediaAsset) => void
  addClipToTimeline: (assetId: string) => void
  addTrimmedClipToTimeline: (assetId: string, inPoint: number, outPoint: number) => void
  updateClipTrim: (clipId: string, inPoint: number, outPoint: number) => void
  updateClipSpeed: (clipId: string, speed: number) => void
  updateClipTransition: (clipId: string, transition: Transition | undefined) => void
  replaceClipRange: (clipId: string, newClips: Clip[]) => void
  splitClipAtTime: (clipId: string, absoluteTime: number) => void
  removeClip: (clipId: string) => void
  moveClip: (clipId: string, direction: 'left' | 'right') => void
  moveClipToIndex: (clipId: string, targetIndex: number) => void
  setAspectRatio: (ratio: AspectRatio) => void
  selectClip: (clipId: string | null) => void
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

  addAudioTrack: (name: string) => void
  removeAudioTrack: (trackId: string) => void
  toggleAudioTrackMute: (trackId: string) => void
  toggleAudioTrackDucking: (trackId: string) => void
  setAudioTrackVolume: (trackId: string, volume: number) => void
  addClipToAudioTrack: (trackId: string, assetId: string) => void
  updateAudioClipStart: (trackId: string, clipId: string, startTime: number) => void
  removeAudioClip: (trackId: string, clipId: string) => void

  applyTemplate: (template: EditTemplate) => void
  autoCutFromCandidates: (
    picks: { assetId: string; start: number; end: number }[],
    template: EditTemplate
  ) => void
}

function totalDuration(project: Project): number {
  return project.clips.reduce((sum, c) => sum + (c.outPoint - c.inPoint) / (c.speed || 1), 0)
}

function audioTrackEnd(track: AudioTrack): number {
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
  clipboardClip: null,
  playheadTime: 0,
  isPlaying: false,
  seekRequest: null,

  newProject: () =>
    set({
      project: createBlankProject(),
      past: [],
      future: [],
      currentFilePath: null,
      isDirty: false,
      selectedClipId: null,
      clipboardClip: null,
      playheadTime: 0,
      isPlaying: false,
      seekRequest: null
    }),

  loadProject: (project, filePath) =>
    set({
      project,
      past: [],
      future: [],
      currentFilePath: filePath,
      isDirty: false,
      selectedClipId: null,
      clipboardClip: null,
      playheadTime: 0,
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
            speed
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
      selectedClipId: state.selectedClipId === clipId ? null : state.selectedClipId
    })),

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

  selectClip: (clipId) => set({ selectedClipId: clipId }),
  setPlayheadTime: (t) => set({ playheadTime: t }),
  setIsPlaying: (p) => set({ isPlaying: p }),
  seekTo: (t) =>
    set((state) => ({
      playheadTime: t,
      seekRequest: { time: t, token: (state.seekRequest?.token ?? 0) + 1 }
    })),

  copySelectedClip: () => {
    const state = get()
    const clip = state.project.clips.find((c) => c.id === state.selectedClipId)
    if (clip) set({ clipboardClip: clip })
  },

  pasteClip: () =>
    set((state) => {
      if (!state.clipboardClip) return state
      const newClip: Clip = {
        ...state.clipboardClip,
        id: uuid(),
        transitionIn: undefined
      }
      const idx = state.project.clips.findIndex((c) => c.id === state.selectedClipId)
      const clips = [...state.project.clips]
      if (idx === -1) {
        clips.push(newClip)
      } else {
        clips.splice(idx + 1, 0, newClip)
      }
      return {
        ...pushHistory(state),
        project: { ...state.project, clips },
        selectedClipId: newClip.id
      }
    }),

  undo: () =>
    set((state) => {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return {
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, MAX_HISTORY),
        project: previous
      }
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      return {
        past: [...state.past, state.project].slice(-MAX_HISTORY),
        future: rest,
        project: next
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
        selectedClipId: null
      }
    })
}))

export function getTotalDuration(project: Project): number {
  return totalDuration(project)
}

export interface MediaAsset {
  id: string
  filePath: string
  fileName: string
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
  thumbnailDataUrl?: string
}

export type TransitionType = 'none' | 'crossfade' | 'fade' | 'wipe'

export interface Transition {
  type: TransitionType
  duration: number
}

export interface Clip {
  id: string
  assetId: string
  inPoint: number
  outPoint: number
  speed: number
  transitionIn?: Transition
  fillCrop?: boolean
  cropCenter?: { x: number; y: number }
}

export type AspectRatio = '16:9' | '9:16'

export type TextPosition = 'top' | 'center' | 'bottom'

export type TextAnimation =
  'none' | 'fadeIn' | 'popIn' | 'slideInUp' | 'slideInDown' | 'bounce' | 'typewriter'

export type FontFamily =
  'sans-serif' | 'serif' | 'M PLUS Rounded 1c' | 'Noto Sans JP' | 'Noto Serif JP'

export interface TextStyle {
  fontFamily: FontFamily
  fontSize: number
  color: string
  position: TextPosition
  customPosition?: { x: number; y: number }
  rotation: number
  bold: boolean
  italic: boolean
  outline: boolean
  outlineColor: string
  outlineWidth: number
  shadow: boolean
  background: boolean
  backgroundColor: string
  backgroundOpacity: number
  letterSpacing: number
  animation: TextAnimation
  wordHighlight: boolean
  highlightColor: string
}

export interface TranscriptWord {
  start: number
  end: number
  text: string
}

export interface TextOverlay {
  id: string
  text: string
  startTime: number
  endTime: number
  style: TextStyle
  source?: 'manual' | 'auto'
  words?: TranscriptWord[]
}

export interface AudioTrackClip {
  id: string
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
}

export interface AudioTrack {
  id: string
  name: string
  muted: boolean
  volume: number
  duckingEnabled: boolean
  clips: AudioTrackClip[]
}

export interface BeatGrid {
  bpm: number
  offsetSeconds: number
  enabled: boolean
  sourceLabel: string
}

export interface Project {
  id: string
  name: string
  aspectRatio: AspectRatio
  assets: MediaAsset[]
  clips: Clip[]
  audioTracks: AudioTrack[]
  textOverlays: TextOverlay[]
  beatGrid?: BeatGrid | null
}

export interface TemplateSegment {
  label: string
  durationHint: string
  suggestion: string
}

export interface EditTemplate {
  id: string
  name: string
  description: string
  jumpCutSeconds?: number
  segments: TemplateSegment[]
  captionStyle: TextStyle
}

export type QualityPreset = 'high' | 'standard' | 'small'
export type ResolutionHeight = 480 | 720 | 1080 | 1440

export interface ExportSettings {
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
  outputPath: string
  loudnessNormalization?: boolean
}

export interface ExportProgress {
  percent: number
  stage: string
}

export interface MediaProbeResult {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
}

export interface SilenceRange {
  start: number
  end: number
}

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  words?: TranscriptWord[]
}

export interface HighlightCandidate {
  start: number
  end: number
  score: number
  hasSceneChange: boolean
  hasAudioPeak: boolean
}

export interface BpmAnalysisResult {
  bpm: number
  confidence: number
  offsetSeconds: number
}

export interface VoicevoxStyle {
  id: number
  name: string
}

export interface VoicevoxSpeaker {
  name: string
  styles: VoicevoxStyle[]
}

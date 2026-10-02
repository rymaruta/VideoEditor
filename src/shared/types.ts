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
  /**
   * Transcoded H.264 copy used only for preview playback, for sources whose codec
   * Chromium's <video> cannot decode (H.265/HEVC, ProRes, ...). Export always reads
   * `filePath`, so this never affects output quality. Absent when not needed.
   */
  proxyPath?: string
}

export type TransitionType = 'none' | 'crossfade' | 'fade' | 'wipe'

export interface Transition {
  type: TransitionType
  duration: number
}

/** クリップの分類用の色ラベル。未設定(undefined)は「色なし」 */
export type ClipColorLabel = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

export interface Clip {
  id: string
  assetId: string
  inPoint: number
  outPoint: number
  speed: number
  transitionIn?: Transition
  fillCrop?: boolean
  cropCenter?: { x: number; y: number }
  /** 余白を黒帯ではなく、素材をぼかした背景で埋める(`fillCrop` がONなら余白が無いので無効) */
  blurBackground?: boolean
  audioDetached?: boolean
  colorLabel?: ClipColorLabel
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
  /**
   * 縁取りのさらに外側に重ねる縁(内側から順)。バラエティの「白文字・色縁・外側に白縁」のような
   * 二重・三重の縁取りに使う。幅はそれぞれの縁の太さ(キャンバス上の px)。
   * 共通テロップレンダラ(`@shared/telop/render`)で描く。従来の書き出し(ASS)には出ない。
   */
  extraStrokes?: TelopStroke[]
  /** 指定すると文字の塗りを上(`color`)→下(この色)の縦グラデーションにする */
  gradientColor?: string
}

export interface TelopStroke {
  color: string
  width: number
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
  /** 追従先の本編クリップID。手前のクリップが伸縮してもこのクリップと一緒に動く */
  linkedClipId?: string
  /** 追従先クリップの開始からの相対秒。追従中はこちらが位置の基準になる */
  linkOffset?: number
}

export interface AudioTrackClip {
  id: string
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
  volume?: number
  /** 音声分離で作られたクリップが追従する本編クリップのID。手動編集でリンク解除される */
  linkedClipId?: string
  /**
   * 再生速度。未設定は等倍。分離音声は追従先クリップの速度がそのままミラーされるので、
   * 本編の速度を変えても音がズレない。タイムライン上の尺は (outPoint-inPoint)/speed。
   */
  speed?: number
  /** フェードインの秒数(タイムライン上の秒)。未設定・0 はフェードなし */
  fadeIn?: number
  /** フェードアウトの秒数(タイムライン上の秒)。未設定・0 はフェードなし */
  fadeOut?: number
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

export type PipPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

export interface VideoOverlayClip {
  id: string
  assetId: string
  startTime: number
  inPoint: number
  outPoint: number
}

export interface VideoOverlayTrack {
  id: string
  name: string
  hidden: boolean
  position: PipPosition
  scale: number
  clips: VideoOverlayClip[]
}

export interface Project {
  id: string
  name: string
  aspectRatio: AspectRatio
  assets: MediaAsset[]
  clips: Clip[]
  audioTracks: AudioTrack[]
  videoOverlayTracks: VideoOverlayTrack[]
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

/**
 * 書き出しの方式。
 * - `standard`: 企画全体を1回の ffmpeg で書き出す(従来の方式)
 * - `segmented`: 長尺向け。区間に分けて並列に書き出して繋ぐ(試験中。計画書 §4.3)
 */
export type ExportEngine = 'standard' | 'segmented'

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
  videoCodec: string
  audioCodec: string
  /** True when the preview <video> cannot decode this file and a proxy is required. */
  needsPreviewProxy: boolean
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

export interface LongFormWindow {
  start: number
  end: number
  score: number
}

/** ハイライト検出の感度。`normal` が従来の固定しきい値と同じ */
export type HighlightSensitivity = 'low' | 'normal' | 'high'

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

export type AutoEditStyle =
  'score' | 'jumpcut' | 'story' | 'longtake' | 'mix' | 'director' | 'beatsync' | 'reference'

export interface ReferenceStyleAnalysis {
  cutTimes: number[]
}

export interface AutoEditSegment {
  assetId: string
  start: number
  end: number
  score: number
  transitionIn?: TransitionType
}

export interface AutoEditPattern {
  id: string
  style: AutoEditStyle
  label: string
  description: string
  segments: AutoEditSegment[]
  transition: TransitionType
  totalDuration: number
}

export interface VoicevoxStyle {
  id: number
  name: string
}

export interface VoicevoxSpeaker {
  name: string
  styles: VoicevoxStyle[]
}

export interface EnvApiKeys {
  geminiApiKey: string
  youtubeApiKey: string
  jamendoClientId: string
  freesoundApiKey: string
}

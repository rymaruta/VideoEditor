export interface MediaAsset {
  id: string
  filePath: string
  fileName: string
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  thumbnailDataUrl?: string
}

export interface Clip {
  id: string
  assetId: string
  inPoint: number
  outPoint: number
}

export type AspectRatio = '16:9' | '9:16'

export type TextPosition = 'top' | 'center' | 'bottom'

export interface TextStyle {
  fontSize: number
  color: string
  position: TextPosition
  bold: boolean
  outline: boolean
}

export interface TextOverlay {
  id: string
  text: string
  startTime: number
  endTime: number
  style: TextStyle
}

export interface Project {
  id: string
  name: string
  aspectRatio: AspectRatio
  assets: MediaAsset[]
  clips: Clip[]
  textOverlays: TextOverlay[]
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

export interface ExportSettings {
  aspectRatio: AspectRatio
  resolutionHeight: 720 | 1080
  outputPath: string
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
}

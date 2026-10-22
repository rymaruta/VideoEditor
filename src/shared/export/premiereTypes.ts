import type { AspectRatio, Project, ResolutionHeight } from '../types'
import type { TelopLayerPayload } from '../telop/layer'
import type { ReviewMarkerSource } from './premiereMarkers'
import type { PremiereXmlResult } from './premiereXml'

/**
 * Premiere 用 XML の書き出しの頼み方と結果(画面 → main の IPC)。
 *
 * テロップの渡し方:
 * - `text`: 文字だけ(マーカーのコメントと SRT)
 * - `png`: それに加えて、見た目どおりの透過 PNG(絵が変わる区間ごと)を一番上のトラックに
 * - `prores`: それに加えて、見た目どおりの ProRes 4444(透過付き)1 本を一番上のトラックに
 */
export type PremiereTelopMode = 'text' | 'png' | 'prores'

export interface PremiereExportPayload {
  project: Project
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  /** `.xml` の書き出し先 */
  outputPath: string
  /** 29.97・59.94 のタイムコードをドロップフレームで(既定 true) */
  dropFrame?: boolean
  telopMode: PremiereTelopMode
  /** テロップの文字をマーカーにも入れる(既定 true) */
  telopMarkers?: boolean
  /** 要確認の項目(マーカーにする) */
  reviews?: ReviewMarkerSource[]
  /** 見た目どおりのテロップの層(`png`・`prores` のとき) */
  telopLayer?: TelopLayerPayload | null
}

export interface PremiereExportResult {
  xmlPath: string
  srtPath: string
  /** 見た目どおりのテロップ(PNG のフォルダか、ProRes の動画) */
  telopPath?: string
  warnings: string[]
  stats: PremiereXmlResult['stats']
}

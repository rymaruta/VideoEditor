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
  /**
   * XML の隣へ写した素材(アプリの設定フォルダの中のファイル。ノイズ除去後のマイクの音 など)。
   * `dir` は `名前_media/`、`files` は写した名前と写した元
   */
  media?: { dir: string; files: { name: string; from: string }[] }
  warnings: string[]
  stats: PremiereXmlResult['stats']
}

/**
 * XML の隣へ写した素材の知らせ(書き出しの画面に出す)。写したものが無ければ null
 */
export function premiereMediaNote(media: PremiereExportResult['media']): string | null {
  if (!media || media.files.length === 0) return null
  const folder = media.dir.split(/[/\\]/).pop() ?? media.dir
  const names = media.files.map((f) => f.name)
  const shown =
    names.slice(0, 3).join('・') + (names.length > 3 ? ` ほか ${names.length - 3} 本` : '')
  return (
    `アプリの中のファイル(ノイズ除去後のマイクの音など)${names.length} 本を「${folder}」に写し、XML はそちらを指しています(${shown})。` +
    '別の PC で開くときは、XML と一緒にこのフォルダも渡してください'
  )
}

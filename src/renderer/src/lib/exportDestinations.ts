import {
  EXPORT_FORMAT_EXT,
  type AspectRatio,
  type ExportFormat,
  type QualityPreset,
  type ResolutionHeight
} from '@shared/types'
import { safeFileBaseName } from '@shared/fileName'
import type { ExportLoudness } from '../store/settingsStore'

/**
 * 書き出しの画面の左の「行き先」。押すと、今ある書き出しの設定(解像度・画質・音量・形式・縦横比)を
 * その行き先の組み合わせにする。新しい設定の仕組みは作らず、設定の値を並べ替えるだけ。
 * 今の設定がどの行き先に当たるかは、設定の値から決める(手で変えて外れたら、どれも選んでいない)。
 */
export type DestinationId = 'youtube' | 'short' | 'master' | 'audio' | 'xml'

export interface DestinationSettings {
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
  loudness: ExportLoudness
  format: ExportFormat
  xml: boolean
}

export interface Destination {
  id: DestinationId
  name: string
  sub: string
}

export const DESTINATIONS: readonly Destination[] = [
  { id: 'youtube', name: 'YouTube', sub: '1920×1080 · H.264 · −14 LUFS' },
  { id: 'short', name: 'ショート・リール', sub: '1080×1920(縦)· H.264 · −14 LUFS' },
  { id: 'master', name: '高画質(保存用)', sub: '元の解像度 · ProRes 422' },
  { id: 'audio', name: '音声のみ', sub: 'WAV · 48 kHz · 24 bit' },
  { id: 'xml', name: 'Premiere Pro 用 XML', sub: 'Premiere Pro で続きを編集' }
]

const HEIGHTS: readonly ResolutionHeight[] = [480, 720, 1080, 1440, 2160]

type SizedAsset = { width: number; height: number; hasVideo?: boolean; still?: boolean }

/** 映像の素材(静止画・音だけの素材を除く) */
function videoAssets(assets: readonly SizedAsset[]): SizedAsset[] {
  return assets.filter((a) => a.hasVideo !== false && !a.still && a.width > 0 && a.height > 0)
}

/**
 * 「元の解像度」の書き出しの高さ: 一番大きな映像の素材が縮まずに収まる、一番小さい段
 * (1280×534 の素材なら 720 の段 = 1280×720)。収まる段が無ければ一番大きい段。素材が無ければ 1080
 */
export function sourceHeight(assets: readonly SizedAsset[]): ResolutionHeight {
  const list = videoAssets(assets)
  if (list.length === 0) return 1080
  const long = Math.max(...list.map((a) => Math.max(a.width, a.height)))
  const short = Math.max(...list.map((a) => Math.min(a.width, a.height)))
  const fit = HEIGHTS.find((h) => h >= short && Math.round((h * 16) / 9) >= long)
  return fit ?? HEIGHTS[HEIGHTS.length - 1]
}

/** 「元の解像度」の縦横比: 一番大きな映像の素材の向き。素材が無ければ今のまま */
export function sourceAspect(assets: readonly SizedAsset[], fallback: AspectRatio): AspectRatio {
  const list = videoAssets(assets)
  if (list.length === 0) return fallback
  const biggest = list.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
  return biggest.height > biggest.width ? '9:16' : '16:9'
}

/** 行き先を選んだときの設定(変えないものは今のまま) */
export function destinationSettings(
  id: DestinationId,
  current: DestinationSettings,
  sourceH: ResolutionHeight,
  sourceA: AspectRatio
): DestinationSettings {
  switch (id) {
    case 'youtube':
      return {
        ...current,
        aspectRatio: '16:9',
        resolutionHeight: 1080,
        quality: 'high',
        loudness: 'web',
        format: 'mp4',
        xml: false
      }
    case 'short':
      return {
        ...current,
        aspectRatio: '9:16',
        resolutionHeight: 1080,
        quality: 'high',
        loudness: 'web',
        format: 'mp4',
        xml: false
      }
    case 'master':
      return {
        ...current,
        aspectRatio: sourceA,
        resolutionHeight: sourceH,
        format: 'prores',
        xml: false
      }
    case 'audio':
      return { ...current, format: 'wav', xml: false }
    case 'xml':
      return { ...current, xml: true }
  }
}

/** 今の設定が当たる行き先(当たらなければ null。手で変えた組み合わせ) */
export function matchDestination(
  s: DestinationSettings,
  sourceH: ResolutionHeight,
  sourceA: AspectRatio
): DestinationId | null {
  if (s.xml) return 'xml'
  if (s.format === 'wav') return 'audio'
  if (s.format === 'prores')
    return s.resolutionHeight === sourceH && s.aspectRatio === sourceA ? 'master' : null
  if (s.resolutionHeight !== 1080 || s.quality !== 'high' || s.loudness !== 'web') return null
  return s.aspectRatio === '9:16' ? 'short' : 'youtube'
}

/** ショートの長さの上限(秒)。超えていたら画面で知らせる(書き出しは止めない) */
export const SHORT_MAX_SEC = 60

/** 書き出し1回ぶんの組み合わせ(今すぐ書き出すものと、キューに並べるもの) */
export interface ExportJob {
  aspectRatio: AspectRatio
  resolutionHeight: ResolutionHeight
  quality: QualityPreset
  format: ExportFormat
  /** 範囲だけを書き出す(タイムラインの秒)。無ければ全体 */
  range?: { start: number; end: number }
}

const QUALITY_NAME: Record<QualityPreset, string> = {
  high: '高画質',
  standard: '標準',
  small: '軽量'
}

/** 範囲を名前に入れる形(00h01m50s のような、ファイル名に使える字だけ) */
function rangeTag(range: { start: number; end: number }): string {
  const t = (s: number): string => {
    const v = Math.max(0, Math.floor(s))
    const h = Math.floor(v / 3600)
    const m = Math.floor((v % 3600) / 60)
    const sec = v % 60
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
  }
  return `${t(range.start)}-${t(range.end)}`
}

/**
 * キューの書き出し先のファイル名。一覧に見えている違い(縦横比・解像度・画質・形式・範囲)をすべて名前に入れる。
 * どれかが欠けると、2つのジョブが同じ名前になり、後のジョブが先のファイルを黙って上書きする。
 */
export function jobFileName(projectName: string, job: ExportJob): string {
  const aspect = job.aspectRatio === '9:16' ? '9x16' : '16x9'
  const range = job.range ? `_${rangeTag(job.range)}` : ''
  const body =
    job.format === 'wav'
      ? `${safeFileBaseName(projectName)}_音声${range}`
      : job.format === 'prores'
        ? `${safeFileBaseName(projectName)}_${aspect}_${job.resolutionHeight}p_ProRes${range}`
        : `${safeFileBaseName(projectName)}_${aspect}_${job.resolutionHeight}p_${QUALITY_NAME[job.quality]}${range}`
  return `${body}.${EXPORT_FORMAT_EXT[job.format]}`
}

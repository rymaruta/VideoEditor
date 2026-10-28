import type { ExportFormat, QualityPreset } from './types'

/**
 * 区間ごとの書き出しに要るディスクの見込み。
 *
 * 一時フォルダには、区間ごとの映像(最終の形式。連結の最後まで残る)と音(浮動小数のまま可逆に縮めた WavPack)、
 * 速さを変えた音を置く。最後に映像を連結して出力を書く間は、区間の映像と出力が両方ある。
 * 映像の大きさは絵柄で数倍変わるので、**少なめ**に見込む(止めるのは確実に足りないときだけ。
 * 見込みを越えて足りなくなったときは、書き出しの途中で空きを見て止める: `LOW_DISK_RESERVE_BYTES`)
 */

/** 区間ごとの音の 1 秒あたりの上限(48kHz・2ch・32bit 浮動小数。WavPack で縮めても、雑音ばかりの音はほぼ縮まない) */
export const SEGMENT_AUDIO_BYTES_PER_SEC = 48000 * 2 * 4

/**
 * 映像の 1 画素・1 フレームあたりのビット数の**少なめ**の見込み(x264 veryfast・画質の段ごと)。
 * 実測: 動きの少ない記録映像(3時間・480p・30fps・標準)で 0.011、動きの多い撮影素材は 0.06〜0.13。
 * 止めるのは確実に足りないときだけにしたいので、下のほうに合わせる
 */
const VIDEO_BITS_PER_PIXEL: Record<QualityPreset, number> = {
  high: 0.02,
  standard: 0.01,
  small: 0.005
}

/** 出力の音(AAC 192kbps)の 1 秒あたり */
const OUTPUT_AUDIO_BYTES_PER_SEC = 192_000 / 8

/** 書き出しの途中で、ディスクの空きがこれを切ったら止める(OS や他のアプリが書けなくなる前に) */
export const LOW_DISK_RESERVE_BYTES = 512 * 1024 * 1024

export interface SegmentedDiskEstimate {
  /** 一時フォルダに要る量(区間の映像・音・速さを変えた音) */
  temp: number
  /** 出力に要る量 */
  output: number
}

export function estimateSegmentedExportBytes(p: {
  durationSec: number
  width: number
  height: number
  fps: number
  quality: QualityPreset
  /** 速さを変えた音を先に書く長さ(秒)の合計 */
  stretchedSec?: number
  /** 書き出す形式(既定は MP4) */
  format?: ExportFormat
}): SegmentedDiskEstimate {
  const sec = Number.isFinite(p.durationSec) && p.durationSec > 0 ? p.durationSec : 0
  const format = p.format ?? 'mp4'
  const bpp =
    format === 'prores'
      ? PRORES_BITS_PER_PIXEL
      : (VIDEO_BITS_PER_PIXEL[p.quality] ?? VIDEO_BITS_PER_PIXEL.standard)
  const fps = Number.isFinite(p.fps) && p.fps > 0 ? p.fps : 30
  const video =
    format === 'wav' ? 0 : (Math.max(0, p.width) * Math.max(0, p.height) * fps * bpp * sec) / 8
  const stretched = Math.max(0, p.stretchedSec ?? 0) * SEGMENT_AUDIO_BYTES_PER_SEC
  const outAudio = format === 'mp4' ? OUTPUT_AUDIO_BYTES_PER_SEC : PCM24_AUDIO_BYTES_PER_SEC
  return {
    temp: Math.ceil(video + sec * SEGMENT_AUDIO_BYTES_PER_SEC + stretched),
    output: Math.ceil(video + sec * outAudio)
  }
}

/**
 * ProRes 422 の 1 画素・1 フレームあたりのビット数の**少なめ**の見込み。
 * Apple の公表値は 1920×1080・29.97fps で 147Mbps(約 2.37)。絵柄で 2 割ほど上下するので下に寄せる
 */
const PRORES_BITS_PER_PIXEL = 2.0

/** 書き出しの音(PCM 24bit・48kHz・ステレオ)の 1 秒あたり。ProRes の .mov と WAV で使う */
export const PCM24_AUDIO_BYTES_PER_SEC = 48000 * 2 * 3

/**
 * 書き出しの画面に出す「推定サイズ」の目安(中ほどの値)。止めるための見込み(`estimateSegmentedExportBytes`)は
 * 少なめに寄せてあるので画面には使わない。x264 は絵柄で数倍変わるので、撮影素材のよくある値に置く
 * (実測: 動きの少ない記録映像 0.011、動きの多い撮影素材 0.06〜0.13 の間)。WAV と ProRes は形式で決まる
 */
export function estimateOutputBytes(p: {
  durationSec: number
  width: number
  height: number
  fps: number
  quality: QualityPreset
  format: ExportFormat
}): number {
  const sec = Number.isFinite(p.durationSec) && p.durationSec > 0 ? p.durationSec : 0
  const fps = Number.isFinite(p.fps) && p.fps > 0 ? p.fps : 30
  const pixels = Math.max(0, p.width) * Math.max(0, p.height) * fps * sec
  if (p.format === 'wav') return Math.ceil(sec * PCM24_AUDIO_BYTES_PER_SEC)
  if (p.format === 'prores')
    return Math.ceil((pixels * PRORES_TYPICAL_BITS_PER_PIXEL) / 8 + sec * PCM24_AUDIO_BYTES_PER_SEC)
  const bpp = TYPICAL_BITS_PER_PIXEL[p.quality] ?? TYPICAL_BITS_PER_PIXEL.standard
  return Math.ceil((pixels * bpp) / 8 + sec * OUTPUT_AUDIO_BYTES_PER_SEC)
}

/** 画面の目安に使う、x264 の画質の段ごとのよくある値 */
const TYPICAL_BITS_PER_PIXEL: Record<QualityPreset, number> = {
  high: 0.08,
  standard: 0.05,
  small: 0.025
}

/** 画面の目安に使う ProRes 422 の値(Apple の公表値) */
const PRORES_TYPICAL_BITS_PER_PIXEL = 2.37

/** バイト数を「1.2 GB」「850 MB」の形で */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** 書き出す前に、空きが見込みに足りないときの文面 */
export function notEnoughDiskMessage(where: string, need: number, free: number): string {
  return (
    `ディスクの空きが足りないため、書き出しを始めませんでした。` +
    `${where}に約 ${formatBytes(need)} 必要ですが、空きは ${formatBytes(free)} です。` +
    `いらないファイルを消すか、空きの多いドライブへ書き出してください。`
  )
}

/** 書き出しの途中で空きが残り少なくなって止めたときの文面 */
export function diskRanLowMessage(free: number): string {
  return (
    `書き出しの途中でディスクの空きが残り ${formatBytes(free)} になったため、止めました` +
    `(作りかけのファイルは消しました)。いらないファイルを消すか、空きの多いドライブへ書き出してください。`
  )
}

/**
 * 一時フォルダをどこに作るか。OS の一時フォルダ(`base`)に区間のファイルが入りきるならそこ、入らず
 * 書き出し先のドライブなら入るなら書き出し先のフォルダ(Windows で C: が小さく、書き出し先が大きな D: のとき)。
 * どちらにも入らなければ、分かる文面を返す。空きが測れない(null)ドライブは足りるとみなす(止めない)
 *
 * @param together OS の一時フォルダと書き出し先が同じドライブか
 */
export function chooseWorkLocation(p: {
  need: SegmentedDiskEstimate
  baseFree: number | null
  outFree: number | null
  together: boolean
}): { where: 'base' | 'output' } | { error: string } {
  const { need, baseFree, outFree, together } = p
  const R = LOW_DISK_RESERVE_BYTES
  const outputFits = outFree === null || outFree - need.output >= R
  if (together) {
    const total = need.temp + need.output
    if (baseFree === null || baseFree - total >= R) return { where: 'base' }
    return {
      error: notEnoughDiskMessage('一時ファイルと書き出す動画で、このドライブ', total + R, baseFree)
    }
  }
  if (!outputFits)
    return { error: notEnoughDiskMessage('書き出し先のドライブ', need.output + R, outFree ?? 0) }
  if (baseFree === null || baseFree - need.temp >= R) return { where: 'base' }
  if (outFree === null || outFree - (need.temp + need.output) >= R) return { where: 'output' }
  return {
    error: notEnoughDiskMessage(
      '一時ファイル(OS の一時フォルダか書き出し先のドライブ)',
      need.temp + R,
      Math.max(baseFree, outFree - need.output)
    )
  }
}

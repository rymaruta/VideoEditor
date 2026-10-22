import type { Clip, MediaAsset, TextOverlay } from '@shared/types'
import { projectFrameRate } from '@shared/frameRate'
import { stripTelopMarkup } from '@shared/telop/render'

/**
 * インスペクタの見出しと数値のカード(今のテロップから数える)。
 * 時刻のコマ数は企画のフレームレート(タイムラインの目盛り・書き出しと同じ数え方)で出す
 */
export interface TelopMetrics {
  /** 時刻順で何枚目か(1 から) */
  nth: number
  total: number
  /** 空白を除いた字数(描かれる文字だけ。`**強調**` などの印は数えない) */
  chars: number
  /** いちばん長い行の字数 */
  longestLine: number
  /** 表示の秒数 */
  shownSec: number
  /** 読む速さ(字/秒)。表示が 0 秒なら 0 */
  cps: number
  /** 時刻を出すときのフレームレート */
  fps: number
}

export function telopMetrics(
  overlay: TextOverlay,
  project: {
    textOverlays: readonly TextOverlay[]
    clips: readonly Clip[]
    assets: readonly MediaAsset[]
  }
): TelopMetrics {
  const order = [...project.textOverlays].sort((a, b) => a.startTime - b.startTime)
  const plain = stripTelopMarkup(overlay.text)
  const chars = plain.replace(/\s/g, '').length
  const shownSec = Math.max(0, overlay.endTime - overlay.startTime)
  return {
    nth: order.findIndex((x) => x.id === overlay.id) + 1,
    total: order.length,
    chars,
    longestLine: Math.max(0, ...plain.split('\n').map((l) => l.trim().length)),
    shownSec,
    cps: shownSec > 0 ? chars / shownSec : 0,
    fps: projectFrameRate(project.clips as Clip[], project.assets as MediaAsset[])
  }
}

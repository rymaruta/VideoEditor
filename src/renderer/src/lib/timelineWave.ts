import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { buildTimedClips, audioClipDuration } from './timelineMath'

/**
 * 確認の画面・書き出しの画面の小さな波形(タイムラインの区間の音の大きさ)。
 *
 * 持ち主の決まり: **音があるものには必ず波形を出す**。タイムラインの波形と同じ素材ごとの「素の値」
 * (`generateWaveformPeaks`。main が素材ごとに1回だけ作ってディスクに覚える)から、区間に掛かる
 * 音のクリップ(本編の音・音声トラック)ごとに列を頼み、列ごとの大きい方を取る(混ぜた音の目安)。
 */

/** 区間に掛かる音の1切れ(素材の秒とタイムラインの秒) */
export interface WavePiece {
  filePath: string
  srcStart: number
  srcEnd: number
  tlStart: number
  tlEnd: number
}

/** タイムラインの [start, end) に鳴る音の切れ(本編の音・ミュートしていない音声トラック) */
export function timelineAudioPieces(project: Project, start: number, end: number): WavePiece[] {
  if (!(end > start)) return []
  const assetOf = new Map(project.assets.map((a) => [a.id, a]))
  const out: WavePiece[] = []
  const push = (
    filePath: string,
    tlStart: number,
    tlEnd: number,
    inPoint: number,
    speed: number
  ): void => {
    const a = Math.max(start, tlStart)
    const b = Math.min(end, tlEnd)
    if (b - a <= 1e-3) return
    const sp = speed > 0 ? speed : 1
    out.push({
      filePath,
      tlStart: a,
      tlEnd: b,
      srcStart: inPoint + (a - tlStart) * sp,
      srcEnd: inPoint + (b - tlStart) * sp
    })
  }
  for (const tc of buildTimedClips(project)) {
    if (!tc.asset.hasAudio || tc.clip.audioDetached) continue
    push(tc.asset.filePath, tc.start, tc.end, tc.clip.inPoint, tc.clip.speed || 1)
  }
  for (const t of project.audioTracks) {
    if (t.muted) continue
    for (const c of t.clips) {
      const asset = assetOf.get(c.assetId)
      if (!asset?.hasAudio) continue
      push(asset.filePath, c.startTime, c.startTime + audioClipDuration(c), c.inPoint, c.speed || 1)
    }
  }
  return out
}

/** 列ごとの大きさ(0〜1): 山(外側・淡く)と平均(内側・濃く)。タイムラインの波形と同じ 2 段 */
export interface WaveLevels {
  peak: Float32Array
  rms: Float32Array
}

/** 1 列の値の並びを、区間の列へ大きい方で写す */
function mergeInto(out: Float32Array, levels: ArrayLike<number>, c0: number, c1: number): void {
  const n = levels.length
  if (n === 0) return
  for (let c = c0; c < c1; c++) {
    const k = Math.min(n - 1, Math.floor(((c - c0 + 0.5) / Math.max(1, c1 - c0)) * n))
    const v = levels[k]
    if (Number.isFinite(v) && v > out[c]) out[c] = Math.min(1, v)
  }
}

/**
 * 切れごとの列の大きさ(0〜1)を、区間全体の `columns` 列へ並べる(重なりは大きい方)。
 * 切れの列の数は、区間に占める長さの割合で決める(`piecesColumns`)
 */
export function mergePieceLevels(
  pieces: readonly {
    piece: WavePiece
    levels: { peak: ArrayLike<number>; rms: ArrayLike<number> }
  }[],
  start: number,
  end: number,
  columns: number
): WaveLevels {
  const cols = Math.max(1, Math.round(columns))
  const out = { peak: new Float32Array(cols), rms: new Float32Array(cols) }
  const span = end - start
  if (!(span > 0)) return out
  for (const { piece, levels } of pieces) {
    const c0 = Math.max(0, Math.floor(((piece.tlStart - start) / span) * cols))
    const c1 = Math.min(cols, Math.ceil(((piece.tlEnd - start) / span) * cols))
    mergeInto(out.peak, levels.peak, c0, c1)
    mergeInto(out.rms, levels.rms, c0, c1)
  }
  return out
}

/** 切れに頼む列の数(区間に占める割合ぶん。1 列以上・上限あり) */
export function pieceColumns(
  piece: WavePiece,
  start: number,
  end: number,
  columns: number
): number {
  const span = end - start
  if (!(span > 0)) return 1
  return Math.max(1, Math.min(2048, Math.ceil(((piece.tlEnd - piece.tlStart) / span) * columns)))
}

/** 頼んだ結果(同じ切れ・同じ列は使い回す。古いものから捨てる) */
const cache = new Map<string, Promise<WaveLevels>>()
const CACHE_LIMIT = 400

function pieceLevels(piece: WavePiece, cols: number): Promise<WaveLevels> {
  const key = `${piece.filePath}|${piece.srcStart.toFixed(3)}|${piece.srcEnd.toFixed(3)}|${cols}`
  const hit = cache.get(key)
  if (hit) return hit
  const p = window.api
    .generateWaveformPeaks(piece.filePath, piece.srcStart, piece.srcEnd, cols)
    .then((peaks) => {
      const n = peaks.columns
      const out = { peak: new Float32Array(n), rms: new Float32Array(n) }
      for (const ch of peaks.channels)
        for (let i = 0; i < n; i++) {
          const v = Math.max(Math.abs(ch.max[i] ?? 0), Math.abs(ch.min[i] ?? 0))
          if (v > out.peak[i]) out.peak[i] = v
          const r = Math.abs(ch.rms[i] ?? 0)
          if (r > out.rms[i]) out.rms[i] = r
        }
      return out
    })
  p.catch(() => cache.delete(key))
  cache.set(key, p)
  if (cache.size > CACHE_LIMIT) {
    const first = cache.keys().next().value
    if (first !== undefined) cache.delete(first)
  }
  return p
}

/**
 * 区間 [start, end) の波形の列(0〜1)。音の切れが無ければ null(波形を出さない)。
 * 頼んでいる間は前の結果を出し続ける(区間を動かすたびに消えて点滅しない)
 */
export function useWaveLevels(
  pieces: readonly WavePiece[],
  start: number,
  end: number,
  columns: number
): WaveLevels | null {
  const key = `${start.toFixed(3)}|${end.toFixed(3)}|${columns}|${pieces
    .map(
      (p) => `${p.filePath}:${p.srcStart.toFixed(2)}:${p.tlStart.toFixed(2)}:${p.tlEnd.toFixed(2)}`
    )
    .join(',')}`
  const [state, setState] = useState<{ key: string; levels: WaveLevels } | null>(null)
  useEffect(() => {
    if (pieces.length === 0) return
    let alive = true
    void Promise.all(
      pieces.map((piece) =>
        pieceLevels(piece, pieceColumns(piece, start, end, columns)).then(
          (levels) => ({ piece, levels }),
          () => ({ piece, levels: { peak: new Float32Array(0), rms: new Float32Array(0) } })
        )
      )
    ).then((list) => {
      if (alive) setState({ key, levels: mergePieceLevels(list, start, end, columns) })
    })
    return () => {
      alive = false
    }
    // 切れ・区間・列は key に入っている
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (pieces.length === 0) return null
  const cols = Math.max(1, Math.round(columns))
  return state?.levels ?? { peak: new Float32Array(cols), rms: new Float32Array(cols) }
}

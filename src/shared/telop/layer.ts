import type { Sequence, TelopItem } from '../sequence/types'
import { telopVisualKey, type TelopSource } from './render'

/**
 * 書き出し用の「テロップの層」を、**絵が変わる区間(ラン)**の並びにする。
 *
 * テロップは毎フレーム描かない。出ている間ずっと同じ絵なら1枚で済み、変わるのは
 * 出入り・アニメーション中(数フレームずつ)・カラオケの語の切り替わり・タイプライターの
 * 1文字ごとだけ。ここで「同じ絵が続く区間」を作り、描く側(画面のプロセス)は
 * 区間ごとに1枚だけ描く。同じ絵の区間は同じ画像を使い回す(`imageKey`)。
 *
 * 時刻はフレームで扱う。フレーム f の絵は「f 枚目の頭の時刻」で決める。
 */
export interface TelopRun {
  startFrame: number
  /** 含まない */
  endFrame: number
  /** 同じ値なら同じ絵 */
  imageKey: string
  /** 描くテロップ(重なり順=下から) */
  itemIds: string[]
}

/**
 * 書き出しへ渡すテロップの層(画面のプロセスが描いた画像と、それを出す区間)。
 * 画像は枠と同じ大きさの透明 PNG で、0番は何も描いていない透明の1枚。
 */
export interface TelopLayerPayload {
  width: number
  height: number
  images: Uint8Array[]
  runs: { startFrame: number; endFrame: number; image: number }[]
}

/**
 * 区間 [start, end) のテロップの層を、ffmpeg の concat demuxer に渡す一覧にする。
 * 何も出ていない時間は0番(透明)で埋めるので、一覧の長さは区間の長さちょうどになる。
 * 秒は「フレーム数 × 1フレーム」で書く(29.97fps でも ffmpeg 側の `fps` で格子へ戻る)。
 */
export function telopConcatList(
  runs: TelopLayerPayload['runs'],
  imagePaths: readonly string[],
  startFrame: number,
  endFrame: number,
  fps: { num: number; den: number }
): string | null {
  const secs = (frames: number): string => ((frames * fps.den) / fps.num).toFixed(9)
  const q = (p: string): string => `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
  const entries: { image: number; frames: number }[] = []
  let cursor = startFrame
  let any = false
  for (const r of runs) {
    if (r.endFrame <= startFrame || r.startFrame >= endFrame) continue
    const s = Math.max(r.startFrame, startFrame)
    const e = Math.min(r.endFrame, endFrame)
    if (s > cursor) entries.push({ image: 0, frames: s - cursor })
    entries.push({ image: r.image, frames: e - s })
    any = true
    cursor = e
  }
  if (!any) return null
  if (cursor < endFrame) entries.push({ image: 0, frames: endFrame - cursor })
  const lines = ['ffconcat version 1.0']
  for (const e of entries)
    lines.push(`file ${q(imagePaths[e.image])}`, `duration ${secs(e.frames)}`)
  // 最後の1枚は、もう一度並べないと長さが効かない(concat demuxer の決まり)
  lines.push(`file ${q(imagePaths[entries[entries.length - 1].image])}`)
  return lines.join('\n') + '\n'
}

/** v2 のテロップを、描画関数へ渡す形(時刻はシーケンスの絶対秒)にする */
export function telopItemSource(item: TelopItem, fps: number): TelopSource {
  const start = item.startFrame / fps
  return {
    text: item.text,
    startTime: start,
    endTime: (item.startFrame + item.durationFrames) / fps,
    style: item.style,
    ...(item.words
      ? { words: item.words.map((w) => ({ ...w, start: start + w.start, end: start + w.end })) }
      : {})
  }
}

/** 表示中のトラックのテロップを、下のトラックから順に並べる */
export function visibleTelops(seq: Sequence): TelopItem[] {
  return seq.videoTracks
    .filter((t) => !t.hidden)
    .flatMap((t) => t.items.filter((i): i is TelopItem => i.kind === 'telop'))
}

export function planTelopRuns(seq: Sequence, canvasHeight: number): TelopRun[] {
  const fps = seq.fps.num / seq.fps.den
  const telops = visibleTelops(seq)
  if (telops.length === 0) return []
  const sources = new Map(telops.map((t) => [t.id, telopItemSource(t, fps)]))
  // 出ている間の全フレームを、出入りの順に掃いて調べる(アニメーション・カラオケ・
  // タイプライターの切り替わりを取りこぼさないため)。出ているものだけを持ち歩くので、
  // テロップの数が増えても1フレームあたりの手間は「その瞬間に出ている数」で済む。
  const byStart = [...telops].sort((a, b) => a.startFrame - b.startFrame)
  const order = new Map(telops.map((t, i) => [t.id, i]))
  const runs: TelopRun[] = []
  let active: TelopItem[] = []
  let next = 0
  let f = byStart[0].startFrame
  while (next < byStart.length || active.length > 0) {
    if (active.length === 0 && next < byStart.length && f < byStart[next].startFrame) {
      f = byStart[next].startFrame
    }
    let changed = false
    while (next < byStart.length && byStart[next].startFrame <= f) {
      active.push(byStart[next++])
      changed = true
    }
    const before = active.length
    active = active.filter((t) => f < t.startFrame + t.durationFrames)
    if (changed || active.length !== before) {
      active.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
    }
    if (active.length > 0) {
      const time = (f + 1e-9) / fps
      const key = active
        .map((t) => `${t.id}:${telopVisualKey(sources.get(t.id)!, time, canvasHeight)}`)
        .join(',')
      const last = runs[runs.length - 1]
      if (last && last.endFrame === f && last.imageKey === key) {
        last.endFrame = f + 1
      } else {
        runs.push({
          startFrame: f,
          endFrame: f + 1,
          imageKey: key,
          itemIds: active.map((t) => t.id)
        })
      }
    }
    f++
  }
  return runs
}

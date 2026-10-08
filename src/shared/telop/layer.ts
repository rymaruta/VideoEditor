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
 *
 * 画像の渡し方は2通り:
 * - `stagedId`: 描きながら少しずつ main へ送って、main が一時フォルダへ書いておいたもの
 *   (`TelopLayerStageApi`)。**書き出しはこちらを使う。** 1000枚のテロップ・ループの動きで
 *   画像は数万枚・数 GB になり、1回の IPC に載せると画面のプロセスが落ちる
 *   (実測: 60分・1000枚・1080p で 24,595枚。100枚ぶんの 2,228枚で既に 145MB、
 *    送る瞬間に画面のプロセスが 1.03GB。1000枚ぶんは送れずに画面のプロセスが消えた)
 * - `images`: 画像そのもの(テスト・小さい層用)
 */
export interface TelopLayerPayload {
  width: number
  height: number
  images?: Uint8Array[]
  /** main の一時フォルダに書いてある画像の束の番号(`beginTelopLayer` が返したもの) */
  stagedId?: string
  /** `stagedId` のときの画像の枚数(0番の透明を含む) */
  imageCount?: number
  runs: { startFrame: number; endFrame: number; image: number }[]
}

/** 層の画像の枚数(どちらの渡し方でも) */
export function telopLayerImageCount(layer: TelopLayerPayload): number {
  return layer.stagedId !== undefined ? (layer.imageCount ?? 0) : (layer.images?.length ?? 0)
}

/**
 * 画面のプロセスから main へ、層の画像を少しずつ送る口(preload が `window.api` に出す)。
 * `append` は main がディスクに書き終えてから返るので、送る側が溜め込みすぎない(背圧)
 */
export interface TelopLayerStageApi {
  begin: (width: number, height: number) => Promise<string>
  append: (id: string, firstIndex: number, images: Uint8Array[]) => Promise<void>
  release: (id: string) => Promise<void>
}

/**
 * 区間 [start, end) のテロップの層を、ffmpeg の concat demuxer に渡す一覧にする。
 * 何も出ていない時間は0番(透明)で埋めるので、一覧の長さは区間の長さちょうどになる。
 * 秒は「フレーム数 × 1フレーム」をマイクロ秒で書く(29.97fps でも ffmpeg 側の `fps` で格子へ戻る)。
 */
export function telopConcatList(
  runs: TelopLayerPayload['runs'],
  imagePaths: readonly string[],
  startFrame: number,
  endFrame: number,
  fps: { num: number; den: number }
): string | null {
  // 区間の頭からの時刻(マイクロ秒に丸める)。ffmpeg は duration をマイクロ秒で切り捨てて足していくので、
  // 1枚ごとに秒を書くと端数の切り捨てが積もり、長い書き出しの後半でテロップが1フレーム以上早く出る
  // (実測: 60fps で 3万枚並べると 208 秒あたりから1フレーム早い)。区切りの時刻を丸めてから差を書く
  const us = (frames: number): number => Math.round((frames * fps.den * 1e6) / fps.num)
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
  // 画像の読み込みは既定で 25fps の時刻の刻み(40ms)になり、切り替わりの時刻が 40ms 単位に丸められる
  // (30fps で6回に1回、テロップが1フレーム遅れて出る。60fps では1フレームの動きが落ちる)。
  // 1枚ごとにシーケンスのフレームレートを指定して、刻みをフレームに揃える
  const rate = `option framerate ${fps.num}/${fps.den}`
  let at = 0
  for (const e of entries) {
    const d = us(at + e.frames) - us(at)
    at += e.frames
    lines.push(`file ${q(imagePaths[e.image])}`, rate, `duration ${(d / 1e6).toFixed(6)}`)
  }
  // 最後の1枚は、もう一度並べないと長さが効かない(concat demuxer の決まり)
  lines.push(`file ${q(imagePaths[entries[entries.length - 1].image])}`, rate)
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

/**
 * テロップの「絵の中身」の印。文字・見た目・カラオケの語(出始めからの相対時刻)が同じなら同じ印。
 *
 * 同じ印のテロップは、同じ動きの状態(`telopVisualKey`)なら**同じ絵**になる
 * (`drawTelop` が時刻から使うのは、出始めからの経過・消えるまでの残り・カラオケの語の
 * 切り替わりだけで、どれも `telopVisualKey` に入っている)。印を ID の代わりに絵の鍵へ入れると、
 * 番組で何度も出る同じテロップ(出演者の名前・「えー！？」などのリアクション)を1枚に描くだけで済む
 */
function contentSignature(source: TelopSource): string {
  const words = source.words?.map((w) => [
    w.text,
    w.start - source.startTime,
    w.end - source.startTime
  ])
  return JSON.stringify([source.text, source.style, words ?? null])
}

export function planTelopRuns(seq: Sequence, canvasHeight: number): TelopRun[] {
  const fps = seq.fps.num / seq.fps.den
  const telops = visibleTelops(seq)
  if (telops.length === 0) return []
  const sources = new Map(telops.map((t) => [t.id, telopItemSource(t, fps)]))
  // 長い印(見た目の JSON)を毎フレームつなげないよう、中身ごとに短い番号へ置き換える
  const contentIds = new Map<string, string>()
  const contentOf = new Map(
    telops.map((t) => {
      const sig = contentSignature(sources.get(t.id)!)
      let id = contentIds.get(sig)
      if (id === undefined) {
        id = `c${contentIds.size}`
        contentIds.set(sig, id)
      }
      return [t.id, id]
    })
  )
  // 出ている間の全フレームを、出入りの順に掃いて調べる(アニメーション・カラオケ・
  // タイプライターの切り替わりを取りこぼさないため)。出ているものだけを持ち歩くので、
  // テロップの数が増えても1フレームあたりの手間は「その瞬間に出ている数」で済む。
  const byStart = [...telops].sort((a, b) => a.startFrame - b.startFrame)
  // 重なったときの上下は、v1 の並び順(z。プレビューの描く順)。無ければ段の順
  const order = new Map(telops.map((t, i) => [t.id, t.z ?? i]))
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
        .map(
          (t) => `${contentOf.get(t.id)}:${telopVisualKey(sources.get(t.id)!, time, canvasHeight)}`
        )
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

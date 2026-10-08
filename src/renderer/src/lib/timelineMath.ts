import type { Clip, MediaAsset, Project } from '@shared/types'
import { computeMainTrackLayout } from '@shared/mainTrackLayout'
import { projectFrameRate } from '@shared/frameRate'

export interface TimedClip {
  clip: Clip
  asset: MediaAsset
  start: number
  end: number
}

export function buildTimedClips(project: Project): TimedClip[] {
  const assetById = new Map(project.assets.map((a) => [a.id, a]))
  let cursor = 0
  const result: TimedClip[] = []
  for (const clip of project.clips) {
    const asset = assetById.get(clip.assetId)
    if (!asset) continue
    const duration = (clip.outPoint - clip.inPoint) / (clip.speed || 1)
    result.push({ clip, asset, start: cursor, end: cursor + duration })
    cursor += duration
  }
  return result
}

export function findTimedClipAt(timedClips: TimedClip[], time: number): TimedClip | null {
  for (const tc of timedClips) {
    if (time >= tc.start && time < tc.end) return tc
  }
  return timedClips.length > 0 ? timedClips[timedClips.length - 1] : null
}

/**
 * 並びの中から、id が一致するクリップを探す。
 *
 * `buildTimedClips` は呼ぶたびに新しいオブジェクトを作り直す。前に受け取った `TimedClip` を
 * `indexOf` や `===` で照合すると、テロップを1つ足しただけで「同じクリップ」が見つからなく
 * なる。どのクリップかの照合は必ず id で行う。
 */
export function findTimedClipById(
  timedClips: TimedClip[],
  clipId: string | null | undefined
): TimedClip | null {
  if (clipId == null) return null
  return timedClips.find((tc) => tc.clip.id === clipId) ?? null
}

/**
 * `current` の次に再生されるクリップ。`current` が並びに無い(消された)ときは null を返す。
 * 「見つからない = 先頭」にはしない — 消えたクリップの次は決められない。
 */
export function nextTimedClip(
  timedClips: TimedClip[],
  current: TimedClip | null | undefined
): TimedClip | null {
  if (!current) return null
  const index = timedClips.findIndex((tc) => tc.clip.id === current.clip.id)
  if (index < 0) return null
  return timedClips[index + 1] ?? null
}

/**
 * Shift+クリックで選ぶ範囲のクリップID。`anchorClipId` が起点、`clickedIndex` が今クリックした位置。
 *
 * 起点は**位置ではなく id** で受け取る。並びはドラッグ移動・分割・取り消しで変わるので、
 * 位置で覚えると「最後に触ったクリップ」とは別のクリップが起点になり、
 * **触っていないクリップまで選ばれて、そのまま Delete で消える**。
 * 起点が今の並びに居ないときは範囲を**決められない**ので、先頭や -1 のような
 * 「それらしい位置」を作らずに空を返す(呼び出し側はクリックした1本だけを選ぶ)。
 */
export function rangeSelectionIds(
  timedClips: TimedClip[],
  anchorClipId: string | null | undefined,
  clickedIndex: number
): string[] {
  if (!Number.isInteger(clickedIndex)) return []
  if (clickedIndex < 0 || clickedIndex >= timedClips.length) return []
  const anchorIndex = timedClips.findIndex((tc) => tc.clip.id === anchorClipId)
  if (anchorIndex < 0) return []
  const lo = Math.min(anchorIndex, clickedIndex)
  const hi = Math.max(anchorIndex, clickedIndex)
  return timedClips.slice(lo, hi + 1).map((tc) => tc.clip.id)
}

export function totalTimelineDuration(timedClips: TimedClip[]): number {
  return timedClips.length === 0 ? 0 : timedClips[timedClips.length - 1].end
}

/**
 * **書き出したファイル**の尺(秒)。つなぎは2本のクリップを重ねるので、
 * タイムラインの総尺(`totalTimelineDuration`)よりつなぎの実効秒数ぶん短くなる。
 * 実効秒数は書き出しと同じ関数(`effectiveTransitionSeconds`)から出す。
 *
 * **位置の計算には使わないこと。** タイムライン上の配置・シーク・サムネ抽出は
 * タイムライン秒の総尺側が正しい。これは「尺として見せる」ためだけの値。
 */
export function totalExportDuration(timedClips: TimedClip[]): number {
  return exportLayoutOf(timedClips).totalExportDuration
}

/**
 * 各クリップの手前に実際に掛かる繋ぎの秒数(先頭は 0)。書き出しと同じ数え方
 * (`computeMainTrackLayout`。尺をフレームに丸めてから繋ぎの長さを決める)。
 * タイムラインの秒のまま数えると、とても短いクリップへの繋ぎが、プレビューでだけ掛かっていた
 */
export function exportTransitionSeconds(timedClips: TimedClip[]): number[] {
  return exportLayoutOf(timedClips).transitionSeconds
}

/**
 * クロスフェードの間に、消えていく側として映す絵(どのクリップの、素材の何秒か)。
 * index 番目のクリップの繋ぎ(長さ t 秒)の、頭から elapsed 秒の所。
 *
 * 書き出しは「それまでにつないだ絵の最後の t 秒」と混ぜる。繋ぎが手前のクリップより長いと、
 * その範囲は手前のクリップの頭より前(さらに手前のクリップ)にかかる。手前のクリップだけを見て
 * 素材の位置を出すと、そのクリップの頭(inPoint)より前を指し、書き出しと違う絵が映っていた
 */
export function crossfadeSourceAt(
  timedClips: TimedClip[],
  index: number,
  elapsed: number,
  t: number
): { timed: TimedClip; localTime: number } | null {
  if (index <= 0 || index >= timedClips.length) return null
  // 繋ぎの頭から数えて、手前の絵の終わりから何秒戻った所か
  let back = Math.max(0, t - elapsed)
  let j = index - 1
  // 飛ばすクリップが自分の繋ぎを持っていれば、書き出しではそのぶん手前と重なって早く終わっている
  const seconds = exportTransitionSeconds(timedClips)
  while (j > 0 && back > timedClips[j].end - timedClips[j].start) {
    back -= timedClips[j].end - timedClips[j].start - (seconds[j] ?? 0)
    j--
  }
  const timed = timedClips[j]
  const speed = timed.clip.speed || 1
  return {
    timed,
    localTime: Math.max(timed.clip.inPoint, timed.clip.outPoint - back * speed)
  }
}

function exportLayoutOf(timedClips: TimedClip[]): ReturnType<typeof computeMainTrackLayout> {
  const clips = timedClips.map((tc) => tc.clip)
  const fps = projectFrameRate(
    clips,
    timedClips.map((tc) => tc.asset)
  )
  return computeMainTrackLayout(clips, fps)
}

/**
 * 素材の秒数を、そのクリップのタイムライン上の秒数へ直す。
 *
 * 解析(無音検出・文字起こし)が返すのは**素材の秒**で、利用者が見ているタイムラインと
 * 書き出しは**タイムラインの秒**。速度を変えたクリップでは両者が倍率ぶん食い違うので、
 * **画面に数字を出すときは必ずここを通す**（2倍速のクリップで「4.0秒削除します」と
 * 出しながら実際には 2.0秒しか縮まない、という食い違いが起きていた）。
 * 削る位置そのものは素材の秒のままでよい（`buildCutSegments` は素材空間で動く）。
 *
 * 速度が未設定・0以下・数値でないときは等倍として扱う。0除算で Infinity を
 * 画面に出さないため。
 */
export function toTimelineSeconds(sourceSeconds: number, speed?: number): number {
  const rate = Number.isFinite(speed) && (speed as number) > 0 ? (speed as number) : 1
  return sourceSeconds / rate
}

/**
 * タイムライン上の秒数を、そのクリップの**素材の秒数**へ直す(`toTimelineSeconds` の逆)。
 *
 * **切る位置は必ずこの向きの換算が要る。** 利用者が押すのはタイムライン上の位置で、
 * `inPoint`/`outPoint` は素材の秒だからで、等倍のクリップでだけ両者が一致する。
 * 同じ式が分割の経路に3つ(本編・音声レーン・分離音声)あり、**そのうち1つだけ
 * 掛け忘れていた**ので、規則はここ1箇所に置く。
 * (実測: 素材8秒を0.5倍速(タイムライン16秒)にして音声を分離し、タイムライン12秒で
 *  分割すると、分離音声側だけ切る位置が素材 12秒と算出される。素材は8秒しか無いので
 *  「範囲外なので切らない」に落ち、**後半のクリップだけ紐づく音声が無くなる**——
 *  後半は `audioDetached` のままなので書き出しは無音になり、素材7秒にあったビープが
 *  出力から丸ごと消えていた。掛け直すと素材6秒で正しく割れる)
 *
 * 速度が未設定・0以下・数値でないときは等倍として扱う(`toTimelineSeconds` と同じ規則)。
 */
export function toSourceSeconds(timelineSeconds: number, speed?: number): number {
  const rate = Number.isFinite(speed) && (speed as number) > 0 ? (speed as number) : 1
  return timelineSeconds * rate
}

/**
 * 音声クリップがタイムライン上で占める秒数。速度を掛けたぶん短く(長く)なる。
 * 素材の秒数(`outPoint - inPoint`)とは別物なので、尺を測るときは必ずこちらを使う。
 */
export function audioClipDuration(clip: {
  inPoint: number
  outPoint: number
  speed?: number
}): number {
  return (clip.outPoint - clip.inPoint) / (clip.speed || 1)
}

/**
 * 音声トラックに `duration` 秒のクリップを `desiredStart` から置きたいとき、既存クリップと
 * 重ならない最初の位置を返す。
 *
 * 重ねて置かないのは、音声クリップが `startTime` で絶対配置されるため。同じ時刻に同じ尺の
 * クリップを重ねると後から置いた方が前を完全に覆い、**覆われた方は画面から見えず選択も
 * 削除もできないのに音だけ二重に鳴る**。ワンクリックで足せるUIでは事故になる。
 * 重ねたい場合は、置いたあとに手でドラッグして動かせる。
 */
export function findFreeAudioStart(
  existing: { startTime: number; inPoint: number; outPoint: number; speed?: number }[],
  desiredStart: number,
  duration: number
): number {
  let start = Number.isFinite(desiredStart) ? Math.max(0, desiredStart) : 0
  if (!Number.isFinite(duration) || duration <= 0) return start
  const occupied = existing
    .map((c) => ({ start: c.startTime, end: c.startTime + audioClipDuration(c) }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start)
  // 前から順に見て、ぶつかるたびにその相手の直後へ逃がす。開始順に並べてあるので、
  // 一度で通り抜けたところが最初の空き。
  for (const range of occupied) {
    if (range.start < start + duration && range.end > start) start = range.end
  }
  return start
}

/**
 * ロールトリムのドラッグで、次に動かす量(タイムラインの秒)。
 * 動いた量はいまの出点から測る(端で止められた分を「動かした」と数えると、戻すときに
 * 境目がマウスより先へ動いていた)
 */
export function rollDragStep(
  wantedSec: number,
  startOut: number,
  currentOut: number,
  leftSpeed: number
): number {
  return wantedSec - (currentOut - startOut) / (leftSpeed || 1)
}

/**
 * 速さの選択欄に出す値と選択肢。収録を並べたクリップは、時計のずれを直した速さ(1.00005 など)を
 * 持つので、選択肢にそのままでは無く、選択欄が先頭の選択肢(0.25x)を出していた。
 * ごく近い選択肢があればそれを出し(ずれの直しは 0.2% 以内)、無ければその速さを選択肢に足す
 */
export function speedSelectChoices(
  speed: number,
  options: readonly number[]
): { value: number; options: number[] } {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1
  const near = options.find((o) => Math.abs(o - s) <= 0.005)
  if (near !== undefined) return { value: near, options: [...options] }
  return { value: s, options: [...options, s].sort((a, b) => a - b) }
}

/**
 * 「タイムライン全体を表示」のためだけに許す、倍率の下限。
 * 0.01(40px/秒で 0.4px/秒)では、1時間ほどより長い回がレーンに入らなかった
 * (3時間 = 4,320px。1,400px のレーンで 2,900px ほどが画面の外に残った)。
 * 0.0005 = 0.02px/秒 で、10時間でも 720px に収まる
 */
export const MIN_FIT_ZOOM = 0.0005

/** 総尺 `total` 秒を幅 `width` px に収める倍率(1 = `basePxPerSecond` px/秒)。上限・下限で止める */
export function fitZoomFor(
  total: number,
  width: number,
  basePxPerSecond: number,
  maxZoom: number
): number {
  const zoom = width / (total * basePxPerSecond)
  if (!Number.isFinite(zoom) || zoom <= 0) return MIN_FIT_ZOOM
  return Math.min(maxZoom, Math.max(MIN_FIT_ZOOM, zoom))
}

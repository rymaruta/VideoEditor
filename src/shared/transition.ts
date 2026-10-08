import type { TransitionType } from './types'
import { frameRoundedDurations } from './frameRate'

/**
 * 繋ぎ(トランジション)の**実際に掛かる長さ**を決める規則。
 *
 * 書き出し(`xfade`/`acrossfade`)と画面(プレビューの重ね合わせ)が**同じ数字**を使うための
 * 共通の置き場。書き写すと片方だけ育って黙ってズレる——プレビュー側は繋ぎを
 * **一度も読んでいなかった**ので、指定しても画面はただのカットのままだった。
 *
 * 指定した長さがそのまま掛かるとは限らない。`xfade` は**どちらの入力よりも短くないと
 * 書き出し全体を失敗させる**ので、隣のクリップに入らないぶんは詰めている。
 */

/** これ未満はハードカットにする(`xfade` に渡すには短すぎる) */
export const MIN_TRANSITION_SECONDS = 0.02

/**
 * 隣のクリップの長さからこれだけ引いた値を上限にする。
 * ちょうど同じ長さだと `xfade` が受け付けないので、必ず短くしておく。
 */
export const TRANSITION_SAFETY_MARGIN = 0.05

export interface TransitionSpec {
  type: TransitionType
  duration: number
}

/**
 * i 番目のクリップの**手前**に掛かる繋ぎの実効秒数を、並び全体から求める。
 *
 * 上限は「ここまで畳み込んだ長さ」と「これから足すクリップの長さ」の**短いほう**から
 * 余裕を引いた値(書き出しの畳み込みと同じ)。畳み込んだ長さは繋ぎのぶん重なって
 * 縮んでいくので、**1つ前のクリップの長さではなく累積**で見る必要がある。
 *
 * 返すのは常に `durations` と同じ長さの配列。先頭(0番)は手前が無いので必ず 0。
 * 数値でない長さ・繋ぎが無い/`none`/0秒はすべて 0(＝ハードカット)。
 */
export function effectiveTransitionSeconds(
  durations: readonly number[],
  transitions: readonly (TransitionSpec | null | undefined)[]
): number[] {
  const out = new Array<number>(durations.length).fill(0)
  if (durations.length === 0) return out
  const safe = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
  let accumulated = safe(durations[0])
  for (let i = 1; i < durations.length; i++) {
    const incoming = safe(durations[i])
    const spec = transitions[i]
    // `Number.isFinite` を通すのは意図的。ここを `duration > 0` だけにすると
    // **Infinity が「上限いっぱいの繋ぎ」として通る**(`Math.min(Infinity, 上限)` = 上限)。
    // NaN は `> 0` が false なので元から繋ぎ無し扱いで、同じ壊れた値なのに
    // 片方だけ通るのは筋が悪い。壊れた `.veproj` から来た数は揃えて捨てる。
    const wants =
      !!spec && spec.type !== 'none' && Number.isFinite(spec.duration) && spec.duration > 0
    const maxDur = Math.min(accumulated, incoming) - TRANSITION_SAFETY_MARGIN
    const t = wants ? Math.min(spec.duration, maxDur) : 0
    // 短すぎるものは掛けない。ここで 0 に倒しておかないと、累積の引き算だけ
    // 進んで**画面と書き出しで重なりの数が食い違う**。
    const effective = t >= MIN_TRANSITION_SECONDS ? t : 0
    out[i] = effective
    accumulated = accumulated + incoming - effective
  }
  return out
}

/**
 * 並びの中の1本について、**指定した秒数と実際に掛かる秒数**を返す。
 *
 * `xfade`/`acrossfade` は隣のどちらよりも短くないと書き出しごと失敗するので、
 * 入らないぶんは**黙って詰めて**いる。ところが入力欄は指定した値のまま
 * (上限も 2 の固定値)なので、**指定の半分以下しか掛かっていないことに気付けない**
 * (実測: 1.0秒に詰めたクリップの次に 2.0秒のクロスフェードを指定すると、
 *  実効は **0.95秒**で、書き出しは 11秒のタイムラインに対し **10.05秒**。
 *  それでも欄は 2.0 のままで警告も出ない)。
 *
 * 画面に「実際は何秒か」を出すための共通の入り口。**書き出しと同じ関数**
 * (`effectiveTransitionSeconds`)から出すので、表示と出来上がりがズレない。
 * 見つからないクリップ・繋ぎ無しは `null`。
 */
export function transitionSecondsForClip(
  clips: readonly {
    id: string
    inPoint: number
    outPoint: number
    speed?: number
    transitionIn?: TransitionSpec | null
  }[],
  clipId: string,
  /**
   * 書き出しのフレームレート。渡すと、書き出しと同じく尺をフレームに丸めてから数える
   * (渡さないとタイムラインの秒のまま。とても短いクリップへの繋ぎが、書き出しでは掛からないのに
   * 「実際は 0.03 秒だけ掛かります」と出ていた)
   */
  fps?: number
): { specified: number; effective: number } | null {
  const index = clips.findIndex((c) => c.id === clipId)
  if (index < 0) return null
  const spec = clips[index].transitionIn
  if (!spec || spec.type === 'none') return null
  const timeline = clips.map((c) => (c.outPoint - c.inPoint) / (c.speed || 1))
  const durations = fps && fps > 0 ? frameRoundedDurations(timeline, fps) : timeline
  const effective = effectiveTransitionSeconds(
    durations,
    clips.map((c) => c.transitionIn)
  )[index]
  return { specified: spec.duration, effective }
}

/**
 * 繋ぎの最中の「これから出てくる側」の不透明度(0〜1)。
 *
 * `xfade=transition=fade` は時間に対して線形に混ぜるので、そのまま線形で返す。
 * 窓の外は 0 / 1 に丸める(`progress` が範囲外でも中間の値を返さない)。
 */
export function crossfadeOpacity(elapsed: number, duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 1
  if (!Number.isFinite(elapsed)) return 1
  if (elapsed <= 0) return 0
  if (elapsed >= duration) return 1
  return elapsed / duration
}

import { toPlaybackRate } from './playbackRate'

/**
 * 読み込み直しを挟むプレビューで、**あとから入れる再生位置**。
 *
 * `<video>` の `src` を差し替えると、ブラウザは**別のタスクで**メディア読み込みアルゴリズムを
 * 走らせる。その中で `emptied` が飛んで再生位置は 0 に戻るので、差し替えた直後に
 * `currentTime` を書いても**まだ前の素材に対する代入**で、直後の `emptied` に流される。
 * `requestAnimationFrame` を1回挟んでも順序は保証されない(実測: シークでは常に流された)。
 *
 * 確実なのは「新しい素材の寸法が分かった」= `loadedmetadata` の時点なので、
 * 入れたい値をここに控えておいて、その通知で入れる。
 */
export interface PendingPreviewLoad {
  /** 読み込ませた src。**別の読み込みの通知に反応しないための照合用** */
  url: string
  /** 素材の中の位置(秒) */
  time: number
  /** クリップの速度(等倍は 1)。定義域は `toPlaybackRate` が受け止める */
  speed: number
  /** 読み込み後にそのまま再生を続けるか */
  play: boolean
}

/** 再生要素のうち、ここで触る分だけ。試験で差し替えられるように最小にしてある */
export interface PreviewMediaElement {
  getAttribute(name: string): string | null
  currentTime: number
  playbackRate: number
  play(): Promise<void>
}

/**
 * 再生要素へ入れてよい位置(秒)に直す。
 *
 * `HTMLMediaElement.currentTime` は `unrestricted double` ではないので、
 * **NaN と ±Infinity は代入した時点で `TypeError` を投げる**。入れるのは
 * `loadedmetadata` のハンドラ(React のイベント)なので、投げると**エラー画面**になる。
 * 位置は `inPoint` 由来＝保存ファイル由来なので、ここで受け止める
 * (`toPlaybackRate` が速度に対してやっているのと同じ理由)。
 */
export function toMediaTime(seconds: number): number {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0
}

/**
 * 控えておいた位置を、いま読み込み終わった要素へ入れる。
 *
 * `url` が食い違うときは**何もしない**。素材の再リンクやプレビュー用プロキシの
 * 入れ替えでは、控えたのとは別の src の `loadedmetadata` が来ることがあり、
 * そこへ前の素材の位置を入れると今度は逆向きにズレる。
 *
 * @returns 入れたら true。呼び出し側はこれを見て控えを捨てる
 */
export function applyPendingPreviewLoad(
  el: PreviewMediaElement | null,
  pending: PendingPreviewLoad | null
): boolean {
  if (!el || !pending) return false
  if (el.getAttribute('src') !== pending.url) return false
  el.currentTime = toMediaTime(pending.time)
  el.playbackRate = toPlaybackRate(pending.speed)
  // 位置を入れてから再生する(逆にすると、シークが効くまでの数フレームが頭から流れる)
  if (pending.play) void el.play().catch(() => {})
  return true
}

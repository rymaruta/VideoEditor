import type { Clip, MediaAsset } from './types'

// 出力フレームレートの上限・下限。上限60は YouTube(Shorts含む)が受け付ける上限で、
// 120fps や 240fps の素材をそのまま流すとファイルが無駄に大きくなるため。
// 下限24は、ffprobe が妙に低い値を返したときに紙芝居のような出力にしないための保険。
const MAX_EXPORT_FPS = 60
const MIN_EXPORT_FPS = 24
const FALLBACK_EXPORT_FPS = 30

/**
 * 書き出しのフレームレートを本編クリップの素材から決める。
 *
 * フィルタグラフは `concat` / `xfade` で全クリップを1本に畳むので、**全体で1つの
 * フレームレートに揃える必要がある**。以前はここが `fps=30` の固定値で、60fps の
 * ゲーム実況素材を読み込んでも**書き出しは常に30fps**になっていた(実測: 60fps・600
 * フレームの素材が 30fps・330フレームになる)。尺は合っているのでエラーも出ず、
 * インスペクタには素材の「60fps」がそのまま出ているため、画面からは気付けなかった。
 *
 * 複数の素材が混ざっているときは**一番高いものに合わせる**。低いほうに合わせると
 * 高フレームレートの素材からフレームを捨てることになり、元に戻せないため。
 * 逆に低い素材を高いほうへ合わせるのはフレームの複製で済み、失われるものは無い。
 *
 * PiP は小さくはめ込むだけなので判断に入れない。PiPだけが60fpsのときに本編全体を
 * 60fps へ引き上げると、得られるものに対してファイルサイズの増加が見合わない。
 *
 * **画面側の「1フレーム移動」もこの関数を使うこと。** 別々に持つと、書き出しだけ直して
 * 画面が30fps決め打ちのまま取り残される(実際にそうなっていた)。
 */
export function targetFrameRate(sourceFpsList: number[]): number {
  const valid = sourceFpsList.filter((f) => Number.isFinite(f) && f > 0 && f <= 240)
  if (valid.length === 0) return FALLBACK_EXPORT_FPS
  // 29.97 / 59.94 のような値は整数に丸める。`settb` に小数を渡すと妙な時間基準になる。
  const rounded = Math.round(Math.max(...valid))
  return Math.min(MAX_EXPORT_FPS, Math.max(MIN_EXPORT_FPS, rounded))
}

/** 本編クリップが使っている素材から、そのプロジェクトの出力フレームレートを求める */
export function projectFrameRate(clips: Clip[], assets: MediaAsset[]): number {
  const fpsById = new Map(assets.map((a) => [a.id, a.fps]))
  return targetFrameRate(
    clips.map((c) => fpsById.get(c.assetId)).filter((f): f is number => f !== undefined)
  )
}

/** 1フレームぶんの秒数。タイムライン上の移動量はこれが基準になる */
export function frameSeconds(clips: Clip[], assets: MediaAsset[]): number {
  return 1 / projectFrameRate(clips, assets)
}

/**
 * 尺(秒)を**フレーム数**に直す。書き出しで1本ぶんの映像を切り出す長さに使う。
 *
 * 秒で切ると、**同じ尺でもフィルタの組み方によってフレーム数が変わる**。
 * `trim=duration=D` は「表示時刻が D 未満のフレームを残す」判定なので、
 * `overlay`(ぼかし背景)を通って時間基準が細かくなると、ちょうど D にあるはずの
 * 1枚が丸めで D をわずかに下回り、**滑り込んで1フレーム多くなる**。
 * (実測: 20秒・30fps の書き出しで、黒帯は 600フレーム・20.000000秒なのに
 *  ぼかし背景だけ **601フレーム・20.033984秒** と音声からずれていた。
 *  4.16秒では 125 に対し 126、4.20秒では 126 に対し 127)
 *
 * フレーム数で切れば判定に時刻が入らないので、どの組み方でも同じ数になる。
 * 丸めは**四捨五入**。黒帯の経路が今出している数(実測 9通りとも `round(尺×fps)` と
 * 一致)がこれなので、**今までの経路の出力を変えずに**ぼかしだけ揃えられる。
 * 切り上げにすると全経路が1フレームずつ伸び、切り捨てにすると全経路が縮む。
 *
 * 数値でない尺・0以下は 0(フレーム無し)。`trim=end_frame=NaN` は ffmpeg が
 * 受け付けず、**書き出しごと失敗する**。
 */
export function frameCountForDuration(durationSeconds: number, fps: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0
  if (!Number.isFinite(fps) || fps <= 0) return 0
  return Math.max(0, Math.round(durationSeconds * fps))
}

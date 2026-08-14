/**
 * モノラルの素材をステレオへ広げるときの規則。
 *
 * プレビューの Chromium は Web Audio の規定どおり、モノラルを**等倍のまま左右へ複製**する。
 * 一方 ffmpeg(swresample)は左右へ **`1/√2`(-3.01 dB)** で配る。同じ素材なのに
 * **書き出しだけ 3dB 小さくなる**。
 *
 * 効くのは全体の大きさだけではない。モノラルのナレーションとステレオのBGMを画面で
 * 耳で釣り合わせたプロジェクトは、書き出すと**ナレーションだけが 3dB 引っ込む**。
 * ラウドネス正規化をONにしても直らない(混ぜ終わった全体を揃えるだけで、中の比は動かない)。
 *
 * 実測(同じ 200Hz・同じ振幅を mono/stereo の2ファイルにして同じ企画で書き出し):
 *   書き出し max_volume   mono -27.1 dB / stereo -24.0 dB(**3.0 dB の差**)
 *   プレビュー実効値      `<audio>` 要素・OfflineAudioContext とも左チャンネル
 *                         0.04427 / 0.04427(**差 0.0 dB**)
 *
 * `rematrix_volume` は変換行列全体に掛かるので、**ステレオの素材に通すと +3dB になる**
 * (実測 -24.1 → -21.1 dB)。だから 1ch と分かっている素材にだけ通すこと。
 */
export const MONO_UPMIX_GAIN = Math.SQRT2

/**
 * 1ch の素材を等倍でステレオへ広げる `aresample`。**チャンネル数が 1 と分かっている
 * 素材にだけ**前置きする(2ch 以上に通すと全体が 3dB 持ち上がる)。
 */
export function monoUpmixFilter(sampleRate?: number): string {
  const rate = typeof sampleRate === 'number' && sampleRate > 0 ? `${sampleRate}:` : ''
  return `aresample=${rate}osf=fltp:ochl=stereo:rematrix_volume=${MONO_UPMIX_GAIN}`
}

/** ffprobe の `channels` が 1ch を指しているか。整数以外・0以下・欠落はすべて「不明」＝false。 */
export function isMonoChannelCount(channels: unknown): boolean {
  return channels === 1
}

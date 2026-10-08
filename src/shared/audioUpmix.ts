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
  return `aresample=${ratePart(sampleRate)}osf=fltp:ochl=stereo:rematrix_volume=${MONO_UPMIX_GAIN}`
}

/**
 * `aresample` の先頭に置くサンプルレート。**ここを1箇所にしておく**——
 * 広げる側と畳む側で書き写すと、片方だけ `Infinity` や `NaN` をそのまま
 * ffmpeg へ渡す形に戻る(数値でない値は「指定なし」として落とす)。
 */
function ratePart(sampleRate?: number): string {
  return typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0
    ? `${sampleRate}:`
    : ''
}

/** ffprobe の `channels` が 1ch を指しているか。整数以外・0以下・欠落はすべて「不明」＝false。 */
export function isMonoChannelCount(channels: unknown): boolean {
  return channels === 1
}

/**
 * 3ch 以上の素材をステレオへ畳むときの規則。
 *
 * swresample は畳み込みの行列が 1 を超えるとき、**出力が整数形式なら行列を
 * 正規化して割れないようにする**(`rematrix_maxval` の既定が 1.0)。ところが
 * **浮動小数(`fltp`)では既定が無制限**になり、正規化が外れる。
 * このアプリは形式の交渉を止めるために出力を `fltp` で固定しているので、
 * **その副作用で 3ch 以上の素材だけが持ち上がる**。狙って上げたわけではない。
 *
 * 実測(同じ 4000Hz を 2ch と 5.1ch の2ファイルにして、書き出しと同じ
 * `aformat=sample_fmts=fltp:...:channel_layouts=stereo` を通す):
 *   2ch                       mean -18.1 dB / peak -15.0 dB
 *   5.1ch(いまの経路)         mean  -7.4 dB / peak  -4.4 dB  ← **+10.7 dB**
 *   5.1ch(整数形式に落とす)   mean -15.1 dB / peak -12.1 dB  ← 本来の畳み込み
 * つまり `fltp` の固定だけで **7.7 dB** ぶん余計に持ち上がっていた。
 * 素材が大きければそのまま 0 dBFS を越えて割れる。
 *
 * `rematrix_maxval=1.0` を明示して、整数形式のときと同じ正規化に戻す。
 * **2ch の素材に通しても畳み込み自体が起きない**ので値は変わらない(実測 -18.1 dB のまま)が、
 * モノラルの `rematrix_volume` と混ざらないよう、3ch 以上と分かっている素材にだけ通す。
 */
export function multiChannelDownmixFilter(sampleRate?: number, channels?: number): string {
  // 4ch・6ch(5.1)は、プレビュー(Chromium の Web Audio の決まり)と同じ畳み方にする。
  // 正規化した畳み方だと、同じ素材が書き出しだけ 7.7 dB(5.1)小さかった。和が 0dBFS を越える所だけ
  // 頭を抑える(割れさせない。越えない所の音は変えない)
  const spec = SPEAKER_DOWNMIX[channels ?? 0]
  if (spec)
    return (
      `pan=stereo|c0=${spec[0]}|c1=${spec[1]},` +
      `aresample=${ratePart(sampleRate)}osf=fltp,` +
      `alimiter=limit=1:level=disabled:attack=1:release=50`
    )
  return `aresample=${ratePart(sampleRate)}osf=fltp:ochl=stereo:rematrix_maxval=1.0`
}

/**
 * Web Audio の決まり(speakers の畳み方)。4ch は L・R・SL・SR、6ch は L・R・C・LFE・SL・SR
 * (LFE は使わない)。ほかの数は Chromium が先頭の2本だけを鳴らす(声が消える)ので、まねない
 */
const SPEAKER_DOWNMIX: Record<number, [string, string]> = {
  4: ['0.5*c0+0.5*c2', '0.5*c1+0.5*c3'],
  6: ['c0+0.7071*c2+0.7071*c4', 'c1+0.7071*c2+0.7071*c5']
}

/** ffprobe の `channels` が 3ch 以上を指しているか。整数以外・欠落はすべて「不明」＝false。 */
export function isMultiChannelCount(channels: unknown): boolean {
  return typeof channels === 'number' && Number.isInteger(channels) && channels > 2
}

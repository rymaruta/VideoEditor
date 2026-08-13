/**
 * 音声トラッククリップの音量倍率の規則。
 *
 * 書き出し(ffmpeg の `volume=`)とプレビュー(再生要素 / Web Audio)で別々に書くと、
 * 画面で聞いた音と出来上がりが黙って食い違う。規則はここ1箇所だけに置き、両方が呼ぶ。
 */

/** 使えない数(NaN・Infinity・負)は「指定なし = 等倍」として扱う。黙って無音にしない。 */
function sanitizeFactor(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 1
  return value
}

/** トラックの音量つまみ x クリップの音量。0〜3倍(UIのつまみの範囲)を素通しで返す。 */
export function audioClipGain(trackVolume: number, clipVolume: number | undefined): number {
  return sanitizeFactor(trackVolume) * sanitizeFactor(clipVolume)
}

/**
 * 再生要素(`HTMLMediaElement.volume`)が受け付ける上限。
 *
 * **仕様上 0〜1 しか入らない**(1より大きい値は `IndexSizeError`)。つまり
 * `el.volume` だけでプレビューを鳴らしていると、**1倍を超える音量つまみが画面では
 * 一切効かない**。書き出しの `volume=` には上限が無いので、そこで食い違う。
 * 実測(BGMトラックのつまみを動かして、本編は無音素材):
 *   つまみ 50% → 画面 0.50 / 書き出し -31.9dB
 *   つまみ100% → 画面 1.00 / 書き出し -25.9dB
 *   つまみ150% → 画面 **1.00**(据え置き) / 書き出し -22.3dB
 *   つまみ200% → 画面 **1.00**(据え置き) / 書き出し -19.9dB
 *   つまみ300% → 画面 **1.00**(据え置き) / 書き出し -16.3dB
 * 1倍を超えるぶんは Web Audio の `GainNode` でしか出せない。
 */
export const MEDIA_ELEMENT_MAX_VOLUME = 1

/** その倍率を出すのに Web Audio が要るか(再生要素の volume では届かないか)。 */
export function needsWebAudioGain(gain: number): boolean {
  return Number.isFinite(gain) && gain > MEDIA_ELEMENT_MAX_VOLUME
}

/**
 * 再生要素の `volume` に入れてよい値に丸める(0〜1)。
 *
 * **NaN だけは 0 に倒す**(比較がすべて false になるので `Math.min`/`Math.max` を
 * 通り抜けて `volume = NaN` になり、代入時に例外が飛ぶ)。`Infinity` は順序があるので
 * そのまま上限へ丸める——「丸める」と名乗る関数が、上限を超えた値だけ 0(無音)に
 * するのは筋が通らない。
 */
export function toElementVolume(gain: number): number {
  if (Number.isNaN(gain)) return 0
  return Math.min(MEDIA_ELEMENT_MAX_VOLUME, Math.max(0, gain))
}

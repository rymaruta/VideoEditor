/**
 * 再生中、本編の <video> の位置からタイムラインの再生位置を出す。
 *
 * 別のファイルを読み込み直している間(`loading`)は、要素の位置がまだ前のファイルのもの、または
 * 読み込み前の 0 なので null(再生位置を動かさない・クリップの終わりも判定しない)。
 * 使うと、再生位置が負の時刻(実測 -1790 秒)へ飛び、その間は別のクリップの切り抜き・色合わせが
 * 当たり、BGM・SE が鳴り直し、タイムラインが頭へ飛んで戻っていた
 */
export function playheadFromElement(
  clip: { start: number; inPoint: number; speed?: number },
  currentTime: number,
  loading: boolean
): number | null {
  if (loading || !Number.isFinite(currentTime)) return null
  return clip.start + (currentTime - clip.inPoint) / (clip.speed || 1)
}

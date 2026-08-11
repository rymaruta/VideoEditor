/**
 * テロップの一括スタイル変更で、サイズ欄に打ち込まれた文字列を
 * 適用してよい数値に変換する。適用しない場合は null。
 *
 * ここで範囲クランプをしてはいけない。入力欄の表示値は「選択中の共通値」なので、
 * 打つそばからクランプすると **1文字目でストアの値が跳ね、その値の続きに2文字目が
 * 足されて別の数字になる**(「30」と打つと 3→16→160→96)。範囲は入力欄の
 * `min`/`max` と、1件用の入力欄と同じ扱いに合わせる。
 */
export function parseBulkFontSize(raw: string): number | null {
  // `Number('  ')` は 0 になる。空白だけを「サイズ0」として適用しない
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

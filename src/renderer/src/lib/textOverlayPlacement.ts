/**
 * 「テロップを1枚足す」ときに置く区間を決める。
 *
 * 追加の入口は**2つ**ある(「テキスト」タブの追加ボタンと、「プリセット」タブの
 * テロッププリセット)。この2つが別々の規則を持っていたため、同じアプリの中で
 * **押す場所によって入る位置が変わっていた**——テキストタブは `startTime: 0` 固定で、
 * 再生位置を7秒にして押しても 0〜3秒に入り、続けて押すと**同じ 0〜3秒に2枚重なる**
 * (同じ文言なので一覧でも見分けられない)。プリセットタブは再生位置を使うが、
 * 今度は**尺を超えても置ける**ので、末尾で押すと書き出しに出ないテロップができる。
 * 規則をここ1つにまとめて、どちらの入口からも同じ結果になるようにする。
 *
 * 重なりは**避けない**。テロップは重ねて使うもの(2行を別スタイルで重ねるなど)で、
 * 効果音のように「同じ位置に2つあると二重に鳴る」たぐいの害が無い。
 * 同じ再生位置で2回押したなら、それは利用者が2枚欲しかったということ。
 */

/** 追加したテロップの既定の長さ(秒) */
export const DEFAULT_OVERLAY_DURATION = 3

/**
 * テロップの最短の長さ(秒)。
 *
 * 開始と終了が同じだと、画面にも書き出しにも**一瞬も出ない**テロップができて、
 * 一覧に行だけが増える。数値欄の手入力もこの下限で止める。
 */
export const MIN_OVERLAY_DURATION = 0.1

/**
 * 再生位置に置くときの開始・終了。
 *
 * - 開始は**再生位置**。ただし末尾ぴったりで押しても潰れないよう、
 *   最短の長さが残る位置まで戻す。
 * - 終了は開始 + 既定の長さ。**タイムラインの終わりを超えない**
 *   (超えたぶんは書き出しに出ないので、画面の一覧にだけ残ることになる)。
 * - まだクリップが1本も無い(尺 0)ときは、尺で切らずに既定の長さをそのまま使う。
 *   ここで 0 秒にしてしまうと、素材を置く前にテロップを用意する使い方ができない。
 */
export function newOverlayRange(
  playheadTime: number,
  totalDuration: number
): { startTime: number; endTime: number } {
  const playhead = Number.isFinite(playheadTime) ? Math.max(0, playheadTime) : 0
  const total = Number.isFinite(totalDuration) && totalDuration > 0 ? totalDuration : 0
  if (total <= 0) {
    return { startTime: playhead, endTime: playhead + DEFAULT_OVERLAY_DURATION }
  }
  const startTime = Math.min(playhead, Math.max(0, total - MIN_OVERLAY_DURATION))
  const endTime = Math.max(
    startTime + MIN_OVERLAY_DURATION,
    Math.min(startTime + DEFAULT_OVERLAY_DURATION, total)
  )
  return { startTime, endTime }
}

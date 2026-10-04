/**
 * プレビューの「控えの再生要素」(計画書 §4.5)。
 *
 * プレビューの本編は `<video>` で流す。1つの要素で次のクリップへ移ると、**別の素材なら
 * 読み込み直し、同じ素材でも飛び先へのシーク**が切れ目ごとに挟まり、そのあいだ画が止まる
 * (実測: 2台のカメラを 2〜4.5秒ごとに切り替えた本編で、30秒の再生が 28.2秒しか進まず、
 *  画を出せないコマが 41)。マルチカムの仮編集は数秒ごとにカメラが替わるので、ずっと引っかかる。
 *
 * そこで要素を2つ持ち、**次のクリップを控えの要素に先に読み込んで頭の位置で待たせておき**、
 * 切れ目で役割を入れ替える。そのまま続くクリップ(同じ素材の続き)は今の要素で流し続ける。
 */

/** 控えに用意する中身 */
export interface StandbyTarget {
  url: string
  /** 素材の中の位置(秒)。次のクリップの頭 */
  time: number
  clipId: string
}

/** 切れ目の何秒前から控えを用意するか。読み込み・シークに掛かる時間より十分長く */
export const STANDBY_LEAD_SEC = 2

/** 同じ素材の続きとみなす、位置のずれ(秒) */
const CONTINUOUS_EPS = 0.05

interface ClipLike {
  url: string
  inPoint: number
  outPoint: number
  speed: number
  clipId: string
  /** タイムラインの終わり(秒) */
  end: number
}

/**
 * 今のクリップの次に、控えを用意すべきか。用意するなら中身を返す。
 * - 次が無い・まだ遠い(`STANDBY_LEAD_SEC` より先)なら null
 * - 次が**同じ素材の続き**(位置も速さもつながる)なら、今の要素で流し続けられるので null
 */
export function standbyTargetFor(
  current: ClipLike,
  next: ClipLike | null,
  timelineTime: number,
  lead = STANDBY_LEAD_SEC
): StandbyTarget | null {
  if (!next) return null
  if (current.end - timelineTime > lead) return null
  const continuous =
    next.url === current.url &&
    Math.abs(next.inPoint - current.outPoint) <= CONTINUOUS_EPS &&
    (next.speed || 1) === (current.speed || 1)
  if (continuous) return null
  return { url: next.url, time: next.inPoint, clipId: next.clipId }
}

/** 控えの要素のうち、ここで見る分だけ(試験で差し替えられるように最小) */
export interface StandbyElement {
  getAttribute(name: string): string | null
  readyState: number
  currentTime: number
  seeking: boolean
}

/** 位置のずれの許容(秒)。1コマ強 */
const SWAP_TOLERANCE_SEC = 0.1

/**
 * 控えの要素へそのまま切り替えてよいか。用意した素材・位置と一致し、画が出せる状態であること。
 * 一致しなければ従来どおり(今の要素で読み込み直し・シーク)。
 */
export function canSwapToStandby(
  el: StandbyElement | null,
  prepared: StandbyTarget | null,
  url: string,
  time: number
): boolean {
  if (!el || !prepared) return false
  if (prepared.url !== url || el.getAttribute('src') !== url) return false
  // HAVE_CURRENT_DATA(2)以上: 今の位置の画がある
  if (el.readyState < 2 || el.seeking) return false
  return Math.abs(el.currentTime - time) <= SWAP_TOLERANCE_SEC
}

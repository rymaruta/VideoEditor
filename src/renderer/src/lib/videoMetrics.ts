/**
 * 動画1本を「数として」測るための共通の物差し。
 *
 * ゲームリサーチ(`gameResearch.ts`)とチャンネル分析(`channelAnalytics.ts`)は
 * 見るものが違うが、**測り方が違ってはいけない**。同じ動画を片方が「5時間前・
 * 1万回/時」、もう片方が「4時間前・1.2万回/時」と言い出すと、画面をまたいだ
 * 瞬間にどちらの数字も信用できなくなる。物差しはここ1本に置く。
 */

const HOUR_MS = 3_600_000

/**
 * ショートとみなす尺の上限(秒)。
 * YouTube Data API の `videoDuration=short` は「4分未満」という粗い区分なので、
 * 検索結果はこちらの秒数で**取り直して**数える。
 */
export const SHORTS_MAX_SECONDS = 180

/**
 * 速度(再生数/時)の分母の下限。
 *
 * 公開10分で1000回の動画は素直に割ると 6000回/時になり、**投稿直後というだけで**
 * 順位を独占する。分母に下限を置いて、直後の動画が跳ね上がらないようにする。
 */
export const MIN_VELOCITY_HOURS = 6

/** 測る対象。YouTube から取れる値のうち、数として使うものだけ */
export interface SourceVideo {
  id: string
  title: string
  channelTitle: string
  viewCount: number
  publishedAt: string
  durationSeconds: number
}

/** 測り終えた1本 */
export interface MeasuredVideo extends SourceVideo {
  hoursAgo: number | null
  viewsPerHour: number | null
  isShort: boolean
}

/**
 * 中央値。**平均ではない**のは、1本だけ跳ねた動画に全体の評価を
 * 引きずられないため(急上昇もチャンネルも、上位1本と残りで桁が違うことがふつうにある)。
 * 有限でない値は数える前に捨てる。空なら 0。
 */
export function median(values: readonly number[]): number {
  const sorted = (Array.isArray(values) ? values : [])
    .filter((n): n is number => Number.isFinite(n))
    .sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 公開からの経過時間(時)。読めない `publishedAt` は `null`(0時間ではない——
 * 0を返すと「たった今出た動画」として満点になってしまう)。
 *
 * 端末の時計が進んでいると経過時間が負になる。負のまま速度を割ると
 * **一番伸びている動画が最下位に来る**ので 0 に丸める。
 */
export function hoursSincePublished(publishedAt: string, now: number): number | null {
  if (typeof publishedAt !== 'string' || publishedAt.trim() === '') return null
  if (!Number.isFinite(now)) return null
  const published = Date.parse(publishedAt)
  if (!Number.isFinite(published)) return null
  const hours = (now - published) / HOUR_MS
  if (!Number.isFinite(hours)) return null
  return Math.max(0, hours)
}

/**
 * 1時間あたりの再生数。公開日時が読めないときだけ `null`。
 * (再生数が非公開・欠測のときは 0 として扱う——「速度不明」ではなく「伸びていない」)
 */
export function viewsPerHour(viewCount: number, publishedAt: string, now: number): number | null {
  const hours = hoursSincePublished(publishedAt, now)
  if (hours === null) return null
  const views = Number.isFinite(viewCount) && viewCount > 0 ? viewCount : 0
  return views / Math.max(hours, MIN_VELOCITY_HOURS)
}

/** 外から来た1本を、欠けた欄も含めて安全に測る */
export function measureVideo(video: SourceVideo, now: number): MeasuredVideo {
  const duration = Number.isFinite(video?.durationSeconds) ? video.durationSeconds : 0
  return {
    id: typeof video?.id === 'string' ? video.id : '',
    title: typeof video?.title === 'string' ? video.title : '',
    channelTitle: typeof video?.channelTitle === 'string' ? video.channelTitle : '',
    viewCount: Number.isFinite(video?.viewCount) && video.viewCount > 0 ? video.viewCount : 0,
    publishedAt: typeof video?.publishedAt === 'string' ? video.publishedAt : '',
    durationSeconds: duration,
    hoursAgo: hoursSincePublished(video?.publishedAt, now),
    viewsPerHour: viewsPerHour(video?.viewCount, video?.publishedAt, now),
    isShort: duration > 0 && duration <= SHORTS_MAX_SECONDS
  }
}

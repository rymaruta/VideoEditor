/**
 * 画面と依頼文で**同じ数字が同じ形で出る**ようにするための整形。
 *
 * 分けて書くと必ずずれる。実際、同じ再生数が画面では「12000回」、AIへの依頼文では
 * 「1.2万回」と書かれていて、AIがその表記のまま答えると、利用者には画面のどこにも
 * 無い数字が返ってきたように見える。整形はここ1本に置く。
 */

/** 再生数。万を超えたら「万回」に落として読めるようにする */
export function formatViews(views: number): string {
  if (!Number.isFinite(views)) return '不明'
  if (views >= 10000) return `${(views / 10000).toFixed(1)}万回`
  return `${Math.round(views).toLocaleString('ja-JP')}回`
}

/** 素の数(登録者数・本数など) */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '不明'
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return Math.round(n).toLocaleString('ja-JP')
}

/** 再生速度 */
export function formatPerHour(value: number): string {
  if (!Number.isFinite(value)) return '不明'
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万回/時`
  return `${Math.round(value).toLocaleString('ja-JP')}回/時`
}

/** 公開からの経過 */
export function formatHoursAgo(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '不明'
  if (hours < 1) return '1時間以内'
  if (hours < 24) return `${Math.round(hours)}時間前`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days}日前`
  return `${Math.round(days / 30)}か月前`
}

/** 平常比などの倍率 */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  return `${ratio.toFixed(2)}倍`
}

/** 尺 */
export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '不明'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const

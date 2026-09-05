import { measureVideo, median, type MeasuredVideo, type SourceVideo } from './videoMetrics'

/**
 * チャンネルの投稿動画を数える側。**AIを通らない。**
 *
 * YouTube Studio の Ask Studio と正面から比べたとき、こちらが取れないものと
 * 取れるものははっきりしている。
 *
 * - **取れない**: クリック率・視聴維持率・インプレッション・視聴者層。
 *   これらは所有者本人しか読めない(OAuth と YouTube Analytics API が要る)。
 *   持っていない数字を推測で埋めるのが一番やってはいけないことなので、
 *   ここでは**公開データだけ**を扱い、無いものは無いと画面に書く。
 * - **取れる**: 公開されている全動画の再生数・尺・公開日時。つまり
 *   「何を出したときに、平常よりどれだけ回ったか」は再現できる。しかも
 *   **自分以外のチャンネルにも同じ計算をかけられる**——これは Ask Studio には
 *   できない(自分のチャンネルしか見ない)。
 *
 * したがってここの仕事は、公開データから**平常運転の基準**を作り、各動画が
 * それに対してどうだったかを出すこと。基準の作り方を間違えると全部が狂うので、
 * 成熟(公開から一定日数)・形式(ショート/長尺)・標本数の3つを必ず区切る。
 */

/** 「平常運転の基準」に入れてよい、公開からの日数。これ未満はまだ伸びている途中 */
export const MATURITY_DAYS = 14

/** 中央値を出すのに最低限ほしい本数。これを割ったら「測れない」と言う */
export const MIN_SAMPLE = 4

/** 曜日・時間帯の集計に使う時差。日本は夏時間が無いので固定値で正確に出せる */
export const JST_OFFSET_HOURS = 9

/** 伸びの比較に使う窓(日)。成熟済みの動画だけを、同じ長さの2つの窓で比べる */
export const TREND_WINDOW_DAYS = 90

/** 形式ごとの平常運転 */
export interface FormatStats {
  count: number
  /** 基準に使えた(公開から MATURITY_DAYS 以上経った)本数 */
  matureCount: number
  /** 平常運転の再生数。標本が足りなければ null(0 ではない——0倍と混ざる) */
  baselineViews: number | null
  medianViews: number
  medianViewsPerHour: number
  medianDurationSeconds: number
}

/** 平常比を付けた1本 */
export interface RatedVideo {
  video: MeasuredVideo
  /** 同じ形式の平常運転に対する倍率。基準が無い/未成熟なら null */
  performanceRatio: number | null
  mature: boolean
}

export interface MonthlyPoint {
  /** `YYYY-MM`(日本時間) */
  month: string
  count: number
  medianViews: number
}

export interface WeekdayStat {
  /** 0=日曜(日本時間) */
  weekday: number
  count: number
  medianRatio: number | null
}

export interface TitlePatternStat {
  key: string
  label: string
  withCount: number
  withoutCount: number
  medianRatioWith: number
  medianRatioWithout: number
}

export interface TrendComparison {
  recentMedianViews: number
  previousMedianViews: number
  recentCount: number
  previousCount: number
  /** 直近 ÷ その前。どちらかの標本が足りなければ null */
  changeRatio: number | null
}

export interface ChannelAnalytics {
  analyzedCount: number
  /** 一番古い動画から一番新しい動画までの日数 */
  windowDays: number | null
  newestHoursAgo: number | null
  /** 直近90日の投稿頻度。期間が短すぎれば null */
  uploadsPerWeek: number | null
  shorts: FormatStats
  long: FormatStats
  /** 新しい順のすべて */
  rated: RatedVideo[]
  /** 平常比の高い順(成熟したものだけ) */
  hits: RatedVideo[]
  /** 平常比の低い順(成熟したものだけ) */
  misses: RatedVideo[]
  /** まだ成熟していない直近の動画。速度の速い順 */
  recent: RatedVideo[]
  monthly: MonthlyPoint[]
  weekdays: WeekdayStat[]
  titlePatterns: TitlePatternStat[]
  trend: TrendComparison
}

function jstParts(publishedAt: string): { month: string; weekday: number } | null {
  const t = Date.parse(publishedAt)
  if (!Number.isFinite(t)) return null
  // 時差を足した「見かけのUTC」で読むと、UTCの getter がそのまま日本時間になる
  const shifted = new Date(t + JST_OFFSET_HOURS * 3_600_000)
  const month = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
  return { month, weekday: shifted.getUTCDay() }
}

function statsFor(videos: readonly MeasuredVideo[]): FormatStats {
  const mature = videos.filter(isMature)
  const matureViews = mature.map((v) => v.viewCount)
  return {
    count: videos.length,
    matureCount: mature.length,
    // 標本が足りないまま基準を作ると、1本の外れ値がそのまま「平常」になる
    baselineViews: mature.length >= MIN_SAMPLE ? median(matureViews) : null,
    medianViews: median(videos.map((v) => v.viewCount)),
    medianViewsPerHour: median(
      videos.map((v) => v.viewsPerHour).filter((v): v is number => v !== null)
    ),
    medianDurationSeconds: median(videos.map((v) => v.durationSeconds))
  }
}

/** 平常運転の基準に入れてよい1本か。公開日時が読めないものは入れない */
function isMature(video: MeasuredVideo): boolean {
  return video.hoursAgo !== null && video.hoursAgo / 24 >= MATURITY_DAYS
}

/** タイトルの型。**探しに行くのは「見分けがつく形」だけ**——曖昧な分類は数を濁す */
const TITLE_PATTERNS: { key: string; label: string; test: (title: string) => boolean }[] = [
  { key: 'number', label: '数字が入っている', test: (t) => /[0-9０-９]/.test(t) },
  { key: 'bracket', label: '【】で括りがある', test: (t) => /[【】]/.test(t) },
  { key: 'question', label: '問いかけで終わる', test: (t) => /[?？]\s*$/.test(t) },
  { key: 'exclaim', label: '！を使っている', test: (t) => /[!！]/.test(t) },
  { key: 'quote', label: '「」でセリフを引いている', test: (t) => /[「」]/.test(t) },
  { key: 'long', label: 'タイトルが長い(25文字以上)', test: (t) => [...t].length >= 25 }
]

function ratiosOf(rated: readonly RatedVideo[]): number[] {
  return rated.map((r) => r.performanceRatio).filter((r): r is number => r !== null)
}

/**
 * まとめて測る。
 *
 * `now` を引数に取るのは、テストのためだけではない。分析は数十秒かかることが
 * あり、途中で `Date.now()` を読み直すと**同じ動画の経過時間が段によって変わる**。
 */
export function analyzeChannelVideos(
  videos: readonly SourceVideo[],
  now: number
): ChannelAnalytics {
  const measured = (Array.isArray(videos) ? videos : [])
    .filter((v): v is SourceVideo => typeof v === 'object' && v !== null)
    .map((v) => measureVideo(v, now))
    .filter((v) => v.id !== '')
    .sort(
      (a, b) => (a.hoursAgo ?? Number.MAX_SAFE_INTEGER) - (b.hoursAgo ?? Number.MAX_SAFE_INTEGER)
    )

  const shortsList = measured.filter((v) => v.isShort)
  const longList = measured.filter((v) => !v.isShort)
  const shorts = statsFor(shortsList)
  const long = statsFor(longList)

  const rated: RatedVideo[] = measured.map((video) => {
    const baseline = video.isShort ? shorts.baselineViews : long.baselineViews
    const mature = isMature(video)
    const ratio = mature && baseline !== null && baseline > 0 ? video.viewCount / baseline : null
    return { video, performanceRatio: ratio, mature }
  })

  const matureRated = rated.filter((r) => r.performanceRatio !== null)
  const byRatio = [...matureRated].sort(
    (a, b) => (b.performanceRatio as number) - (a.performanceRatio as number)
  )

  const hitCount = Math.min(5, Math.floor(matureRated.length / 2))
  const ages = measured.map((v) => v.hoursAgo).filter((h): h is number => h !== null)
  const windowDays = ages.length >= 2 ? (Math.max(...ages) - Math.min(...ages)) / 24 : null
  const newestHoursAgo = ages.length > 0 ? Math.min(...ages) : null

  // 投稿頻度は直近90日で測る。開設直後や、久しぶりに再開したチャンネルで
  // 「全期間の平均」を出すと、いまの実態とかけ離れた数字になる
  const recentDays = windowDays === null ? null : Math.min(TREND_WINDOW_DAYS, windowDays)
  const recentUploads = measured.filter(
    (v) => v.hoursAgo !== null && v.hoursAgo / 24 <= TREND_WINDOW_DAYS
  ).length
  const uploadsPerWeek =
    recentDays !== null && recentDays >= 7 ? (recentUploads / recentDays) * 7 : null

  const monthlyMap = new Map<string, number[]>()
  const weekdayMap = new Map<number, number[]>()
  for (const r of rated) {
    const parts = jstParts(r.video.publishedAt)
    if (!parts) continue
    const monthBucket = monthlyMap.get(parts.month) ?? []
    monthBucket.push(r.video.viewCount)
    monthlyMap.set(parts.month, monthBucket)
    if (r.performanceRatio !== null) {
      const weekdayBucket = weekdayMap.get(parts.weekday) ?? []
      weekdayBucket.push(r.performanceRatio)
      weekdayMap.set(parts.weekday, weekdayBucket)
    }
  }
  const monthly: MonthlyPoint[] = [...monthlyMap.entries()]
    .map(([month, views]) => ({ month, count: views.length, medianViews: median(views) }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
  const weekdays: WeekdayStat[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const bucket = weekdayMap.get(weekday) ?? []
    return {
      weekday,
      count: bucket.length,
      // 標本が足りない曜日に中央値を出すと、1本の当たりが「金曜が強い」に化ける
      medianRatio: bucket.length >= 3 ? median(bucket) : null
    }
  })

  const titlePatterns: TitlePatternStat[] = []
  for (const pattern of TITLE_PATTERNS) {
    const withIt = matureRated.filter((r) => pattern.test(r.video.title))
    const withoutIt = matureRated.filter((r) => !pattern.test(r.video.title))
    if (withIt.length < MIN_SAMPLE || withoutIt.length < MIN_SAMPLE) continue
    titlePatterns.push({
      key: pattern.key,
      label: pattern.label,
      withCount: withIt.length,
      withoutCount: withoutIt.length,
      medianRatioWith: median(ratiosOf(withIt)),
      medianRatioWithout: median(ratiosOf(withoutIt))
    })
  }
  // 差の大きい型から出す。並びを固定するため、同じ差なら key の順
  titlePatterns.sort((a, b) => {
    const da = Math.abs(a.medianRatioWith - a.medianRatioWithout)
    const db = Math.abs(b.medianRatioWith - b.medianRatioWithout)
    if (db !== da) return db - da
    return a.key < b.key ? -1 : 1
  })

  // 伸びの比較は**成熟済みどうし**を同じ長さの窓で。未成熟を混ぜると
  // 「最近のほうが再生数が少ない」という、伸びていないだけの結論が出る
  const inWindow = (r: RatedVideo, fromDays: number, toDays: number): boolean => {
    const days = r.video.hoursAgo === null ? null : r.video.hoursAgo / 24
    return days !== null && days >= fromDays && days < toDays
  }
  const recentWindow = matureRated.filter((r) =>
    inWindow(r, MATURITY_DAYS, MATURITY_DAYS + TREND_WINDOW_DAYS)
  )
  const previousWindow = matureRated.filter((r) =>
    inWindow(r, MATURITY_DAYS + TREND_WINDOW_DAYS, MATURITY_DAYS + TREND_WINDOW_DAYS * 2)
  )
  const recentMedianViews = median(recentWindow.map((r) => r.video.viewCount))
  const previousMedianViews = median(previousWindow.map((r) => r.video.viewCount))
  const trend: TrendComparison = {
    recentMedianViews,
    previousMedianViews,
    recentCount: recentWindow.length,
    previousCount: previousWindow.length,
    changeRatio:
      recentWindow.length >= MIN_SAMPLE &&
      previousWindow.length >= MIN_SAMPLE &&
      previousMedianViews > 0
        ? recentMedianViews / previousMedianViews
        : null
  }

  return {
    analyzedCount: measured.length,
    windowDays,
    newestHoursAgo,
    uploadsPerWeek,
    shorts,
    long,
    rated,
    // 上位と下位に**同じ動画を出さない**。成熟が5本しかないのに「上位5本」と
    // 「下位5本」を出すと、全部が両方に載って、読む側には壊れて見える
    hits: byRatio.slice(0, hitCount),
    misses: hitCount > 0 ? byRatio.slice(-hitCount).reverse() : [],
    recent: rated
      .filter((r) => !r.mature)
      .sort((a, b) => (b.video.viewsPerHour ?? -1) - (a.video.viewsPerHour ?? -1))
      .slice(0, 5),
    monthly,
    weekdays,
    titlePatterns,
    trend
  }
}

/**
 * 登録者1人あたりの再生数。
 *
 * チャンネルの規模が違っても比べられる数字で、**競合と並べたときに初めて効く**
 * (自分の 0.12 が高いのか低いのかは、単体では分からない)。
 * 登録者数を非公開にしているチャンネルでは出せないので `null` を返す。
 */
export function viewsPerSubscriber(
  analytics: ChannelAnalytics,
  subscriberCount: number,
  hidden: boolean
): number | null {
  if (hidden || !Number.isFinite(subscriberCount) || subscriberCount <= 0) return null
  // 基準にする形式は**本数の多い方**。ショート中心のチャンネルで、たまたま出した
  // 長尺3本の基準を使うと、そのチャンネルの実態とかけ離れた数字になる
  const primary =
    analytics.shorts.matureCount > analytics.long.matureCount ? analytics.shorts : analytics.long
  const baseline =
    primary.baselineViews ?? analytics.long.baselineViews ?? analytics.shorts.baselineViews
  if (baseline === null || baseline <= 0) return null
  return baseline / subscriberCount
}

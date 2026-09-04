/**
 * ゲームリサーチの**数える側**。
 *
 * これまでの「ゲームトレンド分析」は、急上昇のタイトルをまとめてAIに渡し、
 * **どのゲームが何件出たか・どれが一番勢いがあるか**まで含めて全部AIに答えさせていた。
 * この作りは、次の3つの理由で当たり外れが大きい。
 *
 * 1. **数を数える仕事をAIにさせている。** 件数・チャンネル数・再生数の比較は
 *    生成AIが最も落としやすい種類の作業で、しかも間違えても文章としては自然に読める
 *    (「3件で最多」と書いてあっても、実際は2件目の別ゲームの方が多い、が起きる)。
 * 2. **公開日時を渡していなかった。** `publishedAt` は取得済みなのに依頼文に載せておらず、
 *    AIは**再生数の絶対値**しか見られない。3日前に100万回の動画と、6時間前に30万回の動画では
 *    後者の方が「今」伸びているが、前者が選ばれる。
 * 3. **裏取りが無い。** 急上昇はほぼ長尺で、そこに出たゲームがショートでも回るとは限らない。
 *
 * ここに置くのは**AIを通らない計算だけ**。順位・スコア・根拠の数字はすべてこの
 * モジュールが決め、AIには「決まった順位に文章を付ける」仕事だけを残す
 * (`gameTrendAnalysis.ts`)。数字が合っているかはテストで固定できる。
 */

/** 順位付けに使う、1本の動画の値だけ(`YouTubeVideoInfo` の部分集合) */
export interface ResearchVideo {
  id: string
  title: string
  channelTitle: string
  viewCount: number
  publishedAt: string
  durationSeconds: number
}

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

/** 新しさが満点になる経過時間(時)と、0点になる経過時間(時) */
export const FRESHNESS_FULL_HOURS = 6
export const FRESHNESS_ZERO_HOURS = 168

/** 100点の内訳。合計が100になること自体をテストで固定する */
export const SCORE_WEIGHTS = {
  /** 勢い: 動画の再生速度(再生数/時)の中央値 */
  momentum: 40,
  /** 新しさ: 一番新しい動画の経過時間 */
  freshness: 25,
  /** 広がり: 何チャンネルが・何本出しているか */
  spread: 20,
  /** ショート適性: そのゲームでショートが実際に回っているか */
  shortsFit: 15
} as const

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** 表示にも合計にも使うので、小数第1位で揃えてから足す(内訳の和 ≠ 合計、を防ぐ) */
function round1(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 10) / 10
}

/**
 * 中央値。**平均ではない**のは、1本だけ跳ねた動画にゲーム全体の評価を
 * 引きずられないため(急上昇は上位1本と残りで桁が違うことがふつうにある)。
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

/**
 * ゲーム名をまとめるための鍵。
 *
 * AIは同じゲームを「Apex Legends」「APEX」「【APEX】」と書き分ける。生の文字列で
 * 数えると1つのゲームが3つに割れ、**どれも件数が足りず候補から落ちる**。
 * 全角/半角・大小・空白・囲み記号だけを均し、**表記の違いを超えた同一視はしない**
 * (「エーペックス」と「apex」を同じにするには辞書が要る。当てずっぽうで
 *  別ゲームを混ぜるより、分かれたまま出す方が安全)。
 */
export function normalizeGameKey(name: string): string {
  if (typeof name !== 'string') return ''
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[【】[\]()（）《》「」『』]/g, ' ')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!?！？。、.,・:;]+$/u, '')
}

/** AIに出させる、1本のタイトルに対する判定 */
export interface GameAttribution {
  /** 依頼文で提示した 1 始まりの番号 */
  index: number
  gameName: string
  /** `high` だけを数に入れる。曖昧なものを混ぜると順位そのものが濁る */
  confidence: 'high' | 'low'
}

/** 根拠として画面に出す1本 */
export interface EvidenceVideo {
  id: string
  title: string
  channelTitle: string
  viewCount: number
  publishedAt: string
  durationSeconds: number
  hoursAgo: number | null
  viewsPerHour: number | null
  isShort: boolean
}

/** 1ゲーム分の実測値。ここに文章は入らない */
export interface GameStats {
  key: string
  displayName: string
  videoCount: number
  channelCount: number
  totalViews: number
  medianViewsPerHour: number
  topViewsPerHour: number
  newestHoursAgo: number | null
  shortsCount: number
  shortsRatio: number
  videos: EvidenceVideo[]
}

function toEvidence(video: ResearchVideo, now: number): EvidenceVideo {
  const duration = Number.isFinite(video.durationSeconds) ? video.durationSeconds : 0
  return {
    id: typeof video.id === 'string' ? video.id : '',
    title: typeof video.title === 'string' ? video.title : '',
    channelTitle: typeof video.channelTitle === 'string' ? video.channelTitle : '',
    viewCount: Number.isFinite(video.viewCount) && video.viewCount > 0 ? video.viewCount : 0,
    publishedAt: typeof video.publishedAt === 'string' ? video.publishedAt : '',
    durationSeconds: duration,
    hoursAgo: hoursSincePublished(video.publishedAt, now),
    viewsPerHour: viewsPerHour(video.viewCount, video.publishedAt, now),
    isShort: duration > 0 && duration <= SHORTS_MAX_SECONDS
  }
}

/**
 * AIの判定を、**こちらが渡した動画リストに突き合わせて**集計する。
 *
 * 番号で受け取るのが要点。以前はAIに根拠タイトルを**文字列で書かせて**いたので、
 * 言い換えや要約が混ざっても気付けなかった(画面に出る「根拠」が実在しない文字列に
 * なりうる)。番号なら、根拠として出るのは常にこちらが渡した原文そのものになり、
 * 範囲外の番号は捨てられる。
 */
export function aggregateGames(
  videos: readonly ResearchVideo[],
  attributions: readonly GameAttribution[],
  now: number
): GameStats[] {
  const list = (Array.isArray(videos) ? videos : []).filter(
    (v): v is ResearchVideo => typeof v === 'object' && v !== null
  )
  const groups = new Map<
    string,
    { names: Map<string, number>; firstName: string; videos: Map<string, EvidenceVideo> }
  >()

  for (const a of Array.isArray(attributions) ? attributions : []) {
    if (typeof a !== 'object' || a === null) continue
    if (a.confidence !== 'high') continue
    if (!Number.isInteger(a.index) || a.index < 1 || a.index > list.length) continue
    const rawName = typeof a.gameName === 'string' ? a.gameName.trim() : ''
    if (rawName === '') continue
    const key = normalizeGameKey(rawName)
    if (key === '') continue
    const video = list[a.index - 1]
    const evidence = toEvidence(video, now)
    if (evidence.id === '') continue

    let group = groups.get(key)
    if (!group) {
      group = { names: new Map(), firstName: rawName, videos: new Map() }
      groups.set(key, group)
    }
    group.names.set(rawName, (group.names.get(rawName) ?? 0) + 1)
    // 同じ動画に同じゲームが二重に付くことがある。件数は動画の数で数える
    group.videos.set(evidence.id, evidence)
  }

  const stats: GameStats[] = []
  for (const [key, group] of groups) {
    const videosOfGame = [...group.videos.values()].sort(
      (a, b) => (b.viewsPerHour ?? -1) - (a.viewsPerHour ?? -1)
    )
    const velocities = videosOfGame
      .map((v) => v.viewsPerHour)
      .filter((v): v is number => v !== null)
    const ages = videosOfGame.map((v) => v.hoursAgo).filter((h): h is number => h !== null)
    const shortsCount = videosOfGame.filter((v) => v.isShort).length
    // 表記は「一番多く使われた綴り」を採る。同数なら最初に出たもの(順序は
    // Map の挿入順なので、同じ入力からは必ず同じ表記が出る)
    let displayName = group.firstName
    let best = 0
    for (const [name, count] of group.names) {
      if (count > best) {
        best = count
        displayName = name
      }
    }
    stats.push({
      key,
      displayName,
      videoCount: videosOfGame.length,
      channelCount: new Set(videosOfGame.map((v) => v.channelTitle).filter((c) => c !== '')).size,
      totalViews: videosOfGame.reduce((sum, v) => sum + v.viewCount, 0),
      medianViewsPerHour: median(velocities),
      topViewsPerHour: velocities.length > 0 ? Math.max(...velocities) : 0,
      newestHoursAgo: ages.length > 0 ? Math.min(...ages) : null,
      shortsCount,
      shortsRatio: videosOfGame.length > 0 ? shortsCount / videosOfGame.length : 0,
      videos: videosOfGame
    })
  }
  return stats
}

/** 候補のゲームを YouTube 検索で数え直した結果 */
export interface ShortsVerification {
  key: string
  query: string
  windowDays: number
  shortsFound: number
  medianViewsPerHour: number
  topVideo: { id: string; title: string; viewCount: number } | null
}

/** 検索結果から裏取りの数字を作る。ショート以外の尺はここで落とす */
export function summarizeShorts(
  key: string,
  query: string,
  windowDays: number,
  results: readonly ResearchVideo[],
  now: number
): ShortsVerification {
  const shorts = (Array.isArray(results) ? results : [])
    .filter((v): v is ResearchVideo => typeof v === 'object' && v !== null)
    .map((v) => toEvidence(v, now))
    .filter((v) => v.isShort)
  const velocities = shorts.map((v) => v.viewsPerHour).filter((v): v is number => v !== null)
  const top = shorts.reduce<EvidenceVideo | null>(
    (best, v) => (best === null || v.viewCount > best.viewCount ? v : best),
    null
  )
  return {
    key,
    query,
    windowDays,
    shortsFound: shorts.length,
    medianViewsPerHour: median(velocities),
    topVideo: top ? { id: top.id, title: top.title, viewCount: top.viewCount } : null
  }
}

/** 100点の内訳。画面にはこの4つをそのまま出す(なぜ1位なのかが読めるように) */
export interface ScoreBreakdown {
  momentum: number
  freshness: number
  spread: number
  shortsFit: number
  total: number
  /** 裏取り(YouTube検索)の結果を使ったか。使っていない点は弱い根拠だと分かるように出す */
  verified: boolean
}

/**
 * 勢い。速度は桁で効いてくる(1000回/時と1万回/時の差は、1万と1万1千の差とは違う)ので
 * 常用対数で測る。10回/時で0点、10万回/時で満点。
 */
function momentumScore(medianVelocity: number): number {
  const v = Number.isFinite(medianVelocity) && medianVelocity > 0 ? medianVelocity : 0
  return SCORE_WEIGHTS.momentum * clamp01((Math.log10(1 + v) - 1) / 4)
}

/** 新しさ。6時間以内で満点、7日で0点。公開日時が読めなければ0点(推測しない) */
function freshnessScore(newestHoursAgo: number | null): number {
  if (newestHoursAgo === null || !Number.isFinite(newestHoursAgo)) return 0
  const span = FRESHNESS_ZERO_HOURS - FRESHNESS_FULL_HOURS
  return SCORE_WEIGHTS.freshness * clamp01((FRESHNESS_ZERO_HOURS - newestHoursAgo) / span)
}

/**
 * 広がり。**チャンネル数を本数より重く見る**のが要点。
 * 1つの大手チャンネルが5本出しただけの状態は「そのゲームが流行っている」ではなく
 * 「そのチャンネルが強い」で、真似しても同じようには回らない。
 */
function spreadScore(channelCount: number, videoCount: number): number {
  const channels = Number.isFinite(channelCount) ? channelCount : 0
  const videos = Number.isFinite(videoCount) ? videoCount : 0
  const channelPart = clamp01((channels - 1) / 4)
  const volumePart = clamp01((videos - 1) / 5)
  return SCORE_WEIGHTS.spread * (0.7 * channelPart + 0.3 * volumePart)
}

/**
 * ショート適性。
 *
 * 裏取りができた場合は**実際に直近で回っているショートの本数と速度**で測る。
 * 0本なら 0点——急上昇の長尺に出ていても、ショートが1本も無いゲームを
 * 「今日ショートを撮るなら」の1位にしてはいけない。
 *
 * 裏取りをしない場合は、急上昇リスト内のショート比率で代用する。ただし急上昇は
 * 長尺が大半でショートが混ざりにくいため、**上限を6割に抑えた弱い根拠**として扱う。
 */
function shortsFitScore(stats: GameStats, verification: ShortsVerification | null): number {
  if (verification) {
    if (verification.shortsFound <= 0) return 0
    const countPart = clamp01(verification.shortsFound / 8)
    const speedPart = clamp01(
      (Math.log10(1 + Math.max(0, verification.medianViewsPerHour)) - 1) / 3
    )
    return SCORE_WEIGHTS.shortsFit * (0.5 * countPart + 0.5 * speedPart)
  }
  return SCORE_WEIGHTS.shortsFit * clamp01(stats.shortsRatio) * 0.6
}

export function scoreGame(
  stats: GameStats,
  verification: ShortsVerification | null
): ScoreBreakdown {
  const momentum = round1(momentumScore(stats.medianViewsPerHour))
  const freshness = round1(freshnessScore(stats.newestHoursAgo))
  const spread = round1(spreadScore(stats.channelCount, stats.videoCount))
  const shortsFit = round1(shortsFitScore(stats, verification))
  // 合計は**表示する内訳の和**。丸める前の値で足すと、画面の4つを足しても
  // 合計にならない数字が出る(利用者からは計算間違いに見える)
  const total = Math.round(momentum + freshness + spread + shortsFit)
  return {
    momentum,
    freshness,
    spread,
    shortsFit,
    total: Math.min(100, Math.max(0, total)),
    verified: verification !== null
  }
}

export interface RankedGame {
  stats: GameStats
  verification: ShortsVerification | null
  score: ScoreBreakdown
}

/**
 * 並べる。**同点の並びまで決めておく**のが要点で、同じデータから毎回同じ順位が出る。
 * (順位が回ごとに入れ替わると、前回との比較も、利用者の信用も成り立たない)
 */
export function rankGames(
  stats: readonly GameStats[],
  verifications: ReadonlyMap<string, ShortsVerification> = new Map()
): RankedGame[] {
  return (Array.isArray(stats) ? stats : [])
    .map((s) => {
      const verification = verifications.get(s.key) ?? null
      return { stats: s, verification, score: scoreGame(s, verification) }
    })
    .sort((a, b) => {
      if (b.score.total !== a.score.total) return b.score.total - a.score.total
      if (b.stats.medianViewsPerHour !== a.stats.medianViewsPerHour) {
        return b.stats.medianViewsPerHour - a.stats.medianViewsPerHour
      }
      if (b.stats.videoCount !== a.stats.videoCount) return b.stats.videoCount - a.stats.videoCount
      return a.stats.key < b.stats.key ? -1 : a.stats.key > b.stats.key ? 1 : 0
    })
}

/** 集計に使えた動画の本数(タイトルからゲーム名が読めなかった本数を出すために使う) */
export function attributedVideoCount(stats: readonly GameStats[]): number {
  const ids = new Set<string>()
  for (const s of Array.isArray(stats) ? stats : []) {
    for (const v of s.videos) ids.add(v.id)
  }
  return ids.size
}

import { parseModelJsonObject } from './httpJson'
import { generateContent, generateFromParts, type GeminiTurn, type WebSource } from './gemini'
import { fetchChannelVideos, resolveChannel, type YouTubeChannelInfo } from './youtube'
import { parseChannelInput, type ChannelRef } from './channelUrl'
import {
  analyzeChannelVideos,
  viewsPerSubscriber,
  type ChannelAnalytics,
  type RatedVideo
} from './channelAnalytics'
import {
  WEEKDAY_LABELS,
  formatCount,
  formatDurationSeconds,
  formatHoursAgo,
  formatRatio,
  formatViews
} from './formatUnits'

/**
 * チャンネル分析の入口。
 *
 * 狙いは YouTube Studio の Ask Studio の上を行くこと。向こうが強いのは
 * **所有者本人しか見られない数字**(クリック率・視聴維持率)で、そこは API の
 * 都合で越えられない。越えられるのは次の3つで、この実装はそこに全部を寄せている。
 *
 * 1. **他人のチャンネルにも同じ計算をかけられる。** 競合を並べて初めて、
 *    「登録者あたりの再生が 0.12」が良いのか悪いのかが決まる。
 * 2. **外の世界を見に行ける。** 発売日・大型アップデート・大会・季節行事は
 *    チャンネルの中のデータには存在しないが、次に何を撮るかはそれで決まる。
 *    Google 検索のグラウンディングで取り、**出典を必ず画面に出す**。
 * 3. **数字を作らない。** 平常比も投稿頻度も曜日別もすべてコードが計算し、
 *    AIには「その数字をどう読むか」だけを書かせる。
 */

/** 1チャンネル分の実測 */
export interface ChannelReport {
  channel: YouTubeChannelInfo
  analytics: ChannelAnalytics
  viewsPerSubscriber: number | null
}

export interface NewsItem {
  headline: string
  /** モデルが書いた日付表現(確認できなければ「日付不明」) */
  dateHint: string
  whyItMatters: string
  sources: WebSource[]
}

export interface VideoIdea {
  title: string
  format: 'shorts' | 'long'
  outline: string
  whyNow: string
  /** 根拠にした自チャンネルの動画(番号で受け取り、こちらで引き当てたもの) */
  evidence: RatedVideo[]
  news: NewsItem[]
}

export interface ChannelInsight {
  summary: string
  strengths: string[]
  weaknesses: string[]
  news: NewsItem[]
  ideas: VideoIdea[]
  /** 外部調査の生の答え。数字の出どころを疑いたくなったとき用に丸ごと残す */
  researchText: string
  sources: WebSource[]
  searchQueries: string[]
}

export interface ChannelAnalysisResult {
  primary: ChannelReport
  competitors: ChannelReport[]
  insight: ChannelInsight
  /** 経過時間の基準。画面の表示もこの時刻で揃える */
  now: number
}

export type ChannelPhase = 'resolve' | 'videos' | 'research' | 'compose'

export interface ChannelProgress {
  phase: ChannelPhase
  done?: number
  total?: number
  label?: string
}

export interface ChannelAnalysisOptions {
  /** 比較したいチャンネル(URL・ハンドル・チャンネル名)。空なら単体で分析 */
  competitorInputs?: string[]
  /** 外部ニュースを Google 検索で調べる */
  research?: boolean
  userInstruction?: string
  /** 1チャンネルあたり何本まで遡るか */
  maxVideos?: number
  now?: number
  onProgress?: (progress: ChannelProgress) => void
}

/** 分析に使う動画の既定本数。再生リスト2回+実数2回=**4ユニット**しか使わない */
export const DEFAULT_MAX_VIDEOS = 100
/** 比較に並べられるチャンネルの上限(画面が読めなくなる前に切る) */
export const MAX_COMPETITORS = 3

function parseInputs(inputs: readonly string[]): ChannelRef[] {
  const refs: ChannelRef[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const ref = parseChannelInput(input)
    if (!ref) continue
    const key = `${ref.kind}:${ref.value.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

async function buildReport(
  apiKey: string,
  channel: YouTubeChannelInfo,
  maxVideos: number,
  now: number
): Promise<ChannelReport> {
  const videos = await fetchChannelVideos(apiKey, channel, maxVideos)
  const analytics = analyzeChannelVideos(videos, now)
  return {
    channel,
    analytics,
    viewsPerSubscriber: viewsPerSubscriber(
      analytics,
      channel.subscriberCount,
      channel.subscriberCountHidden
    )
  }
}

// ── 依頼文に載せる「実測」の書き起こし ────────────────────────────────────

function describeFormat(label: string, stats: ChannelAnalytics['shorts']): string {
  if (stats.count === 0) return `${label}: 投稿なし`
  const baseline =
    stats.baselineViews === null
      ? `平常運転の基準は作れず(公開から14日以上経った動画が${stats.matureCount}本しかない)`
      : `平常運転 ${formatViews(stats.baselineViews)}`
  return `${label}: ${stats.count}本 / ${baseline} / 中央値の尺 ${formatDurationSeconds(stats.medianDurationSeconds)}`
}

function describeRated(list: readonly RatedVideo[], startIndex: number): string {
  return list
    .map((r, i) => {
      const ratio =
        r.performanceRatio === null ? '平常比 —' : `平常比 ${formatRatio(r.performanceRatio)}`
      return `${startIndex + i}. 「${r.video.title}」 / ${formatViews(r.video.viewCount)} / ${ratio} / ${formatHoursAgo(r.video.hoursAgo)} / ${r.video.isShort ? 'ショート' : '長尺'}`
    })
    .join('\n')
}

/** 依頼文に渡す番号付きの動画一覧。**番号でしか根拠を受け取らない**ための土台 */
export function numberedVideos(report: ChannelReport): RatedVideo[] {
  return report.analytics.rated
}

export function describeChannelReport(report: ChannelReport, includeList: boolean): string {
  const { channel, analytics } = report
  const lines: string[] = []
  lines.push(
    `チャンネル: ${channel.title}${channel.handle ? ` (${channel.handle})` : ''} / 登録者 ${
      channel.subscriberCountHidden ? '非公開' : formatCount(channel.subscriberCount)
    } / 総再生 ${formatCount(channel.viewCount)} / 公開動画 ${formatCount(channel.videoCount)}本`
  )
  lines.push(
    `分析対象: 直近${analytics.analyzedCount}本(${
      analytics.windowDays === null ? '期間不明' : `${Math.round(analytics.windowDays)}日ぶん`
    }) / 最新の投稿 ${formatHoursAgo(analytics.newestHoursAgo)} / 投稿頻度 ${
      analytics.uploadsPerWeek === null
        ? '測定不能(期間が短い)'
        : `週${analytics.uploadsPerWeek.toFixed(1)}本`
    }`
  )
  lines.push(describeFormat('ショート', analytics.shorts))
  lines.push(describeFormat('長尺', analytics.long))
  if (report.viewsPerSubscriber !== null) {
    lines.push(`登録者1人あたりの再生: ${report.viewsPerSubscriber.toFixed(3)}`)
  }
  if (analytics.trend.changeRatio !== null) {
    lines.push(
      `伸びの推移: 直近90日の中央値 ${formatViews(analytics.trend.recentMedianViews)}(${analytics.trend.recentCount}本) / その前の90日 ${formatViews(analytics.trend.previousMedianViews)}(${analytics.trend.previousCount}本) → ${analytics.trend.changeRatio.toFixed(2)}倍`
    )
  } else {
    lines.push('伸びの推移: 比較に足りる本数が無いため測定していない')
  }
  const weekdays = analytics.weekdays.filter((w) => w.medianRatio !== null)
  if (weekdays.length > 0) {
    lines.push(
      `曜日別の平常比(日本時間・3本以上ある曜日のみ): ${weekdays
        .map((w) => `${WEEKDAY_LABELS[w.weekday]}曜 ${formatRatio(w.medianRatio)}(${w.count}本)`)
        .join(' / ')}`
    )
  }
  if (analytics.titlePatterns.length > 0) {
    lines.push(
      `タイトルの型と平常比: ${analytics.titlePatterns
        .map(
          (p) =>
            `${p.label} → あり ${formatRatio(p.medianRatioWith)}(${p.withCount}本) / なし ${formatRatio(p.medianRatioWithout)}(${p.withoutCount}本)`
        )
        .join(' / ')}`
    )
  }
  if (includeList) {
    if (analytics.hits.length > 0) {
      lines.push(`\n【平常より回った動画】\n${describeRated(analytics.hits, 1)}`)
    }
    if (analytics.misses.length > 0) {
      lines.push(`\n【平常より回らなかった動画】\n${describeRated(analytics.misses, 1)}`)
    }
    if (analytics.recent.length > 0) {
      lines.push(
        `\n【まだ成熟していない直近の動画(平常比は出せない)】\n${describeRated(analytics.recent, 1)}`
      )
    }
  }
  return lines.join('\n')
}

function numberedVideoList(report: ChannelReport, limit = 40): string {
  return report.analytics.rated
    .slice(0, limit)
    .map(
      (r, i) =>
        `${i + 1}. 「${r.video.title}」 / ${formatViews(r.video.viewCount)} / ${
          r.performanceRatio === null ? '平常比なし' : formatRatio(r.performanceRatio)
        } / ${r.video.isShort ? 'ショート' : '長尺'} / ${formatHoursAgo(r.video.hoursAgo)}`
    )
    .join('\n')
}

// ── 外部調査(Google 検索のグラウンディング) ──────────────────────────────

function buildResearchPrompt(report: ChannelReport): string {
  const recentTitles = report.analytics.rated
    .slice(0, 20)
    .map((r) => `・${r.video.title}`)
    .join('\n')
  const hitTitles = report.analytics.hits.map((r) => `・${r.video.title}`).join('\n')
  const description = report.channel.description.slice(0, 300)
  return `あなたはYouTubeチャンネルの企画リサーチャーです。次のチャンネルが扱っている題材について、**いま外の世界で起きていること**をGoogle検索で調べてください。チャンネルの中の数字ではなく、外の出来事を集めるのがあなたの仕事です。

# 対象チャンネル
名前: ${report.channel.title}
説明: ${description || '(説明なし)'}
${report.channel.keywords ? `キーワード: ${report.channel.keywords}\n` : ''}直近の動画タイトル:
${recentTitles || '(なし)'}
${hitTitles ? `\n特に回った動画:\n${hitTitles}` : ''}

# 調べること
1. 直近1か月以内に起きた、この題材に関わるニュース・新作/新シーズン/大型アップデート・イベント・大会・話題。
2. いま検索や話題が伸びているもの(新しく流行り始めたもの)。
3. これから2〜4週間のあいだに予定されている出来事(発売日・アップデート日・大会日程・季節行事)。

# 書き方の約束
- 1件ずつ「何が/いつ/出典」を書く。**日付は必ず添える**。検索で確認できなければ「日付不明」と書く。
- 確認できなかった項目は「該当なし」と書く。埋めるために推測を書かない。
- 最大10件。1件は3行以内。
- 各件の最後に「このチャンネルとの接点:」を1行で添える。接点が薄いものは載せない。
- 日本語で書く。`
}

// ── 執筆(検索なし・JSONのみ) ────────────────────────────────────────────

function buildComposePrompt(
  primary: ChannelReport,
  competitors: ChannelReport[],
  research: { text: string; sources: WebSource[] } | null,
  userInstruction: string
): string {
  const competitorSection =
    competitors.length > 0
      ? `\n\n# 比較チャンネル(同じ計算をかけた実測)\n${competitors
          .map((c, i) => `[${i + 1}] ${describeChannelReport(c, false)}`)
          .join('\n\n')}`
      : ''
  const sourceSection =
    research && research.sources.length > 0
      ? `\n\n# 出典一覧(番号で引用する)\n${research.sources
          .map((s, i) => `[${i + 1}] ${s.title} (${s.domain})`)
          .join('\n')}`
      : ''
  const researchSection = research
    ? `\n\n# 外部調査の結果(Google検索で取得。ここに書かれていること以外を外部情報として書かないこと)\n${research.text}${sourceSection}`
    : '\n\n# 外部調査\n今回は外部調査を実行していません。newsは空配列にし、ideasのwhyNowでは外部の出来事に触れないでください。'
  const instructionSection = userInstruction.trim()
    ? `\n\n# 利用者からの補足指示\n"""\n${userInstruction.trim()}\n"""\n観点や語り口をこれに寄せてください。ただし出力形式と、数値を作らない原則は必ず守ること。`
    : ''

  return `あなたはYouTubeチャンネルの分析担当です。以下の「実測」はプログラムがYouTube公式APIのデータから計算した確定値です。**数値を作り変えたり、ここに無い数値を書いたりしないでください。**

# 実測(確定値)
${describeChannelReport(primary, true)}

# 分析対象の動画一覧(番号で引用する)
${numberedVideoList(primary)}${competitorSection}${researchSection}${instructionSection}

# 用語
- 平常比: その動画の再生数 ÷ 同じ形式(ショート/長尺)の平常運転の再生数。1.00倍が平常。公開から14日未満の動画には出していない(まだ伸びている途中のため)。
- 平常運転: 公開から14日以上経った動画の再生数の中央値。

# 依頼内容
1. summary: このチャンネルのいまの状態を、実測の数値を引用しながら3〜4文でまとめる。
2. strengths / weaknesses: 実測から読み取れる強みと弱みを各2〜4個。**必ず数値を根拠として添える**(例:「ショートの平常比が長尺の1.8倍」)。取れていない指標(クリック率・視聴維持率など)については触れないこと。
3. news: 外部調査の結果を、この チャンネルにとって重要な順に最大5件へ整理する。headlineは事実、dateHintは調査結果に書かれていた日付表現をそのまま、whyItMattersはこのチャンネルとの接点を1〜2文。sourceIndexesには出典一覧の番号を入れる(調査結果に出典が無い項目は空配列)。
4. ideas: 次に作るべき動画の案を4件。各案は次を満たすこと。
   - title: そのまま使える日本語のタイトル案。
   - format: "shorts" か "long"。実測でどちらが回っているかを踏まえて選ぶ。
   - outline: 何をどう撮るか、2〜3文。
   - whyNow: なぜ今なのか。**自チャンネルの実測(番号で示した動画や平常比)と、外部調査の出来事の両方**に触れる。片方しか根拠が無い場合はその旨を書く。
   - evidenceVideoIndexes: 根拠にした「分析対象の動画一覧」の番号(0〜3個)。
   - newsIndexes: 根拠にしたnewsの番号(1始まり、0〜2個)。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "summary": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "news": [{ "headline": "string", "dateHint": "string", "whyItMatters": "string", "sourceIndexes": [1] }],
  "ideas": [{ "title": "string", "format": "shorts", "outline": "string", "whyNow": "string", "evidenceVideoIndexes": [1], "newsIndexes": [1] }]
}`
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 番号の配列を、範囲内の整数だけに絞る(AIが作った番号を混ぜないため) */
function validIndexes(value: unknown, length: number, max: number): number[] {
  const raw = Array.isArray(value) ? value : []
  const result: number[] = []
  for (const item of raw) {
    const n = typeof item === 'number' ? item : Number(item)
    if (!Number.isFinite(n)) continue
    const i = Math.round(n)
    if (i < 1 || i > length) continue
    if (!result.includes(i)) result.push(i)
    if (result.length >= max) break
  }
  return result
}

function parseNews(parsed: Record<string, unknown>, sources: WebSource[]): NewsItem[] {
  const raw = Array.isArray(parsed.news) ? parsed.news : []
  const news: NewsItem[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const headline = asString(item.headline).trim()
    if (headline === '') continue
    news.push({
      headline,
      dateHint: asString(item.dateHint).trim() || '日付不明',
      whyItMatters: asString(item.whyItMatters),
      sources: validIndexes(item.sourceIndexes, sources.length, 4).map((i) => sources[i - 1])
    })
    if (news.length >= 5) break
  }
  return news
}

function parseIdeas(
  parsed: Record<string, unknown>,
  videos: RatedVideo[],
  news: NewsItem[]
): VideoIdea[] {
  const raw = Array.isArray(parsed.ideas) ? parsed.ideas : []
  const ideas: VideoIdea[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const title = asString(item.title).trim()
    if (title === '') continue
    ideas.push({
      title,
      format: item.format === 'long' ? 'long' : 'shorts',
      outline: asString(item.outline),
      whyNow: asString(item.whyNow),
      evidence: validIndexes(item.evidenceVideoIndexes, videos.length, 3).map((i) => videos[i - 1]),
      news: validIndexes(item.newsIndexes, news.length, 2).map((i) => news[i - 1])
    })
    if (ideas.length >= 6) break
  }
  return ideas
}

export async function analyzeChannel(
  youtubeApiKey: string,
  geminiApiKey: string,
  primaryInput: string,
  options: ChannelAnalysisOptions = {}
): Promise<ChannelAnalysisResult> {
  const {
    competitorInputs = [],
    research = true,
    userInstruction = '',
    maxVideos = DEFAULT_MAX_VIDEOS,
    onProgress
  } = options
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now()

  const primaryRef = parseChannelInput(primaryInput)
  if (!primaryRef) {
    throw new Error('チャンネルのURL・ハンドル(@から始まる名前)・チャンネル名を入力してください')
  }
  const competitorRefs = parseInputs(competitorInputs).slice(0, MAX_COMPETITORS)

  onProgress?.({ phase: 'resolve' })
  const primaryChannel = await resolveChannel(youtubeApiKey, primaryRef)
  const competitorChannels: YouTubeChannelInfo[] = []
  for (const ref of competitorRefs) {
    try {
      const channel = await resolveChannel(youtubeApiKey, ref)
      // 同じチャンネルを2回並べても比較にならない
      if (
        channel.id !== primaryChannel.id &&
        !competitorChannels.some((c) => c.id === channel.id)
      ) {
        competitorChannels.push(channel)
      }
    } catch {
      // 比較対象が1つ見つからなくても、本命の分析は続ける
    }
  }

  const total = 1 + competitorChannels.length
  onProgress?.({ phase: 'videos', done: 0, total, label: primaryChannel.title })
  const primary = await buildReport(youtubeApiKey, primaryChannel, maxVideos, now)
  if (primary.analytics.analyzedCount === 0) {
    // 公開動画が無いチャンネルを、空の集計のまま分析にかけると
    // 「数字が無いこと」を AI が言葉で埋めてしまう。ここで止める
    throw new Error(
      `「${primaryChannel.title}」から公開されている動画を取得できませんでした(非公開・限定公開のみ、または動画がまだありません)。`
    )
  }
  const competitors: ChannelReport[] = []
  for (const channel of competitorChannels) {
    onProgress?.({ phase: 'videos', done: competitors.length + 1, total, label: channel.title })
    competitors.push(await buildReport(youtubeApiKey, channel, maxVideos, now))
  }

  let researchResult: { text: string; sources: WebSource[]; queries: string[] } | null = null
  if (research) {
    onProgress?.({ phase: 'research' })
    try {
      const answer = await generateFromParts(
        geminiApiKey,
        [{ text: buildResearchPrompt(primary) }],
        { search: true }
      )
      researchResult = { text: answer.text, sources: answer.sources, queries: answer.queries }
    } catch {
      // 検索が使えない環境・上限でも、実測の分析は成立する。外部だけ落とす
      researchResult = null
    }
  }

  onProgress?.({ phase: 'compose' })
  const composed = parseModelJsonObject(
    (
      await generateFromParts(
        geminiApiKey,
        [{ text: buildComposePrompt(primary, competitors, researchResult, userInstruction) }],
        { json: true }
      )
    ).text,
    'Gemini API'
  )
  const sources = researchResult?.sources ?? []
  const news = parseNews(composed, sources)
  const insight: ChannelInsight = {
    summary: asString(composed.summary),
    strengths: asStringArray(composed.strengths),
    weaknesses: asStringArray(composed.weaknesses),
    news,
    ideas: parseIdeas(composed, numberedVideos(primary).slice(0, 40), news),
    researchText: researchResult?.text ?? '',
    sources,
    searchQueries: researchResult?.queries ?? []
  }

  return { primary, competitors, insight, now }
}

// ── 追加の質問(Ask Studio に相当する部分) ────────────────────────────────

export interface ChannelChatTurn {
  role: 'user' | 'model'
  text: string
}

export interface ChannelChatAnswer {
  text: string
  sources: WebSource[]
  queries: string[]
}

function buildChatGrounding(result: ChannelAnalysisResult): string {
  const competitorSection =
    result.competitors.length > 0
      ? `\n\n# 比較チャンネル\n${result.competitors
          .map((c) => describeChannelReport(c, false))
          .join('\n\n')}`
      : ''
  const researchSection =
    result.insight.researchText !== ''
      ? `\n\n# 外部調査の結果(Google検索で取得済み)\n${result.insight.researchText}`
      : ''
  return `あなたはYouTubeチャンネルの分析担当です。利用者の質問に日本語で答えてください。

# 実測(プログラムがYouTube公式APIから計算した確定値)
${describeChannelReport(result.primary, true)}

# 分析対象の動画一覧
${numberedVideoList(result.primary)}${competitorSection}${researchSection}

# 回答のルール
- 数値は上の実測に書かれている値をそのまま引用する。**自分で計算し直さない**。
- クリック率・視聴維持率・インプレッション・視聴者層は**取得できていない**。聞かれたら「このアプリでは取得できない(YouTube Studioの所有者向けデータが必要)」と答える。推測値を出さない。
- 実測から読み取れないことは「取得したデータからは分からない」と正直に言い、代わりに何を見れば分かるかを添える。
- 一般論を述べるときは、それが一般論であることを明示する。
- 簡潔に。長くても500字程度。Markdownの見出しや強調記号は使わない。`
}

/**
 * 追加の質問に答える。
 *
 * `useSearch` を立てると、答える前に Google 検索で裏取りする。ここが
 * Ask Studio との一番はっきりした違いで、向こうは**チャンネルの外を見ない**。
 */
export async function askAboutChannel(
  apiKey: string,
  result: ChannelAnalysisResult,
  history: ChannelChatTurn[],
  question: string,
  useSearch: boolean
): Promise<ChannelChatAnswer> {
  const contents: GeminiTurn[] = [
    { role: 'user', parts: [{ text: buildChatGrounding(result) }] },
    { role: 'model', parts: [{ text: '承知しました。実測の範囲で回答します。' }] },
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: question }] }
  ]
  const answer = await generateContent(apiKey, contents, { search: useSearch })
  return { text: answer.text, sources: answer.sources, queries: answer.queries }
}

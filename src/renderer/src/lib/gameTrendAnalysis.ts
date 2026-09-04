import { fetchJson, parseModelJsonObject } from './httpJson'
import { searchRecentShorts, type YouTubeVideoInfo } from './youtube'
import {
  aggregateGames,
  attributedVideoCount,
  rankGames,
  summarizeShorts,
  type GameAttribution,
  type RankedGame,
  type ShortsVerification
} from './gameResearch'

/**
 * ゲームリサーチの**言葉にする側**。
 *
 * 流れは3段。**数を扱う段はAIを通らない**(集計と順位は `gameResearch.ts`)。
 *
 * 1. 判定 … タイトル1本ごとに「どのゲームか」だけをAIに答えさせる。番号で受け取る。
 * 2. 裏取り … 上位の候補について、そのゲームの**直近のショート**をYouTube検索で数え直す。
 * 3. 執筆 … 確定した順位と実測値を渡し、AIには**理由と撮り方の文章だけ**を書かせる。
 *
 * 以前は1回の呼び出しで「抽出・比較・推薦」を全部AIにやらせていた。文章は自然に読めるが、
 * 件数や勢いの比較が合っている保証がどこにも無く、根拠のタイトルも言い換えられうる
 * (画面に出る「根拠」が、渡していない文字列になりうる)。番号で受け渡しすることで、
 * 根拠は常にこちらが取得した原文そのものになる。
 */

export interface ViralFactor {
  hookType: string
  exampleTitle: string
  explanation: string
}

export interface ThumbnailInsight {
  colorTendency: string
  compositionTendency: string
  textOverlayTendency: string
}

export interface RecommendedGame {
  gameName: string
  reason: string
}

/** 順位と実測値(コード側で確定)に、AIが書いた文章を足したもの */
export interface AnalyzedGame extends RankedGame {
  whyNow: string
  sceneSuggestion: string
}

export interface GameTrendAnalysis {
  rankedGames: AnalyzedGame[]
  /** 取得した急上昇動画の本数 */
  analyzedVideoCount: number
  /** そのうち、タイトルからゲームを特定できなかった本数(雑談・切り抜き等) */
  unattributedCount: number
  /**
   * 裏取り(YouTube検索)が**実際に成った候補の数**。
   * 「実行したかどうか」ではなく数を持つのは、検索は1件ずつ失敗しうるため
   * (上限に当たる・通信が切れる)。5件やったつもりで3件しか取れていない状態で
   * 「上位5件は裏取り済み」と画面に書くのは、この画面が繰り返してきた間違い。
   */
  verifiedCount: number
  generalTips: string[]
  viralFactors: ViralFactor[]
  thumbnailInsight: ThumbnailInsight | null
  recommendedGame: RecommendedGame | null
}

const GEMINI_MODEL = 'gemini-flash-latest'
/** サムネイルを取りに行く上限。**実際に添付できた枚数とは別物**(下の buildComposePrompt 参照) */
const THUMBNAIL_SAMPLE_COUNT = 5
/** 裏取りをかける候補の数。YouTube の検索は1回100ユニット消費するのでむやみに増やさない */
export const VERIFY_TOP_N = 5
/** 裏取りで「直近」とみなす日数 */
export const VERIFY_WINDOW_DAYS = 14
/** 文章を付けて画面に出す上限 */
const MAX_RANKED_GAMES = 8

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message?: string }
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

async function callGemini(
  apiKey: string,
  parts: GeminiPart[],
  expectJson: boolean
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        ...(expectJson ? { generationConfig: { responseMimeType: 'application/json' } } : {})
      })
    },
    'Gemini API'
  )
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text || !text.trim()) throw new Error('Geminiからの応答が空でした')
  return text
}

/** 依頼文に載せる番号付きの一覧。**番号がそのまま突き合わせの鍵**になる */
function buildNumberedTitles(videos: YouTubeVideoInfo[]): string {
  return videos.map((v, i) => `${i + 1}. 「${v.title}」 / チャンネル: ${v.channelTitle}`).join('\n')
}

function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '不明'
  return Math.round(n).toLocaleString('ja-JP')
}

function formatViews(n: number): string {
  if (!Number.isFinite(n)) return '不明'
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万回`
  return `${Math.round(n)}回`
}

function formatHoursAgo(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '不明'
  if (hours < 1) return '1時間以内'
  if (hours < 24) return `${Math.round(hours)}時間前`
  return `${Math.round(hours / 24)}日前`
}

// ── 1. 判定 ────────────────────────────────────────────────────────────────

function buildAttributionPrompt(videos: YouTubeVideoInfo[]): string {
  return `あなたはゲーム動画のタイトルから「どのゲームの動画か」を読み取る担当です。以下はYouTube Data API(公式)で取得した、日本のゲームカテゴリ急上昇動画のタイトル一覧です。

# 判定のルール
- 根拠にしてよいのは、各行に書かれているタイトルとチャンネル名の文字だけです。あなたが知っている情報で補わないでください。
- 同じゲームには必ず同じ表記を使ってください(1行目で「Apex Legends」と書いたら、以降も「Apex Legends」)。タイトルに略称しか無い場合は、その略称のまま書いてください。
- 雑談・歌ってみた・切り抜き・実写など、ゲームを扱っていない動画は gameName を null にしてください。
- ゲーム名が読み取れるが確実とは言えない場合は confidence を "low" に、タイトルに明記されている場合だけ "high" にしてください。推測で "high" を付けないでください。
- 入力の全${videos.length}行について、必ず1件ずつ、行の番号(index)を付けて返してください。行を飛ばさないでください。

# タイトル一覧
${buildNumberedTitles(videos)}

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{ "attributions": [{ "index": 1, "gameName": "string または null", "confidence": "high" }] }`
}

function parseAttributions(text: string): GameAttribution[] {
  const parsed = parseModelJsonObject(text, 'Gemini API')
  const raw = Array.isArray(parsed.attributions) ? parsed.attributions : []
  const result: GameAttribution[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const o = item as Record<string, unknown>
    // 番号は数値で返るとは限らない("3" や 3.0 が来る)。整数に落とせるものだけ通す
    const index = typeof o.index === 'number' ? o.index : Number(o.index)
    if (!Number.isFinite(index)) continue
    const gameName = typeof o.gameName === 'string' ? o.gameName : ''
    if (gameName.trim() === '' || gameName.trim().toLowerCase() === 'null') continue
    result.push({
      index: Math.round(index),
      gameName,
      // 明示的に "high" と書かれたものだけを数に入れる(既定を high にすると、
      // 欄を落としただけの曖昧な判定が満点の根拠として混ざる)
      confidence: o.confidence === 'high' ? 'high' : 'low'
    })
  }
  return result
}

// ── 2. 裏取り ──────────────────────────────────────────────────────────────

async function verifyCandidates(
  youtubeApiKey: string,
  candidates: RankedGame[],
  now: number,
  onStep: (done: number, total: number) => void
): Promise<Map<string, ShortsVerification>> {
  const verifications = new Map<string, ShortsVerification>()
  let done = 0
  onStep(0, candidates.length)
  // 直列に回す。まとめて投げると、上限に当たったときに**全部**巻き添えで失敗する
  // (裏取りは1件でも取れれば順位の精度が上がるので、取れた分は残したい)
  for (const candidate of candidates) {
    const name = candidate.stats.displayName
    try {
      const shorts = await searchRecentShorts(
        youtubeApiKey,
        name,
        VERIFY_WINDOW_DAYS,
        THUMBNAIL_SAMPLE_COUNT * 2
      )
      verifications.set(
        candidate.stats.key,
        summarizeShorts(candidate.stats.key, name, VERIFY_WINDOW_DAYS, shorts, now)
      )
    } catch {
      // 検索の失敗(上限・通信断)で分析そのものを落とさない。この候補は
      // 「裏取りなし」として順位に残り、画面にもそう出る
    }
    done += 1
    onStep(done, candidates.length)
  }
  return verifications
}

// ── 3. 執筆 ────────────────────────────────────────────────────────────────

function describeRanked(ranked: RankedGame[]): string {
  if (ranked.length === 0) {
    return '(タイトルからゲーム名を特定できた動画がありませんでした。gamesは空配列にしてください)'
  }
  return ranked
    .map((g, i) => {
      const s = g.stats
      const lines = [
        `${i + 1}位: ${s.displayName} / 総合スコア ${g.score.total}点(勢い ${g.score.momentum} / 新しさ ${g.score.freshness} / 広がり ${g.score.spread} / ショート適性 ${g.score.shortsFit})`,
        `  急上昇での本数: ${s.videoCount}本(${s.channelCount}チャンネル) / 再生速度の中央値: ${formatCount(s.medianViewsPerHour)}回/時 / 最速: ${formatCount(s.topViewsPerHour)}回/時 / 最新の動画: ${formatHoursAgo(s.newestHoursAgo)}`
      ]
      if (g.verification) {
        lines.push(
          g.verification.shortsFound > 0
            ? `  裏取り(直近${g.verification.windowDays}日のショート検索): ${g.verification.shortsFound}本 / 速度の中央値 ${formatCount(g.verification.medianViewsPerHour)}回/時${g.verification.topVideo ? ` / 最も伸びたショート「${g.verification.topVideo.title}」(${formatViews(g.verification.topVideo.viewCount)})` : ''}`
            : `  裏取り(直近${g.verification.windowDays}日のショート検索): 該当なし(このゲームのショートは直近で見つからなかった)`
        )
      } else {
        lines.push('  裏取り: 未実施')
      }
      lines.push(`  根拠タイトル: ${s.videos.map((v) => `「${v.title}」`).join(' ')}`)
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * 執筆の依頼文を組み立てる。
 *
 * `thumbnailCount` は**実際に添付できた画像の枚数**。取りに行く上限
 * (`THUMBNAIL_SAMPLE_COUNT`)を書いてはいけない——両者はふつうに食い違う。
 * 急上昇の一覧が5件に満たないこともあるし、サムネイルの取得は1枚ずつ失敗しうる
 * (取れなかった分は `null` として捨てられる)。定数を名乗ると、**モデルには
 * 「5件を見て傾向をまとめろ」と言いながら2枚しか見せない**ことになる。
 * 依頼文では「リストにない情報を創作しないこと」と求めているのに、こちらが
 * 事実でない件数を宣言している状態で、しかもエラーは出ない。
 * (実測: 急上昇3件・サムネイル取得成功2件で、添付した画像は **2枚**なのに
 *  依頼文は「再生数上位**5**件のサムネイル画像を添付しています」と名乗っていた)
 */
function buildComposePrompt(
  videos: YouTubeVideoInfo[],
  ranked: RankedGame[],
  thumbnailCount: number,
  userInstruction: string
): string {
  // 件数として文面に出す値なので、整数に落としてから使う(`2.5件` と書かないため)。
  const attached =
    Number.isFinite(thumbnailCount) && thumbnailCount > 0 ? Math.floor(thumbnailCount) : 0
  // The user's own words are quoted into the prompt rather than concatenated as bare
  // instructions, so a long note can't read as a replacement for the output contract below.
  const instructionSection = userInstruction.trim()
    ? `\n\n# 利用者からの補足指示\n利用者が次の指示を出しています。文章の観点や語り口をこれに寄せてください。ただし出力形式・順位・数値を変えないこと。\n"""\n${userInstruction.trim()}\n"""`
    : ''
  const thumbnailSection =
    attached > 0
      ? `\n\n# サムネイル画像\n再生数上位${attached}件のサムネイル画像を添付しています。画像から読み取れる範囲でのみ視覚的傾向を分析してください。`
      : ''
  const thumbnailInstruction =
    attached > 0
      ? '4. 添付したサムネイル画像から読み取れる視覚的傾向(thumbnailInsight)を、配色の傾向(colorTendency)・構図の傾向(compositionTendency、例: 顔のアップが多い等)・文字入れの傾向(textOverlayTendency)の3項目で、それぞれ日本語1文でまとめてください。画像がない場合はthumbnailInsightをnullにしてください。'
      : '4. サムネイル画像は添付されていないため、thumbnailInsightはnullにしてください。'

  return `あなたはYouTube Shorts(ゲーム実況)の編集アドバイザーです。

以下の「集計結果」は、YouTube Data API(公式)で取得した実データをプログラムが集計・採点したものです。**順位と数値は確定済みです。並べ替えたり、別の数字を書いたり、ここに無いゲームを足したりしないでください。** あなたの仕事は、この結果に日本語の説明を付けることだけです。

# 集計結果(確定済み)
${describeRanked(ranked)}

# 採点の定義(説明に使ってよい)
- 勢い(40点満点): 各動画の「再生数 ÷ 公開からの経過時間」の中央値。
- 新しさ(25点満点): 最新の動画の経過時間。6時間以内で満点、7日で0点。
- 広がり(20点満点): 何チャンネルが出しているか(本数より重視)。1チャンネルだけなら0点。
- ショート適性(15点満点): 直近${VERIFY_WINDOW_DAYS}日にそのゲームのショートが実際に何本あり、どれくらいの速さで回っているか。裏取り未実施の場合は急上昇内のショート比率から控えめに見積もった値。

# 急上昇動画リスト(番号は根拠の引用に使う)
${buildNumberedTitles(videos)}${thumbnailSection}${instructionSection}

# 依頼内容
1. 集計結果の各ゲームについて、**なぜ今それなのか**(whyNow、日本語1〜2文)を書いてください。必ず上の集計結果にある数値を根拠として引用し、そこに無い数字を作らないでください。rankには集計結果の順位をそのまま入れてください。
2. 同じく各ゲームについて、いま撮るなら押さえるべきシーンの特徴(sceneSuggestion、日本語1〜2文、具体的に)を書いてください。根拠タイトルから読み取れる範囲で書き、ゲームの内容を推測で語らないでください。
3. タイトルの「バズる要素」を構造化して抽出してください(viralFactors、最大5件)。各タイトルが使っているフック手法を分類し(hookType、例: 数字訴求/疑問形/煽り文句/意外性の提示/共感訴求など)、根拠にした**急上昇動画リストの番号**(exampleIndex)と、なぜ効果的そうか(explanation、日本語1文)を挙げてください。番号は必ずリストにあるものを使ってください。
${thumbnailInstruction}
5. リスト全体を俯瞰した、ゲーム実況ショート動画の編集で使える一般的なコツ(generalTips)を3つ、日本語の短い文で挙げてください。
6. 1位のゲームを今日撮るべき理由(recommendedReason、日本語2〜3文)を、集計結果の数値を引用して書いてください。2位以下との差にも触れてください。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "games": [{ "rank": 1, "whyNow": "string", "sceneSuggestion": "string" }],
  "viralFactors": [{ "hookType": "string", "exampleIndex": 1, "explanation": "string" }],
  "thumbnailInsight": { "colorTendency": "string", "compositionTendency": "string", "textOverlayTendency": "string" } | null,
  "generalTips": ["string"],
  "recommendedReason": "string"
}`
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 順位に対して書かれた文章を、順位で引き当てられる形にする */
function parseGameTexts(parsed: Record<string, unknown>): Map<
  number,
  {
    whyNow: string
    sceneSuggestion: string
  }
> {
  const map = new Map<number, { whyNow: string; sceneSuggestion: string }>()
  const raw = Array.isArray(parsed.games) ? parsed.games : []
  for (const item of raw) {
    if (!isObject(item)) continue
    const rank = typeof item.rank === 'number' ? item.rank : Number(item.rank)
    if (!Number.isFinite(rank)) continue
    map.set(Math.round(rank), {
      whyNow: asString(item.whyNow),
      sceneSuggestion: asString(item.sceneSuggestion)
    })
  }
  return map
}

/**
 * バズる要素の引用を、**番号で**元のタイトルに引き当てる。
 * 範囲外の番号は捨てる——引けなかったものを空文字で残すと、
 * 画面に「根拠のないフック分類」が並ぶ。
 */
function parseViralFactors(
  parsed: Record<string, unknown>,
  videos: YouTubeVideoInfo[]
): ViralFactor[] {
  const raw = Array.isArray(parsed.viralFactors) ? parsed.viralFactors : []
  const factors: ViralFactor[] = []
  for (const item of raw) {
    if (!isObject(item)) continue
    const index =
      typeof item.exampleIndex === 'number' ? item.exampleIndex : Number(item.exampleIndex)
    if (!Number.isFinite(index)) continue
    const i = Math.round(index)
    if (i < 1 || i > videos.length) continue
    const hookType = asString(item.hookType)
    if (hookType.trim() === '') continue
    factors.push({
      hookType,
      exampleTitle: videos[i - 1].title,
      explanation: asString(item.explanation)
    })
  }
  return factors
}

/** AIが理由を落としたときのために、**数値だけで**成立する文章を用意しておく */
function fallbackReason(top: RankedGame): string {
  const s = top.stats
  const verified =
    top.verification && top.verification.shortsFound > 0
      ? ` 直近${top.verification.windowDays}日のショート検索でも${top.verification.shortsFound}本(速度の中央値 ${formatCount(top.verification.medianViewsPerHour)}回/時)が見つかっています。`
      : ''
  return `急上昇に${s.videoCount}本(${s.channelCount}チャンネル)出ており、再生速度の中央値は${formatCount(s.medianViewsPerHour)}回/時、最新の動画は${formatHoursAgo(s.newestHoursAgo)}です。総合スコアは${top.score.total}点で最上位でした。${verified}`
}

interface GeminiInlineImage {
  mimeType: string
  data: string
}

async function fetchThumbnailAsInlineImage(url: string): Promise<GeminiInlineImage | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    const buffer = await blob.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return { mimeType: blob.type || 'image/jpeg', data: btoa(binary) }
  } catch {
    return null
  }
}

// ── 入口 ───────────────────────────────────────────────────────────────────

export type ResearchPhase = 'attribute' | 'verify' | 'compose'

export interface ResearchProgress {
  phase: ResearchPhase
  done?: number
  total?: number
}

export interface AnalyzeOptions {
  userInstruction?: string
  /** 裏取りに使う YouTube Data API キー。無ければ裏取りは行わない */
  youtubeApiKey?: string
  verify?: boolean
  /** 経過時間の基準。テストと、長い分析中に時計が動くのを避けるために外から渡せる */
  now?: number
  onProgress?: (progress: ResearchProgress) => void
}

export async function analyzeGamingTrends(
  apiKey: string,
  videos: YouTubeVideoInfo[],
  options: AnalyzeOptions = {}
): Promise<GameTrendAnalysis> {
  const { userInstruction = '', youtubeApiKey = '', verify = false, onProgress } = options
  // 基準時刻は**最初に1つだけ**決める。段ごとに `Date.now()` を読むと、裏取りの
  // 数十秒の間に基準がずれ、同じ動画の「経過時間」が段によって変わる
  const now = Number.isFinite(options.now) ? (options.now as number) : Date.now()

  onProgress?.({ phase: 'attribute' })
  const attributionText = await callGemini(apiKey, [{ text: buildAttributionPrompt(videos) }], true)
  const attributions = parseAttributions(attributionText)
  const stats = aggregateGames(videos, attributions, now)

  let ranked = rankGames(stats)
  let verifications = new Map<string, ShortsVerification>()
  const canVerify = verify && youtubeApiKey !== '' && ranked.length > 0
  if (canVerify) {
    verifications = await verifyCandidates(
      youtubeApiKey,
      ranked.slice(0, VERIFY_TOP_N),
      now,
      (done, total) => onProgress?.({ phase: 'verify', done, total })
    )
    // 裏取りの結果を入れて**採点し直す**。ショートが1本も無い候補はここで下がる
    ranked = rankGames(stats, verifications)
  }
  const top = ranked.slice(0, MAX_RANKED_GAMES)

  onProgress?.({ phase: 'compose' })
  const topByViews = [...videos]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, THUMBNAIL_SAMPLE_COUNT)
  const images = (
    await Promise.all(
      topByViews.map((v) => (v.thumbnailUrl ? fetchThumbnailAsInlineImage(v.thumbnailUrl) : null))
    )
  ).filter((img): img is GeminiInlineImage => img !== null)

  const parts: GeminiPart[] = [
    // 名乗る件数は**実際に添付する枚数**。取りに行った上限ではない(理由は buildComposePrompt)。
    { text: buildComposePrompt(videos, top, images.length, userInstruction) },
    ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
  ]
  const composed = parseModelJsonObject(await callGemini(apiKey, parts, true), 'Gemini API')
  const texts = parseGameTexts(composed)

  const rankedGames: AnalyzedGame[] = top.map((g, i) => {
    const text = texts.get(i + 1)
    return {
      ...g,
      whyNow: text?.whyNow ?? '',
      sceneSuggestion: text?.sceneSuggestion ?? ''
    }
  })

  const recommendedReason = asString(composed.recommendedReason).trim()
  const recommendedGame: RecommendedGame | null =
    top.length > 0
      ? {
          gameName: top[0].stats.displayName,
          reason: recommendedReason !== '' ? recommendedReason : fallbackReason(top[0])
        }
      : null

  return {
    rankedGames,
    analyzedVideoCount: videos.length,
    unattributedCount: Math.max(0, videos.length - attributedVideoCount(stats)),
    verifiedCount: verifications.size,
    generalTips: asStringArray(composed.generalTips),
    viralFactors: parseViralFactors(composed, videos),
    thumbnailInsight: isObject(composed.thumbnailInsight)
      ? {
          colorTendency: asString(composed.thumbnailInsight.colorTendency),
          compositionTendency: asString(composed.thumbnailInsight.compositionTendency),
          textOverlayTendency: asString(composed.thumbnailInsight.textOverlayTendency)
        }
      : null,
    recommendedGame
  }
}

// ── 追加の質問 ─────────────────────────────────────────────────────────────

export interface TrendChatTurn {
  role: 'user' | 'model'
  text: string
}

function buildChatSystemPrompt(
  videos: YouTubeVideoInfo[],
  analysis: GameTrendAnalysis | null
): string {
  const rankedSection = analysis
    ? `\n\n# 集計結果(プログラムが実測・採点したもの)\n${describeRanked(analysis.rankedGames)}`
    : ''
  const textSection =
    analysis && analysis.rankedGames.length > 0
      ? `\n\n# 提示済みの解説\n${analysis.rankedGames
          .map((g, i) => `${i + 1}位 ${g.stats.displayName}: ${g.whyNow} ${g.sceneSuggestion}`)
          .join('\n')}`
      : ''
  return `あなたはYouTube Shortsの編集アドバイザーです。利用者からの質問に日本語で答えてください。

判断材料は、以下の「急上昇動画リスト」(YouTube Data APIで取得した実データ)と「集計結果」「提示済みの解説」だけです。

# 急上昇動画リスト
${buildNumberedTitles(videos)}${rankedSection}${textSection}

# 回答のルール
- リストや集計結果から読み取れないことを推測で断言しないこと。答えられない場合は「取得したデータからは分からない」と正直に言い、代わりに何を調べれば分かるかを添える。
- 一般論(編集技法・YouTubeの傾向など)を答えるときは、それがデータに基づく話ではなく一般論であることを明示する。
- 具体的な数字やタイトルを挙げるときは、必ずリストや集計結果にある値をそのまま引用する。自分で計算し直した数字を出さない。
- 簡潔に答える。前置きや復唱はせず、聞かれたことに直接答える。長くても400字程度。
- 箇条書きが分かりやすい場合は使ってよい。Markdownの見出しや強調記号は使わない。`
}

export async function askAboutTrends(
  apiKey: string,
  videos: YouTubeVideoInfo[],
  analysis: GameTrendAnalysis | null,
  history: TrendChatTurn[],
  question: string
): Promise<string> {
  // The grounding data is folded into the first user turn (rather than sent as a
  // separate system instruction) so it stays attached to the conversation on every
  // follow-up question without being re-sent each time.
  const contents = [
    { role: 'user', parts: [{ text: buildChatSystemPrompt(videos, analysis) }] },
    { role: 'model', parts: [{ text: '承知しました。取得したデータの範囲で回答します。' }] },
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: question }] }
  ]

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents })
    },
    'Gemini API'
  )
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text || !text.trim()) throw new Error('Geminiからの応答が空でした')
  return text.trim()
}

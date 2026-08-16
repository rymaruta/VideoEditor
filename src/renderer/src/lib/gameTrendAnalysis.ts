import { fetchJson, parseModelJsonObject } from './httpJson'
import type { YouTubeVideoInfo } from './youtube'

export interface GameTrendInsight {
  gameName: string
  evidenceTitles: string[]
  sceneSuggestion: string
}

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

export interface GameTrendAnalysis {
  insights: GameTrendInsight[]
  generalTips: string[]
  viralFactors: ViralFactor[]
  thumbnailInsight: ThumbnailInsight | null
  recommendedGame: RecommendedGame | null
}

const GEMINI_MODEL = 'gemini-flash-latest'
/** サムネイルを取りに行く上限。**実際に添付できた枚数とは別物**(下の buildPrompt 参照) */
const THUMBNAIL_SAMPLE_COUNT = 5

function buildVideoList(videos: YouTubeVideoInfo[]): string {
  return videos
    .map(
      (v, i) => `${i + 1}. 「${v.title}」 / チャンネル: ${v.channelTitle} / 再生数: ${v.viewCount}`
    )
    .join('\n')
}

/**
 * 分析の依頼文を組み立てる。
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
 *
 * ハイライト採点(`autoEdit`)の依頼文は最初から `${frames.length}` と実数を名乗っており、
 * ここだけ定数のままだった。
 */
function buildPrompt(
  videos: YouTubeVideoInfo[],
  thumbnailCount: number,
  userInstruction: string
): string {
  // 件数として文面に出す値なので、整数に落としてから使う(`2.5件` と書かないため)。
  const attached =
    Number.isFinite(thumbnailCount) && thumbnailCount > 0 ? Math.floor(thumbnailCount) : 0
  const list = buildVideoList(videos)
  // The user's own words are quoted into the prompt rather than concatenated as bare
  // instructions, so a long note can't read as a replacement for the output contract below.
  const instructionSection = userInstruction.trim()
    ? `\n\n# 利用者からの補足指示\n利用者が次の指示を出しています。分析の観点や語り口をこれに寄せてください。ただし出力形式と「リストにない情報を創作しない」原則は必ず守ること。\n"""\n${userInstruction.trim()}\n"""`
    : ''
  const thumbnailSection =
    attached > 0
      ? `\n\n# サムネイル画像\n再生数上位${attached}件のサムネイル画像を添付しています。画像から読み取れる範囲でのみ視覚的傾向を分析してください。`
      : ''
  const thumbnailInstruction =
    attached > 0
      ? '4. 添付したサムネイル画像から読み取れる視覚的傾向(thumbnailInsight)を、配色の傾向(colorTendency)・構図の傾向(compositionTendency、例: 顔のアップが多い等)・文字入れの傾向(textOverlayTendency)の3項目で、それぞれ日本語1文でまとめてください。画像がない場合はthumbnailInsightをnullにしてください。'
      : '4. サムネイル画像は添付されていないため、thumbnailInsightはnullにしてください。'

  return `あなたはYouTube Shortsの編集アドバイザーです。以下はYouTube Data API(公式)で取得した「日本のゲームカテゴリ急上昇動画」の実際のタイトル・チャンネル名・再生数のリストです。このリストと添付画像に書かれている情報だけを根拠にして分析してください。リストにないゲームや情報を推測・創作しないでください。

# 急上昇動画リスト
${list}${thumbnailSection}${instructionSection}

# 依頼内容
1. 上記リストのタイトルから実際に読み取れるゲーム名を抽出し、それぞれについて根拠となったタイトル(evidenceTitles、リスト内の文字列をそのまま引用)と、そのゲームの動画で今バズっていそうなシーンの特徴(sceneSuggestion、日本語で1〜2文、具体的に)をまとめてください。タイトルからゲーム名が判断できない場合はそのタイトルは無視してください。
2. リスト全体を俯瞰した、ゲーム実況ショート動画の編集で使える一般的なコツ(generalTips)を3つ、日本語の短い文で挙げてください。
3. タイトルの「バズる要素」を構造化して抽出してください(viralFactors)。各タイトルが使っているフック手法を分類し(hookType、例: 数字訴求/疑問形/煽り文句/意外性の提示/共感訴求など)、根拠となったタイトル(exampleTitle、リスト内の文字列をそのまま引用)と、なぜそれが効果的そうか(explanation、日本語1文)を挙げてください。最大5件まで。
${thumbnailInstruction}
5. 上記1で抽出したゲームの中から、今すぐ動画を作るなら最も良さそうなゲームを1つ選んでください(recommendedGame)。急上昇動画の件数や新しさ、シーンの分かりやすさ・真似しやすさを根拠に、なぜそのゲームを勧めるのか(reason、日本語2〜3文)を具体的に説明してください。ゲームが1件も抽出できなかった場合はrecommendedGameをnullにしてください。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "insights": [{ "gameName": "string", "evidenceTitles": ["string"], "sceneSuggestion": "string" }],
  "generalTips": ["string"],
  "viralFactors": [{ "hookType": "string", "exampleTitle": "string", "explanation": "string" }],
  "thumbnailInsight": { "colorTendency": "string", "compositionTendency": "string", "textOverlayTendency": "string" } | null,
  "recommendedGame": { "gameName": "string", "reason": "string" } | null
}`
}

export interface TrendChatTurn {
  role: 'user' | 'model'
  text: string
}

function buildChatSystemPrompt(
  videos: YouTubeVideoInfo[],
  analysis: GameTrendAnalysis | null
): string {
  const analysisSection = analysis
    ? `\n\n# すでに提示済みの分析結果\n${JSON.stringify(analysis, null, 2)}`
    : ''
  return `あなたはYouTube Shortsの編集アドバイザーです。利用者からの質問に日本語で答えてください。

判断材料は、以下の「急上昇動画リスト」(YouTube Data APIで取得した実データ)と「すでに提示済みの分析結果」だけです。

# 急上昇動画リスト
${buildVideoList(videos)}${analysisSection}

# 回答のルール
- リストや分析結果から読み取れないことを推測で断言しないこと。答えられない場合は「取得したデータからは分からない」と正直に言い、代わりに何を調べれば分かるかを添える。
- 一般論(編集技法・YouTubeの傾向など)を答えるときは、それがデータに基づく話ではなく一般論であることを明示する。
- 具体的な数字やタイトルを挙げるときは、必ずリストにある文字列をそのまま引用する。
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

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message?: string }
}

export async function analyzeGamingTrends(
  apiKey: string,
  videos: YouTubeVideoInfo[],
  userInstruction = ''
): Promise<GameTrendAnalysis> {
  const topByViews = [...videos]
    .sort((a, b) => b.viewCount - a.viewCount)
    .slice(0, THUMBNAIL_SAMPLE_COUNT)
  const images = (
    await Promise.all(
      topByViews.map((v) => (v.thumbnailUrl ? fetchThumbnailAsInlineImage(v.thumbnailUrl) : null))
    )
  ).filter((img): img is GeminiInlineImage => img !== null)

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    // 名乗る件数は**実際に添付する枚数**。取りに行った上限ではない(理由は buildPrompt)。
    { text: buildPrompt(videos, images.length, userInstruction) },
    ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
  ]

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    },
    'Gemini API'
  )
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  const parsed = parseModelJsonObject(text, 'Gemini API') as Partial<GameTrendAnalysis>
  // Element-level coercion: the model occasionally returns strings where objects
  // were requested, or omits a field — rendering such an element uncoerced throws
  // during render and blanks the whole app.
  const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  const insights: GameTrendInsight[] = (Array.isArray(parsed.insights) ? parsed.insights : [])
    .filter(isObject)
    .map((o) => ({
      gameName: asString(o.gameName),
      evidenceTitles: asStringArray(o.evidenceTitles),
      sceneSuggestion: asString(o.sceneSuggestion)
    }))
    .filter((o) => o.gameName !== '')
  const viralFactors: ViralFactor[] = (
    Array.isArray(parsed.viralFactors) ? parsed.viralFactors : []
  )
    .filter(isObject)
    .map((o) => ({
      hookType: asString(o.hookType),
      exampleTitle: asString(o.exampleTitle),
      explanation: asString(o.explanation)
    }))
    .filter((o) => o.hookType !== '' || o.exampleTitle !== '')
  const thumbnailInsight: ThumbnailInsight | null = isObject(parsed.thumbnailInsight)
    ? {
        colorTendency: asString(parsed.thumbnailInsight.colorTendency),
        compositionTendency: asString(parsed.thumbnailInsight.compositionTendency),
        textOverlayTendency: asString(parsed.thumbnailInsight.textOverlayTendency)
      }
    : null
  const recommendedGame: RecommendedGame | null =
    isObject(parsed.recommendedGame) && asString(parsed.recommendedGame.gameName) !== ''
      ? {
          gameName: asString(parsed.recommendedGame.gameName),
          reason: asString(parsed.recommendedGame.reason)
        }
      : null

  return {
    insights,
    generalTips: asStringArray(parsed.generalTips),
    viralFactors,
    thumbnailInsight,
    recommendedGame
  }
}

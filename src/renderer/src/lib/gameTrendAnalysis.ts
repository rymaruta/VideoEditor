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
const THUMBNAIL_SAMPLE_COUNT = 5

function buildPrompt(videos: YouTubeVideoInfo[], includeThumbnails: boolean): string {
  const list = videos
    .map(
      (v, i) => `${i + 1}. 「${v.title}」 / チャンネル: ${v.channelTitle} / 再生数: ${v.viewCount}`
    )
    .join('\n')
  const thumbnailSection = includeThumbnails
    ? `\n\n# サムネイル画像\n再生数上位${THUMBNAIL_SAMPLE_COUNT}件のサムネイル画像を添付しています。画像から読み取れる範囲でのみ視覚的傾向を分析してください。`
    : ''
  const thumbnailInstruction = includeThumbnails
    ? '4. 添付したサムネイル画像から読み取れる視覚的傾向(thumbnailInsight)を、配色の傾向(colorTendency)・構図の傾向(compositionTendency、例: 顔のアップが多い等)・文字入れの傾向(textOverlayTendency)の3項目で、それぞれ日本語1文でまとめてください。画像がない場合はthumbnailInsightをnullにしてください。'
    : '4. サムネイル画像は添付されていないため、thumbnailInsightはnullにしてください。'

  return `あなたはYouTube Shortsの編集アドバイザーです。以下はYouTube Data API(公式)で取得した「日本のゲームカテゴリ急上昇動画」の実際のタイトル・チャンネル名・再生数のリストです。このリストと添付画像に書かれている情報だけを根拠にして分析してください。リストにないゲームや情報を推測・創作しないでください。

# 急上昇動画リスト
${list}${thumbnailSection}

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
  videos: YouTubeVideoInfo[]
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
    { text: buildPrompt(videos, images.length > 0) },
    ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }))
  ]

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  })
  const data: GeminiResponse = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Gemini API エラー')
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  let parsed: Partial<GameTrendAnalysis>
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Geminiの応答を解析できませんでした')
  }
  return {
    insights: Array.isArray(parsed.insights) ? parsed.insights : [],
    generalTips: Array.isArray(parsed.generalTips) ? parsed.generalTips : [],
    viralFactors: Array.isArray(parsed.viralFactors) ? parsed.viralFactors : [],
    thumbnailInsight: parsed.thumbnailInsight ?? null,
    recommendedGame: parsed.recommendedGame ?? null
  }
}

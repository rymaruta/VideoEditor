import type { YouTubeVideoInfo } from './youtube'

export interface GameTrendInsight {
  gameName: string
  evidenceTitles: string[]
  sceneSuggestion: string
}

export interface GameTrendAnalysis {
  insights: GameTrendInsight[]
  generalTips: string[]
}

const GEMINI_MODEL = 'gemini-2.0-flash'

function buildPrompt(videos: YouTubeVideoInfo[]): string {
  const list = videos
    .map(
      (v, i) => `${i + 1}. 「${v.title}」 / チャンネル: ${v.channelTitle} / 再生数: ${v.viewCount}`
    )
    .join('\n')
  return `あなたはYouTube Shortsの編集アドバイザーです。以下はYouTube Data API(公式)で取得した「日本のゲームカテゴリ急上昇動画」の実際のタイトル・チャンネル名・再生数のリストです。このリストに書かれている情報だけを根拠にして分析してください。リストにないゲームや情報を推測・創作しないでください。

# 急上昇動画リスト
${list}

# 依頼内容
1. 上記リストのタイトルから実際に読み取れるゲーム名を抽出し、それぞれについて根拠となったタイトル(evidenceTitles、リスト内の文字列をそのまま引用)と、そのゲームの動画で今バズっていそうなシーンの特徴(sceneSuggestion、日本語で1〜2文、具体的に)をまとめてください。タイトルからゲーム名が判断できない場合はそのタイトルは無視してください。
2. リスト全体を俯瞰した、ゲーム実況ショート動画の編集で使える一般的なコツ(generalTips)を3つ、日本語の短い文で挙げてください。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "insights": [{ "gameName": "string", "evidenceTitles": ["string"], "sceneSuggestion": "string" }],
  "generalTips": ["string"]
}`
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message?: string }
}

export async function analyzeGamingTrends(
  apiKey: string,
  videos: YouTubeVideoInfo[]
): Promise<GameTrendAnalysis> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(videos) }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  })
  const data: GeminiResponse = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? 'Gemini API エラー')
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  let parsed: GameTrendAnalysis
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Geminiの応答を解析できませんでした')
  }
  return {
    insights: Array.isArray(parsed.insights) ? parsed.insights : [],
    generalTips: Array.isArray(parsed.generalTips) ? parsed.generalTips : []
  }
}

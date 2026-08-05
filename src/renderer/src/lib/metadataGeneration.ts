import { readJsonResponse } from './httpJson'
export interface TitleCandidate {
  title: string
  hookType: string
}

export interface VideoMetadata {
  titles: TitleCandidate[]
  description: string
  hashtags: string[]
  pinnedComment: string
}

const GEMINI_MODEL = 'gemini-flash-latest'

function buildPrompt(transcript: string, extraContext: string, language: string): string {
  const languageLabel = language === 'english' ? '英語' : '日本語'
  const transcriptSection = transcript.trim()
    ? `# テロップ/文字起こし(時系列順)\n${transcript.trim()}`
    : '# テロップ/文字起こし\n(テロップは設定されていません)'
  const contextSection = extraContext.trim()
    ? `\n\n# 補足情報(投稿者による説明)\n${extraContext.trim()}`
    : ''

  return `あなたはYouTube Shortsの投稿を専門にサポートする編集アドバイザーです。以下の動画のテロップ内容・補足情報・添付されたサムネイル候補画像だけを根拠に、YouTube投稿用のメタデータを${languageLabel}で作成してください。テロップにない出来事を創作しないでください。

${transcriptSection}${contextSection}

# 依頼内容
1. タイトル案(titles)を6件、それぞれ異なるフック手法(hookType、例: 数字訴求/疑問形/煽り文句/意外性の提示/共感訴求/結果の先出しなど)で作成してください。各30文字前後で、YouTube Shortsのタイトルとしてクリックされやすいものにしてください。
2. 概要欄(description)を1つ作成してください。冒頭1〜2行で興味を引く要約、続けて動画の内容説明、最後に登録・コメントを促すCTA(行動喚起)を含めてください。改行を適切に使い、そのままYouTubeの概要欄に貼り付けられる形式にしてください。
3. ハッシュタグ(hashtags)を8〜10個、日本語または英語で、幅広いものとニッチなものを組み合わせて提案してください(先頭の#は含めないでください)。
4. 視聴者のコメントを増やすための固定コメント案(pinnedComment)を1つ、質問形式などエンゲージメントを促す1〜2文で作成してください。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "titles": [{ "title": "string", "hookType": "string" }],
  "description": "string",
  "hashtags": ["string"],
  "pinnedComment": "string"
}`
}

function buildAvoidSection(avoid: string[]): string {
  if (avoid.length === 0) return ''
  return `\n\n# 既に提示した案(内容が重複しない新しい案にしてください)\n${avoid.map((a) => `- ${a}`).join('\n')}`
}

function buildTitlesOnlyPrompt(
  transcript: string,
  extraContext: string,
  language: string,
  avoidTitles: string[]
): string {
  const languageLabel = language === 'english' ? '英語' : '日本語'
  const transcriptSection = transcript.trim()
    ? `# テロップ/文字起こし(時系列順)\n${transcript.trim()}`
    : '# テロップ/文字起こし\n(テロップは設定されていません)'
  const contextSection = extraContext.trim()
    ? `\n\n# 補足情報(投稿者による説明)\n${extraContext.trim()}`
    : ''

  return `あなたはYouTube Shortsの投稿を専門にサポートする編集アドバイザーです。以下の動画のテロップ内容・補足情報・添付されたサムネイル候補画像だけを根拠に、YouTube投稿用のタイトル案を${languageLabel}で作成してください。テロップにない出来事を創作しないでください。

${transcriptSection}${contextSection}${buildAvoidSection(avoidTitles)}

# 依頼内容
タイトル案(titles)を6件、それぞれ異なるフック手法(hookType、例: 数字訴求/疑問形/煽り文句/意外性の提示/共感訴求/結果の先出しなど)で作成してください。各30文字前後で、YouTube Shortsのタイトルとしてクリックされやすいものにしてください。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "titles": [{ "title": "string", "hookType": "string" }]
}`
}

function buildPinnedCommentOnlyPrompt(
  transcript: string,
  extraContext: string,
  language: string,
  avoidComment: string | null
): string {
  const languageLabel = language === 'english' ? '英語' : '日本語'
  const transcriptSection = transcript.trim()
    ? `# テロップ/文字起こし(時系列順)\n${transcript.trim()}`
    : '# テロップ/文字起こし\n(テロップは設定されていません)'
  const contextSection = extraContext.trim()
    ? `\n\n# 補足情報(投稿者による説明)\n${extraContext.trim()}`
    : ''

  return `あなたはYouTube Shortsの投稿を専門にサポートする編集アドバイザーです。以下の動画のテロップ内容・補足情報・添付されたサムネイル候補画像だけを根拠に、YouTube投稿用の固定コメント案を${languageLabel}で作成してください。テロップにない出来事を創作しないでください。

${transcriptSection}${contextSection}${buildAvoidSection(avoidComment ? [avoidComment] : [])}

# 依頼内容
視聴者のコメントを増やすための固定コメント案(pinnedComment)を1つ、質問形式などエンゲージメントを促す1〜2文で作成してください。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
{
  "pinnedComment": "string"
}`
}

interface GeminiInlineImage {
  mimeType: string
  data: string
}

function dataUrlToInlineImage(dataUrl: string): GeminiInlineImage | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  return { mimeType: match[1], data: match[2] }
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message?: string }
}

async function callGemini(
  apiKey: string,
  prompt: string,
  thumbnailDataUrls: string[]
): Promise<unknown> {
  const images = thumbnailDataUrls
    .map(dataUrlToInlineImage)
    .filter((img): img is GeminiInlineImage => img !== null)

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
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
  const data = await readJsonResponse<GeminiResponse>(res, 'Gemini API')
  if (!res.ok) throw new Error(data.error?.message ?? 'Gemini API エラー')
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('Geminiの応答を解析できませんでした')
  }
}

// Element-level coercion: the model occasionally returns bare strings where
// {title, hookType} objects were requested, or non-string array items — rendering
// such an element uncoerced throws during render and blanks the whole app.
function coerceTitles(value: unknown): TitleCandidate[] {
  if (!Array.isArray(value)) return []
  return value
    .map((t): TitleCandidate | null => {
      if (typeof t === 'string') return { title: t, hookType: '' }
      if (typeof t === 'object' && t !== null) {
        const o = t as Record<string, unknown>
        const title = typeof o.title === 'string' ? o.title : ''
        if (!title) return null
        return { title, hookType: typeof o.hookType === 'string' ? o.hookType : '' }
      }
      return null
    })
    .filter((t): t is TitleCandidate => t !== null)
}

function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : []
}

export async function generateVideoMetadata(
  apiKey: string,
  transcript: string,
  extraContext: string,
  language: string,
  thumbnailDataUrls: string[]
): Promise<VideoMetadata> {
  const parsed = (await callGemini(
    apiKey,
    buildPrompt(transcript, extraContext, language),
    thumbnailDataUrls
  )) as Partial<VideoMetadata>
  return {
    titles: coerceTitles(parsed.titles),
    description: typeof parsed.description === 'string' ? parsed.description : '',
    hashtags: coerceStringArray(parsed.hashtags),
    pinnedComment: typeof parsed.pinnedComment === 'string' ? parsed.pinnedComment : ''
  }
}

export async function regenerateTitles(
  apiKey: string,
  transcript: string,
  extraContext: string,
  language: string,
  thumbnailDataUrls: string[],
  avoidTitles: string[]
): Promise<TitleCandidate[]> {
  const parsed = (await callGemini(
    apiKey,
    buildTitlesOnlyPrompt(transcript, extraContext, language, avoidTitles),
    thumbnailDataUrls
  )) as Partial<VideoMetadata>
  return coerceTitles(parsed.titles)
}

export async function regeneratePinnedComment(
  apiKey: string,
  transcript: string,
  extraContext: string,
  language: string,
  thumbnailDataUrls: string[],
  avoidComment: string | null
): Promise<string> {
  const parsed = (await callGemini(
    apiKey,
    buildPinnedCommentOnlyPrompt(transcript, extraContext, language, avoidComment),
    thumbnailDataUrls
  )) as Partial<VideoMetadata>
  return typeof parsed.pinnedComment === 'string' ? parsed.pinnedComment : ''
}

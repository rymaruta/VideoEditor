import { fetchJson } from './httpJson'

/**
 * Gemini を呼ぶ口を1箇所にまとめる。
 *
 * 呼び出し元ごとに fetch を書くと、**同じ壊れ方を各所で踏み直す**。実際この
 * リポジトリでは「応答の1つ目のパートだけを読む」書き方が写し取られていて、
 * 検索グラウンディングを使うと答えが複数パートに割れるため、**後半が黙って
 * 消える**(短い答えに見えるだけで、エラーは出ない)。読む処理はここに集める。
 */

export const GEMINI_MODEL = 'gemini-flash-latest'

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

export interface GeminiTurn {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

/** グラウンディングで参照された出典 */
export interface WebSource {
  title: string
  uri: string
  /** 表示用のドメイン。出典が本当に外部のものかを利用者が見分けるために出す */
  domain: string
}

export interface GeminiResult {
  text: string
  sources: WebSource[]
  /** モデルが実際に検索した語。何を根拠にしたかを追えるように残す */
  queries: string[]
}

interface GroundingChunk {
  web?: { uri?: string; title?: string; domain?: string }
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    groundingMetadata?: {
      groundingChunks?: GroundingChunk[]
      webSearchQueries?: string[]
    }
  }[]
  error?: { message?: string }
}

function domainOf(uri: string, fallback: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '')
  } catch {
    return fallback
  }
}

function extractSources(chunks: GroundingChunk[] | undefined): WebSource[] {
  const sources: WebSource[] = []
  const seen = new Set<string>()
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    const uri = typeof chunk?.web?.uri === 'string' ? chunk.web.uri : ''
    if (uri === '' || seen.has(uri)) continue
    seen.add(uri)
    const title = typeof chunk.web?.title === 'string' ? chunk.web.title : ''
    // グラウンディングの uri は Google の中継URLなので、ドメインは title 側に
    // 入っていることが多い。取れる方を使う
    const domain =
      typeof chunk.web?.domain === 'string' && chunk.web.domain !== ''
        ? chunk.web.domain
        : domainOf(uri, title)
    sources.push({ title: title || domain || uri, uri, domain })
  }
  return sources
}

/**
 * **検索グラウンディングを使うときの表示義務について。**
 * Google は「Grounding with Google Search」の利用時に、応答へ付いてくる
 * 検索候補(`searchEntryPoint.renderedContent`)の表示を求めている。この実装は
 * HTML をそのまま画面へ差し込むことを避け、代わりに**実際に検索された語**と
 * **出典のドメイン付きリンク**を必ず画面に出している。配布するときは、
 * 各自の利用条件に照らして表示方法を確認すること。
 */
export interface GeminiCallOptions {
  /** JSON だけを返させる。**検索と同時には使えない**(下の注記) */
  json?: boolean
  /** Google 検索で裏取りさせる(グラウンディング) */
  search?: boolean
}

/**
 * 1回呼ぶ。
 *
 * **JSON強制と検索は同時に使わない。** 一部のモデルは `responseMimeType` と
 * ツールの併用を拒否し、しかも失敗の仕方が「空の応答」なので原因が分からない。
 * 外部を調べる段は素の文章で受け取り、構造化は次の段(検索なし)で行う。
 */
export async function generateContent(
  apiKey: string,
  contents: GeminiTurn[],
  options: GeminiCallOptions = {}
): Promise<GeminiResult> {
  const useSearch = options.search === true
  const body: Record<string, unknown> = { contents }
  if (useSearch) body.tools = [{ google_search: {} }]
  else if (options.json) body.generationConfig = { responseMimeType: 'application/json' }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<GeminiResponse>(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    },
    'Gemini API'
  )
  const candidate = data.candidates?.[0]
  // **全パートを繋ぐ**。1つ目だけを読むと、グラウンディング時に答えの後半が消える
  const text = (candidate?.content?.parts ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .join('')
    .trim()
  if (text === '') throw new Error('Geminiからの応答が空でした')
  const metadata = candidate?.groundingMetadata
  return {
    text,
    sources: extractSources(metadata?.groundingChunks),
    queries: Array.isArray(metadata?.webSearchQueries)
      ? metadata.webSearchQueries.filter((q): q is string => typeof q === 'string')
      : []
  }
}

/** 1往復だけの呼び出し(依頼文を1つ渡して答えを受け取る) */
export async function generateFromParts(
  apiKey: string,
  parts: GeminiPart[],
  options: GeminiCallOptions = {}
): Promise<GeminiResult> {
  return generateContent(apiKey, [{ role: 'user', parts }], options)
}

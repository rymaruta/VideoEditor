import { readJsonResponse } from './httpJson'

const GEMINI_MODEL = 'gemini-flash-latest'

export interface ScannedWindow {
  start: number
  end: number
  score: number
  transcript: string
}

export interface ShortSegment {
  start: number
  end: number
  role: string
  reason: string
}

export interface ShortPlan {
  title: string
  hookLine: string
  segments: ShortSegment[]
  caption: string
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  error?: { message?: string }
}

function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

function buildPrompt(
  windows: ScannedWindow[],
  targetSeconds: number,
  userNote: string,
  sourceDuration: number
): string {
  const list = windows
    .map(
      (w, i) =>
        `[${i}] ${formatClock(w.start)}〜${formatClock(w.end)} (${(w.end - w.start).toFixed(1)}秒 / 盛り上がり度 ${w.score.toFixed(1)})\n発言: ${w.transcript.trim() || '(音声から文字を取れませんでした)'}`
    )
    .join('\n\n')
  const noteSection = userNote.trim() ? `\n\n# 利用者からの指示\n"""\n${userNote.trim()}\n"""` : ''

  return `あなたはYouTube Shortsの構成作家です。${formatClock(sourceDuration)}の長い動画から、音声の盛り上がりで自動抽出した候補区間のリストを渡します。この中から${targetSeconds}秒前後のショート動画を1本組み立ててください。

# 候補区間
${list}${noteSection}

# 守ること
- **リストにある区間の中からだけ選ぶ**こと。リストに無い時刻を作り出さない。
- 各区間は短く切り詰めてよい(start/endはリストの範囲内に収めること)。冗長な部分は削る。
- 合計の長さを${targetSeconds}秒前後(±20%)にする。**超えないほうを優先**。
- **最初の1つは必ずフック**にする。結論・驚き・一番強い一言から始め、前置きは入れない。
- 2〜5個の区間で構成する。細切れにしすぎない。
- 時系列は必ずしも守らなくてよい。フックを先頭に持ってくることを優先する。
- 発言が空の区間ばかりの場合は、盛り上がり度だけを根拠に選んでよい。その旨をreasonに書く。

# 出力形式
以下のJSON形式のみを出力してください。説明文やコードブロックの記法は不要です。
秒数は元動画の先頭からの秒数(小数可)で書いてください。
{
  "title": "この動画につけるタイトル(日本語30字以内)",
  "hookLine": "冒頭に出すテロップ1行(日本語20字以内)",
  "caption": "投稿時の説明文(日本語80字以内)",
  "segments": [
    { "start": 0, "end": 0, "role": "フック / 本編 / オチ のいずれか", "reason": "なぜこの区間を選んだか(日本語1文)" }
  ]
}`
}

export async function planShortFromWindows(
  apiKey: string,
  windows: ScannedWindow[],
  targetSeconds: number,
  userNote: string,
  sourceDuration: number
): Promise<ShortPlan> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: buildPrompt(windows, targetSeconds, userNote, sourceDuration) }] }
      ],
      generationConfig: { responseMimeType: 'application/json' }
    })
  })
  const data = await readJsonResponse<GeminiResponse>(res, 'Gemini API')
  if (!res.ok) throw new Error(data.error?.message ?? 'Gemini API エラー')
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Geminiからの応答が空でした')

  let parsed: Partial<ShortPlan>
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Geminiの応答を解析できませんでした')
  }

  const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
  const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)

  // The model is told to stay inside the scanned windows, but a hallucinated timestamp
  // would silently cut from the wrong part of a two-hour recording — which is exactly
  // the failure a user would not notice until watching the result. Drop anything that
  // does not land inside a window we actually scanned.
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  const segments: ShortSegment[] = (Array.isArray(parsed.segments) ? parsed.segments : [])
    // The array can contain nulls and primitives when the model goes off-format;
    // reading `.start` off those throws a raw TypeError at the user.
    .filter(isObject)
    .map((o) => {
      return {
        start: asNumber(o.start),
        end: asNumber(o.end),
        role: asString(o.role),
        reason: asString(o.reason)
      }
    })
    .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
    .map((seg) => {
      const window = windows.find((w) => seg.start >= w.start - 0.5 && seg.start < w.end)
      if (!window) return null
      // Clamp to the window rather than rejecting: the model often picks a good start
      // and simply runs the end past the window it came from.
      return {
        ...seg,
        start: Math.max(window.start, seg.start),
        end: Math.min(window.end, seg.end)
      }
    })
    .filter((seg): seg is ShortSegment => seg !== null && seg.end - seg.start >= 0.5)

  if (segments.length === 0) {
    throw new Error('AIが有効な区間を選べませんでした。目標の長さを変えて再実行してください。')
  }

  return {
    title: asString(parsed.title),
    hookLine: asString(parsed.hookLine),
    caption: asString(parsed.caption),
    segments
  }
}

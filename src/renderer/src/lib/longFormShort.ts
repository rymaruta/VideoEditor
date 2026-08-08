import { readJsonResponse } from './httpJson'
import type { SilenceRange } from '@shared/types'

const GEMINI_MODEL = 'gemini-flash-latest'

export type ShortPace = 'fast' | 'normal' | 'relaxed'

export interface PaceProfile {
  label: string
  minSegments: number
  maxSegments: number
  minSeconds: number
  maxSeconds: number
  /** 無音を詰めたあとに残す息継ぎ。0にすると発話の頭が食われて聞き苦しくなる */
  breathSeconds: number
  /** 片側で詰めてよい上限。ゆったりでは詰めすぎないよう小さくする */
  maxTrimSeconds: number
}

export const PACE_PROFILES: Record<ShortPace, PaceProfile> = {
  fast: {
    label: '速め',
    minSegments: 4,
    maxSegments: 6,
    minSeconds: 2.5,
    maxSeconds: 7,
    breathSeconds: 0.05,
    maxTrimSeconds: 2.5
  },
  normal: {
    label: 'ふつう',
    minSegments: 3,
    maxSegments: 5,
    minSeconds: 4,
    maxSeconds: 12,
    breathSeconds: 0.15,
    maxTrimSeconds: 1.5
  },
  relaxed: {
    label: 'ゆったり',
    minSegments: 2,
    maxSegments: 3,
    minSeconds: 8,
    maxSeconds: 20,
    breathSeconds: 0.3,
    maxTrimSeconds: 0.8
  }
}

/** これ以上短くすると一瞬すぎて何が映ったか分からなくなる下限 */
export const MIN_CUT_SECONDS = 1
/** 切り替わりをビートへ寄せてよい最大のズレ。これを超えると内容のほうが壊れる */
export const BEAT_SNAP_TOLERANCE = 0.35

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

/**
 * 区間の頭とお尻に貼り付いている無音を削る。
 *
 * `detectSilence` は区間内の無音を絶対秒で返すので、区間の先頭に接している無音と
 * 末尾に接している無音だけを対象にする(途中の無音は間として残す)。
 * 詰めた結果が `MIN_CUT_SECONDS` を割らないことを必ず保証する — 全編が無音と判定
 * された区間で長さ0になるのを防ぐため。
 */
export function tightenSegmentEdges(
  segment: { start: number; end: number },
  silences: SilenceRange[],
  pace: ShortPace
): { start: number; end: number; headTrimmed: number; tailTrimmed: number } {
  const profile = PACE_PROFILES[pace]
  const originalDuration = segment.end - segment.start
  if (!Number.isFinite(originalDuration) || originalDuration <= 0) {
    return { start: segment.start, end: segment.end, headTrimmed: 0, tailTrimmed: 0 }
  }
  const usable = silences.filter(
    (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start
  )
  const floor = Math.min(MIN_CUT_SECONDS, originalDuration)

  let start = segment.start
  const head = usable.find((s) => s.start <= segment.start + 0.05 && s.end > segment.start + 0.05)
  if (head) {
    const cutTo = Math.min(head.end, segment.end) - profile.breathSeconds
    start = Math.max(segment.start, Math.min(cutTo, segment.start + profile.maxTrimSeconds))
  }

  let end = segment.end
  const tail = usable.find((s) => s.end >= segment.end - 0.05 && s.start < segment.end - 0.05)
  if (tail) {
    const cutTo = Math.max(tail.start, segment.start) + profile.breathSeconds
    end = Math.min(segment.end, Math.max(cutTo, segment.end - profile.maxTrimSeconds))
  }

  // 下限を割ったら、まずお尻を、足りなければ頭を返す。
  if (end - start < floor) end = Math.min(segment.end, start + floor)
  if (end - start < floor) start = Math.max(segment.start, end - floor)

  return { start, end, headTrimmed: start - segment.start, tailTrimmed: segment.end - end }
}

export interface PlannedCut {
  start: number
  end: number
  /** 詰める前の終端。ビートへ寄せる際もここを超えて伸ばさない(選ばれた区間の外に出る) */
  maxEnd: number
}

/**
 * 区間の切り替わり時刻を最寄りのビートへ寄せる。
 *
 * 切り替わりはタイムライン絶対秒で決まるので、前の区間を伸縮させると後ろが全部ずれる。
 * 先頭から順に確定させ、寄せられなかった区間はそのままの長さで次へ送る。
 * 許容外・下限割れ・元区間超過のときは寄せない(中途半端に動かすとビートにも乗らず
 * 内容だけ削れる)。最後の区間の終端はタイムラインの末尾であって切り替わりではない。
 */
export function snapCutsToBeat<T extends PlannedCut>(
  cuts: T[],
  timelineStart: number,
  grid: { bpm: number; offsetSeconds: number },
  toleranceSeconds: number,
  minSeconds: number
): T[] {
  const interval = 60 / grid.bpm
  if (!Number.isFinite(interval) || interval <= 0) return cuts
  let phase = grid.offsetSeconds % interval
  if (!Number.isFinite(phase)) return cuts
  if (phase < 0) phase += interval

  const result: T[] = []
  let cursor = timelineStart
  cuts.forEach((cut, i) => {
    const duration = cut.end - cut.start
    if (i === cuts.length - 1 || !(duration > 0)) {
      result.push(cut)
      cursor += duration > 0 ? duration : 0
      return
    }
    const boundary = cursor + duration
    const nearest = phase + Math.round((boundary - phase) / interval) * interval
    const delta = nearest - boundary
    const newEnd = cut.end + delta
    if (
      Math.abs(delta) <= toleranceSeconds &&
      newEnd - cut.start >= minSeconds &&
      newEnd <= cut.maxEnd
    ) {
      result.push({ ...cut, end: newEnd })
      cursor = nearest
    } else {
      result.push(cut)
      cursor = boundary
    }
  })
  return result
}

/**
 * つなぎ(xfade)は前後のクリップを重ねるので、書き出し尺はタイムライン合計より短くなる。
 * `ffmpegService` の畳み込みと同じ規則(両隣より 0.05 秒以上短くないとカットに落ちる)を
 * そのまま再現し、画面に出す尺が実際の出力尺と食い違わないようにする。
 * `priorLength` は既にタイムラインにある尺(先頭のクリップにはつなぎを付けない)。
 */
export function foldedOutputLength(
  durations: number[],
  transitionSeconds: number,
  priorLength: number
): number {
  const valid = durations.filter((d) => Number.isFinite(d) && d > 0)
  if (valid.length === 0) return priorLength
  let current = priorLength + valid[0]
  for (let i = 1; i < valid.length; i++) {
    const incoming = valid[i]
    const maxDuration = Math.min(current, incoming) - 0.05
    const t = transitionSeconds > 0 ? Math.min(transitionSeconds, maxDuration) : 0
    current = t < 0.02 ? current + incoming : current + incoming - t
  }
  return current
}

function buildPrompt(
  windows: ScannedWindow[],
  targetSeconds: number,
  userNote: string,
  sourceDuration: number,
  pace: ShortPace
): string {
  const list = windows
    .map(
      (w, i) =>
        `[${i}] ${formatClock(w.start)}〜${formatClock(w.end)} (${(w.end - w.start).toFixed(1)}秒 / 盛り上がり度 ${w.score.toFixed(1)})\n発言: ${w.transcript.trim() || '(音声から文字を取れませんでした)'}`
    )
    .join('\n\n')
  const noteSection = userNote.trim() ? `\n\n# 利用者からの指示\n"""\n${userNote.trim()}\n"""` : ''
  const profile = PACE_PROFILES[pace]

  return `あなたはYouTube Shortsの構成作家です。${formatClock(sourceDuration)}の長い動画から、音声の盛り上がりで自動抽出した候補区間のリストを渡します。この中から${targetSeconds}秒前後のショート動画を1本組み立ててください。

# 候補区間
${list}${noteSection}

# 守ること
- **リストにある区間の中からだけ選ぶ**こと。リストに無い時刻を作り出さない。
- 各区間は短く切り詰めてよい(start/endはリストの範囲内に収めること)。冗長な部分は削る。
- 合計の長さを${targetSeconds}秒前後(±20%)にする。**超えないほうを優先**。
- **最初の1つは必ずフック**にする。結論・驚き・一番強い一言から始め、前置きは入れない。
- 全体のテンポは「${profile.label}」。**${profile.minSegments}〜${profile.maxSegments}個の区間**で構成し、1区間は${profile.minSeconds}〜${profile.maxSeconds}秒を目安にする。
- 各区間は言い終わりで切る。区間の頭とお尻の無音はこちらで自動的に詰めるので、多少余っていてよい。
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
  sourceDuration: number,
  pace: ShortPace
): Promise<ShortPlan> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { parts: [{ text: buildPrompt(windows, targetSeconds, userNote, sourceDuration, pace) }] }
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

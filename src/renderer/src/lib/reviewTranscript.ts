import type { Project } from '@shared/types'
import type { PlacedClipRef, TranscriptUtterance } from '@shared/transcript'
import { toCommon } from '@shared/sync/multicam'
import { placedClips } from './transcriptTimeline'
import { buildTimedClips } from './timelineMath'

/**
 * 確認の画面の文字起こし: 発言を時刻順に並べ、**今の本編に残っている所と削った所**を分ける。
 *
 * 発言の言葉(素材の時刻)が、その素材を置いたクリップ(本編・音声トラック・ワイプ)のどれかに
 * 入っていれば「残っている」、どこにも無ければ「削った」(取り消し線で出す)。
 * 言葉の時刻が無い発言は、発言の時間を細かく見て、残っている割合で文字を分ける(目安)。
 * 言葉と言葉の間の長い無音を削っていれば「(無音 2.4 秒)」の印を入れる。
 */

export interface TranscriptPart {
  text: string
  /** 今の本編から削った */
  cut: boolean
  /** 言葉か、削った無音の印か */
  kind: 'speech' | 'pause'
}

export interface TranscriptLine {
  id: string
  speaker?: string
  parts: TranscriptPart[]
  /** 残っている所のタイムラインの区間(全部削っていれば null) */
  start: number | null
  end: number | null
  /** 残っている切れ(タイムラインの区間と収録の時刻。タイムラインで続く切れはまとめてある) */
  spans: LineSpan[]
  /** 並べる順(共通の時刻。同期の無い企画は素材の時刻) */
  order: number
  /** 収録の時刻(共通の時刻。同期の無い企画は素材の時刻) */
  recorded: number
  allCut: boolean
  overlap: boolean
}

/** 残っている切れ: タイムラインの [start, end) と、その収録の時刻 [recStart, recEnd) */
export interface LineSpan {
  start: number
  end: number
  recStart: number
  recEnd: number
}

/** 印を入れる無音の長さ(秒) */
export const PAUSE_MARK_SEC = 1

/** タイムラインで「続いている」とみなす隙間(秒) */
const JOIN_SEC = 0.05

/** 言葉の時刻が無い発言を、どの細かさで見るか(秒) */
const SAMPLE_SEC = 0.1

/** 素材の時刻を置いたクリップ(無ければ null) */
function clipAt(clips: readonly PlacedClipRef[], t: number): PlacedClipRef | null {
  for (const c of clips) if (t >= c.inPoint - 1e-6 && t < c.outPoint) return c
  return null
}

/**
 * 素材の区間 [a, b) のうち、`t` を含むクリップに入っている所のタイムラインの区間。
 * `t` を含むクリップが無ければ null
 */
function placeSpan(
  clips: readonly PlacedClipRef[],
  t: number,
  a: number,
  b: number
): { start: number; end: number } | null {
  const c = clipAt(clips, t)
  if (!c) return null
  const speed = c.speed && c.speed > 0 ? c.speed : 1
  const at = (x: number): number =>
    c.startTime + (Math.min(c.outPoint, Math.max(c.inPoint, x)) - c.inPoint) / speed
  return { start: at(a), end: at(b) }
}

/** 続いた同じ種類の切れを1つにまとめる */
function pushPart(parts: TranscriptPart[], p: TranscriptPart): void {
  const last = parts[parts.length - 1]
  if (last && last.kind === 'speech' && p.kind === 'speech' && last.cut === p.cut)
    last.text += p.text
  else parts.push({ ...p })
}

export function lineOf(
  u: TranscriptUtterance,
  clips: readonly PlacedClipRef[],
  common: (sourceTime: number) => number
): TranscriptLine {
  const parts: TranscriptPart[] = []
  let start: number | null = null
  let end: number | null = null
  const spans: LineSpan[] = []
  const keep = (a: number, b: number, srcA: number, srcB: number): void => {
    start = start === null ? a : Math.min(start, a)
    end = end === null ? b : Math.max(end, b)
    const last = spans[spans.length - 1]
    // タイムラインで続いていて、収録の時刻も前へ進んでいれば 1 つにまとめる
    if (last && Math.abs(a - last.end) <= JOIN_SEC && common(srcA) >= last.recEnd - JOIN_SEC) {
      last.end = Math.max(last.end, b)
      last.recEnd = Math.max(last.recEnd, common(srcB))
    } else spans.push({ start: a, end: b, recStart: common(srcA), recEnd: common(srcB) })
  }
  const words = (u.words ?? []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
  if (words.length > 0) {
    words.forEach((w, i) => {
      if (i > 0) {
        const prev = words[i - 1]
        const gap = w.start - prev.end
        if (gap >= PAUSE_MARK_SEC && clipAt(clips, (prev.end + w.start) / 2) === null)
          parts.push({ text: `(無音 ${gap.toFixed(1)} 秒)`, cut: true, kind: 'pause' })
      }
      const mid = (w.start + Math.max(w.start, w.end)) / 2
      const span = placeSpan(clips, mid, w.start, Math.max(w.start, w.end))
      if (span) keep(span.start, span.end, w.start, Math.max(w.start, w.end))
      pushPart(parts, { text: w.text, cut: span === null, kind: 'speech' })
    })
  } else {
    // 言葉の時刻が無い: 発言の時間を細かく見て、残っている所と削った所の並びを作り、文字を長さで分ける
    const a = u.sourceStart
    const b = Math.max(u.sourceStart, u.sourceEnd)
    const runs: { kept: boolean; len: number }[] = []
    for (let t = a; t < b - 1e-9; t += SAMPLE_SEC) {
      const step = Math.min(SAMPLE_SEC, b - t)
      const span = placeSpan(clips, t + step / 2, t, t + step)
      if (span) keep(span.start, span.end, t, t + step)
      const kept = span !== null
      const last = runs[runs.length - 1]
      if (last && last.kept === kept) last.len += step
      else runs.push({ kept, len: step })
    }
    const chars = [...u.text]
    const total = runs.reduce((s, r) => s + r.len, 0)
    let used = 0
    let acc = 0
    runs.forEach((r, i) => {
      acc += r.len
      const upto = i === runs.length - 1 ? chars.length : Math.round((acc / total) * chars.length)
      const text = chars.slice(used, upto).join('')
      used = upto
      if (text) pushPart(parts, { text, cut: !r.kept, kind: 'speech' })
    })
    if (parts.length === 0) parts.push({ text: u.text, cut: true, kind: 'speech' })
  }
  const recorded = common(u.sourceStart)
  return {
    id: u.id,
    speaker: u.speaker,
    parts,
    start,
    end,
    spans,
    order: recorded,
    recorded,
    allCut: parts.every((p) => p.cut),
    overlap: u.overlap
  }
}

/** 企画の文字起こしを、確認の画面の行に(収録の時刻の順) */
export function reviewTranscriptLines(
  project: Pick<
    Project,
    'transcript' | 'multicam' | 'clips' | 'assets' | 'audioTracks' | 'videoOverlayTracks'
  >
): TranscriptLine[] {
  const transcript = project.transcript ?? []
  if (transcript.length === 0) return []
  const all = placedClips(project as Project)
  const byAsset = new Map<string, PlacedClipRef[]>()
  for (const c of all) {
    const list = byAsset.get(c.assetId)
    if (list) list.push(c)
    else byAsset.set(c.assetId, [c])
  }
  const fileOf = new Map((project.multicam?.files ?? []).map((f) => [f.assetId, f]))
  return transcript
    .map((u) => {
      const f = fileOf.get(u.assetId)
      return lineOf(u, byAsset.get(u.assetId) ?? [], (t) => (f ? toCommon(f, t) : t))
    })
    .sort((a, b) => a.order - b.order)
}

/** 選んだ行の範囲 */
export interface LinesRange {
  /** 外枠(いちばん前から後ろまで) */
  start: number
  end: number
  /** 残っている所の切れ(収録の時刻の順。タイムラインで続く切れはまとめてある) */
  pieces: { start: number; end: number }[]
  /**
   * 選んだ文が本編で続いて並んでいるか。並べ替えた本編では、外枠の間に選んでいない中身が挟まる。
   * そのときは外枠に当てる操作(削除・再編集・ロック)をしない
   */
  contiguous: boolean
}

/**
 * 選んだ行(並びの番号)の、残っている所の範囲。どれも削っていれば null。
 * `foreignBetween(前の切れ, 次の切れ)` は、2 つの切れの間のタイムラインに、その 2 つの間の収録ではない
 * 中身(並べ替えて持ってきた所など)があるかを答える(省略は「無い」)
 */
export function rangeOfLines(
  lines: readonly TranscriptLine[],
  picked: readonly number[],
  foreignBetween: (prev: LineSpan, next: LineSpan) => boolean = () => false
): LinesRange | null {
  const all: LineSpan[] = []
  for (const i of [...new Set(picked)].sort((a, b) => a - b)) {
    const l = lines[i]
    if (l) all.push(...l.spans)
  }
  if (all.length === 0) return null
  const byRec = [...all].sort((a, b) => a.recStart - b.recStart || a.start - b.start)
  const merged: LineSpan[] = []
  let contiguous = true
  for (const sp of byRec) {
    const last = merged[merged.length - 1]
    if (!last) {
      merged.push({ ...sp })
      continue
    }
    if (sp.start < last.end - JOIN_SEC) {
      // 収録では後なのに、タイムラインでは前にある(並べ替え)
      contiguous = false
      merged.push({ ...sp })
      continue
    }
    if (sp.start - last.end <= JOIN_SEC) {
      last.end = Math.max(last.end, sp.end)
      last.recEnd = Math.max(last.recEnd, sp.recEnd)
      continue
    }
    if (foreignBetween(last, sp)) contiguous = false
    merged.push({ ...sp })
  }
  const start = Math.min(...merged.map((m) => m.start))
  const end = Math.max(...merged.map((m) => m.end))
  if (!(end - start > 1e-3)) return null
  return {
    start,
    end,
    pieces: merged.map((m) => ({ start: m.start, end: m.end })),
    contiguous
  }
}

/** タイムラインの時刻を含む(無ければその前で一番近い)行の番号。行が無ければ -1 */
export function lineAtTime(lines: readonly TranscriptLine[], t: number): number {
  let best = -1
  let bestStart = -Infinity
  lines.forEach((l, i) => {
    if (l.start === null || l.end === null) return
    if (t >= l.start && t < l.end) {
      best = i
      bestStart = Infinity
    } else if (bestStart !== Infinity && l.start <= t && l.start > bestStart) {
      best = i
      bestStart = l.start
    }
  })
  return best
}

/**
 * 2 つの切れの間のタイムラインに、その 2 つの間の収録ではない中身(並べ替えて持ってきた所・同期の無い素材)が
 * あるか(確認の画面の範囲が、選んだ文より広がらないようにする。rangeOfLines に渡す)
 */
export function foreignBetweenOf(
  project: Pick<Project, 'clips' | 'assets' | 'multicam'>
): (prev: LineSpan, next: LineSpan) => boolean {
  const timed = buildTimedClips(project as Project)
  const fileOf = new Map((project.multicam?.files ?? []).map((f) => [f.assetId, f]))
  const EPS = 0.05
  return (prev, next) => {
    for (const tc of timed) {
      const a = Math.max(prev.end, tc.start)
      const b = Math.min(next.start, tc.end)
      if (b - a <= EPS) continue
      const f = fileOf.get(tc.clip.assetId)
      if (!f) return true
      const speed = tc.clip.speed || 1
      const ca = toCommon(f, tc.clip.inPoint + (a - tc.start) * speed)
      const cb = toCommon(f, tc.clip.inPoint + (b - tc.start) * speed)
      if (ca < prev.recEnd - EPS || cb > next.recStart + EPS) return true
    }
    return false
  }
}

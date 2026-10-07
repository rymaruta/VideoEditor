import { TURN_RATE } from '../diarize/micTurns'

/**
 * 声の盛り上がり(叫び・大声)の検出(`docs/GAME_AUTO_EDIT_PLAN.md` G1)。
 *
 * 発話ごとに声の大きさ(dB の上位 10%)を測り、**同じ話者の前後の発話の大きさ(中央値)**から
 * どれだけ上がったかで決める。マイクの距離・入力の大きさは人ごと・回ごとに違うので、
 * 決まった dB で切ると、声の大きい人はずっと「叫んで」いて、小さい人は一度も叫ばない。
 * 発話(文字起こしの区間)の中だけを見るので、声の無い所のゲームの爆発音は数えない。
 */

export interface HypeLine {
  start: number
  end: number
  /** 話者(マイク)。同じ話者の発話どうしで比べる */
  speaker?: string
}

export interface HypeMoment {
  start: number
  end: number
  /** 普段の声からの上がり幅(dB)。まとめた中で一番大きいもの */
  riseDb: number
}

export interface HypeOptions {
  /** これだけ上がったら盛り上がり(dB) */
  riseDb?: number
  /** 普段の声を測る前後の幅(秒) */
  baselineSec?: number
  /** 普段の声を測るのに要る発話の数(足りなければ、その話者の全部の発話で測る) */
  minBaselineLines?: number
  /** これより近い盛り上がりは1回にまとめる(秒) */
  mergeGapSec?: number
}

/** 区間の声の大きさ(dB の上位 10%)。測れない(録っていない・短すぎる)なら null */
export function lineLoudness(levelDb: Float32Array, start: number, end: number): number | null {
  const a = Math.max(0, Math.floor(start * TURN_RATE))
  const b = Math.min(levelDb.length, Math.ceil(end * TURN_RATE))
  const values: number[] = []
  for (let i = a; i < b; i++) {
    const v = levelDb[i]
    if (Number.isFinite(v)) values.push(v)
  }
  if (values.length < 10) return null
  values.sort((x, y) => x - y)
  return values[Math.floor(values.length * 0.9)]
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 盛り上がった所(時刻順)。`levelOf` は発話の声を測る音の大きさ(dB、100Hz、共通の時間軸)。
 * ピンマイクがあればその人のマイク、無ければ基準カメラの音を渡す
 */
export function detectHype(
  lines: readonly HypeLine[],
  levelOf: (line: HypeLine) => Float32Array | undefined,
  options: HypeOptions = {}
): HypeMoment[] {
  const rise = options.riseDb ?? 6
  const around = options.baselineSec ?? 60
  const minLines = options.minBaselineLines ?? 4
  const mergeGap = options.mergeGapSec ?? 2

  const measured = lines
    .map((l) => {
      const level = levelOf(l)
      const loud = level ? lineLoudness(level, l.start, l.end) : null
      return loud === null ? null : { line: l, loud, key: l.speaker ?? '' }
    })
    .filter((x): x is { line: HypeLine; loud: number; key: string } => x !== null)

  const bySpeaker = new Map<string, typeof measured>()
  for (const m of measured) {
    const list = bySpeaker.get(m.key) ?? []
    list.push(m)
    bySpeaker.set(m.key, list)
  }

  const hits: HypeMoment[] = []
  for (const list of bySpeaker.values()) {
    if (list.length < 2) continue
    for (const m of list) {
      const center = (m.line.start + m.line.end) / 2
      const near = list.filter(
        (o) => o !== m && Math.abs((o.line.start + o.line.end) / 2 - center) <= around
      )
      const pool = near.length >= minLines ? near : list.filter((o) => o !== m)
      const base = median(pool.map((o) => o.loud))
      const up = m.loud - base
      if (up >= rise) hits.push({ start: m.line.start, end: m.line.end, riseDb: up })
    }
  }

  hits.sort((a, b) => a.start - b.start)
  const merged: HypeMoment[] = []
  for (const h of hits) {
    const last = merged[merged.length - 1]
    if (last && h.start - last.end <= mergeGap) {
      last.end = Math.max(last.end, h.end)
      last.riseDb = Math.max(last.riseDb, h.riseDb)
    } else merged.push({ ...h })
  }
  return merged
}

/** 区間(共通の時刻)の中の盛り上がりの数(中ほどが区間に入るもの) */
export function countHype(moments: readonly HypeMoment[], start: number, end: number): number {
  return moments.filter((m) => {
    const c = (m.start + m.end) / 2
    return c >= start && c < end
  }).length
}

/** 山(叫び・笑い)と、その前後に残す長さ(秒) */
export interface PeakSpan {
  start: number
  end: number
  /** 前に残す長さ(何が起きたかが分かるように) */
  lead: number
  /** 後に残す長さ(反応・ツッコミが入るように) */
  tail: number
}

/** 叫び・大声の山: 前 12 秒(何が起きたか)・後 8 秒(反応) */
export const HYPE_LEAD_SEC = 12
export const HYPE_TAIL_SEC = 8

/**
 * 「面白い所だけ」のときに場面の中で残す区間: 山の前後だけ。山が無ければ null(場面を丸ごと)。
 * 区間の端が発話の途中に掛かるなら、その発話を丸ごと入れる(言葉の途中から始めない)。
 * 近い区間(2 秒未満の切れ目)はつなぐ
 */
/** 区間の端を発話の切れ目へ広げる上限(秒)。これより長い発話は、端で切る */
export const WIDEN_MAX_SEC = 15

/**
 * 区間の端が発話の途中なら、発話を丸ごと入れる。
 * 見るのは**元の端にまたがる発話だけ**(広げた先からさらに広げない)。掛け合いで発話が切れ目なく
 * 重なり続けると、広げた先がまた次の発話の途中になり、区間が会話の端から端まで広がってしまう。
 * またがる発話のうち一番外まで広げる(並び順によらない)。上限(`WIDEN_MAX_SEC`)を超えるなら広げない
 */
export function widenToLines(
  start: number,
  end: number,
  lines: readonly { start: number; end: number }[]
): [number, number] {
  let a = start
  let b = end
  for (const l of lines) {
    if (l.start < start && l.end > start && start - l.start <= WIDEN_MAX_SEC)
      a = Math.min(a, l.start)
    if (l.start < end && l.end > end && l.end - end <= WIDEN_MAX_SEC) b = Math.max(b, l.end)
  }
  return [a, b]
}

export function peakWindows(
  scene: { start: number; end: number },
  peaks: readonly PeakSpan[],
  lines: readonly { start: number; end: number }[]
): { start: number; end: number }[] | null {
  const inside = peaks.filter((p) => {
    const c = (p.start + p.end) / 2
    return c >= scene.start && c < scene.end
  })
  if (inside.length === 0) return null
  const clamp = (t: number): number => Math.max(scene.start, Math.min(scene.end, t))
  const windows = inside
    .map((p) => {
      const [a, b] = widenToLines(clamp(p.start - p.lead), clamp(p.end + p.tail), lines)
      return { start: clamp(a), end: clamp(b) }
    })
    .sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const w of windows) {
    const last = merged[merged.length - 1]
    if (last && w.start - last.end < 2) last.end = Math.max(last.end, w.end)
    else merged.push({ ...w })
  }
  return merged
}

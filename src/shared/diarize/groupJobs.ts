import type { AsrJob, AsrWord } from '../transcript'

/**
 * 文字起こしの速さのため、同じマイクで続く発話を1つの区間にまとめて認識する(計画書 §5.3)。
 *
 * whisper は 30 秒の窓ごとに音を読むので、3 秒の発話でも 30 秒ぶんの計算をする。続く発話を 28 秒までの1つの窓に
 * まとめれば、窓の数(=重い計算の回数)が減る。結果は単語ごとの時刻で、元の発話へ振り分ける。
 * 発話の外の単語(ほかの人の声の回り込み・言い間違えの空白)は捨てる。
 */
export const GROUP_WINDOW_SEC = 28
/** 発話の間がこれより空いていたら、まとめない(長い無音を読ませない) */
export const GROUP_MAX_GAP_SEC = 6
/** 単語を発話へ振り分けるときの余裕(秒) */
const ASSIGN_MARGIN = 0.25

export interface GroupedJob extends AsrJob {
  /** まとめた元の発話(1本だけならまとめていない) */
  parts: { id: string; start: number; end: number }[]
}

export function groupAsrJobs(
  jobs: readonly AsrJob[],
  windowSec = GROUP_WINDOW_SEC,
  maxGapSec = GROUP_MAX_GAP_SEC
): GroupedJob[] {
  const sorted = [...jobs].sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)
  const out: GroupedJob[] = []
  for (const j of sorted) {
    const g = out[out.length - 1]
    const fits =
      g &&
      g.path === j.path &&
      j.start - g.end <= maxGapSec &&
      Math.max(g.end, j.end) - g.start <= windowSec &&
      j.start >= g.end - 1e-6
    if (fits) {
      g.end = Math.max(g.end, j.end)
      g.parts.push({ id: j.id, start: j.start, end: j.end })
      g.id = `${g.parts[0].id}+${g.parts.length - 1}`
    } else out.push({ ...j, parts: [{ id: j.id, start: j.start, end: j.end }] })
  }
  return out
}

function joinWords(words: readonly AsrWord[]): string {
  let s = ''
  for (const w of words) {
    // 英数字どうしの間だけ空ける(日本語は詰める)
    if (s && /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(w.text)) s += ' '
    s += w.text
  }
  return s
}

/** まとめて認識した単語(素材の時刻)を、元の発話へ振り分ける */
export function splitGroupWords(
  group: GroupedJob,
  words: readonly AsrWord[]
): { id: string; text: string; words: AsrWord[] }[] {
  const buckets = group.parts.map(() => [] as AsrWord[])
  for (const w of words) {
    const mid = (w.start + w.end) / 2
    let best = -1
    let bestDist = Infinity
    group.parts.forEach((p, i) => {
      const d = mid < p.start ? p.start - mid : mid > p.end ? mid - p.end : 0
      if (d <= ASSIGN_MARGIN && d < bestDist) {
        best = i
        bestDist = d
      }
    })
    if (best >= 0) buckets[best].push(w)
  }
  return group.parts.map((p, i) => ({ id: p.id, text: joinWords(buckets[i]), words: buckets[i] }))
}

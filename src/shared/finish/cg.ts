import type { KitFile } from './sound'

/**
 * 版面CG の自動配置(計画書 §5.9)。番組素材フォルダの `CG/<きっかけの言葉>/` の素材を、
 * その言葉を含むテロップ(発言・演出)が出た瞬間に、画面全体へ重ねる。
 *
 * - 長い言葉を先に見る(「うまい!」と「うま」が両方あれば「うまい!」)
 * - 1文字の言葉は誤爆が多いので使わない
 * - CG どうしは重ねない(前の CG が終わるまで次は置かない)
 * - 長い素材は最長 8 秒で切る
 */
export const CG_MAX_SECONDS = 8
/** 静止画の CG を出しておく秒数 */
export const CG_STILL_SECONDS = 3
const MIN_KEYWORD_CHARS = 2

export interface PlacedCg {
  path: string
  /** タイムラインの秒 */
  startTime: number
  inPoint: number
  outPoint: number
  keyword: string
}

export function planCg(
  telops: readonly { text: string; startTime: number }[],
  cg: Readonly<Record<string, KitFile[]>>
): PlacedCg[] {
  const keywords = Object.keys(cg)
    .filter((k) => [...k].length >= MIN_KEYWORD_CHARS && (cg[k]?.length ?? 0) > 0)
    .sort((a, b) => [...b].length - [...a].length)
  const used = new Map<string, number>()
  const out: PlacedCg[] = []
  let busyUntil = -Infinity
  for (const t of [...telops].sort((a, b) => a.startTime - b.startTime)) {
    if (t.startTime < busyUntil) continue
    const text = t.text.replace(/\s/g, '')
    const keyword = keywords.find((k) => text.includes(k.replace(/\s/g, '')))
    if (!keyword) continue
    const files = cg[keyword]
    const n = used.get(keyword) ?? 0
    used.set(keyword, n + 1)
    const file = files[n % files.length]
    if (!file.still && !(file.duration > 0)) continue
    const len = file.still ? CG_STILL_SECONDS : Math.min(CG_MAX_SECONDS, file.duration)
    out.push({ path: file.path, startTime: t.startTime, inPoint: 0, outPoint: len, keyword })
    busyUntil = t.startTime + len
  }
  return out
}

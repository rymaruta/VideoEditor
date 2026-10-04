import type { TextOverlay } from '../types'
import { layoutTelop, stripTelopMarkup, telopStrokeRings, type TelopContext } from '../telop/render'
import type { DictionaryEntry } from '../telop/polish'
import type { QcIssue } from './types'

/**
 * テロップの自動確認(計画書 §5.12)。書き出しを待たずにプロジェクトから調べられる。
 *
 * - はみ出し: 文字(縁取りを含む)がタイトルセーフ(画面の 90%)の外に出ている
 * - 表示が短い: 文字数に対して出ている時間が短く、読み切れない
 * - 確認する言葉: 利用者が登録した言葉(放送で使わない言葉など)が入っている
 * - 表記: 用語の辞書の「誤」の表記が残っている(手で打った・辞書を後から足した)
 */

/** タイトルセーフ: 上下左右 5% の内側 */
export const TITLE_SAFE_MARGIN = 0.05
/** 縁がわずかに掛かる程度(画面の幅・高さの 0.5%)は知らせない */
const SAFE_TOLERANCE = 0.005
/** 1秒に読める文字数の目安と、最短の表示時間 */
export const READ_CHARS_PER_SEC = 10
export const MIN_DISPLAY_SEC = 0.5

export interface TelopQcOptions {
  bannedWords: readonly string[]
  dictionary: readonly DictionaryEntry[]
}

/** 縁取りを含む、テロップのブロックの外枠(キャンバスに対する割合) */
export function telopBounds(
  ctx: Pick<TelopContext, 'measureText' | 'font'>,
  o: TextOverlay,
  canvas: { w: number; h: number }
): { x: number; y: number; w: number; h: number } {
  const layout = layoutTelop(ctx, o, canvas)
  const rings = telopStrokeRings(o.style)
  const reach = rings.reduce((m, r) => Math.max(m, r.reach), 0)
  const left = layout.anchor.x - layout.blockWidth / 2 - reach
  const top = layout.anchor.y + layout.topFromAnchor - reach
  return {
    x: left / canvas.w,
    y: top / canvas.h,
    w: (layout.blockWidth + reach * 2) / canvas.w,
    h: (layout.blockHeight + reach * 2) / canvas.h
  }
}

function visibleChars(text: string): number {
  return [...text.replace(/\s/g, '')].length
}

export function telopIssues(
  overlays: readonly TextOverlay[],
  ctx: Pick<TelopContext, 'measureText' | 'font'>,
  canvas: { w: number; h: number },
  options: TelopQcOptions
): QcIssue[] {
  const issues: QcIssue[] = []
  const banned = options.bannedWords.map((w) => w.trim()).filter(Boolean)
  const wrong = options.dictionary.filter((d) => d.from && d.from !== d.to)
  for (const o of overlays) {
    // 文字数・言葉の確認は、画面に出る文字で数える(`**強調**` などの印は描かれない)
    const text = stripTelopMarkup(o.text)
    if (!text.trim()) continue
    const base = { start: o.startTime, end: o.endTime, overlayId: o.id }
    const label = text.replace(/\n/g, ' ').slice(0, 20)

    const b = telopBounds(ctx, o, canvas)
    const lo = TITLE_SAFE_MARGIN - SAFE_TOLERANCE
    const hi = 1 - TITLE_SAFE_MARGIN + SAFE_TOLERANCE
    if (!o.style.rotation && (b.x < lo || b.y < lo || b.x + b.w > hi || b.y + b.h > hi))
      issues.push({
        ...base,
        id: `safe-${o.id}`,
        kind: 'telopSafe',
        severity: 'error',
        message: `「${label}」が画面の端(タイトルセーフ)からはみ出しています`
      })

    const chars = visibleChars(text)
    const need = Math.max(MIN_DISPLAY_SEC, chars / READ_CHARS_PER_SEC)
    const shown = o.endTime - o.startTime
    if (shown < need)
      issues.push({
        ...base,
        id: `fast-${o.id}`,
        kind: 'telopFast',
        severity: 'warn',
        message: `「${label}」は ${chars} 文字を ${shown.toFixed(1)} 秒しか出していません(読み切れない恐れ)`
      })

    const hit = banned.filter((w) => text.includes(w))
    if (hit.length > 0)
      issues.push({
        ...base,
        id: `word-${o.id}`,
        kind: 'telopWord',
        severity: 'error',
        message: `「${label}」に確認する言葉「${hit.join('」「')}」が入っています`
      })

    // 正しい表記が誤の表記を含む(誤「ジョウド」→ 正「ジョウドガハマ」など)ときは、正しく書けていれば知らせない
    const left = wrong.filter((d) => text.split(d.to).join('').includes(d.from))
    if (left.length > 0)
      issues.push({
        ...base,
        id: `dict-${o.id}`,
        kind: 'telopDictionary',
        severity: 'warn',
        message: `「${label}」に辞書と違う表記があります(${left.map((d) => `${d.from} → ${d.to}`).join('、')})`
      })
  }
  return issues
}

/** 時刻の順。同じ時刻なら直すべきもの(error)を先に */
export function sortIssues(issues: readonly QcIssue[]): QcIssue[] {
  return [...issues].sort(
    (a, b) =>
      a.start - b.start ||
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      a.id.localeCompare(b.id)
  )
}

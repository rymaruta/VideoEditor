/**
 * 話者(出演者)の扱い。テロップ一覧の色分けと、話者の候補の出し方を、
 * 画面のどこから見ても同じにするための置き場。
 */

/** 話者ごとの色。番組のテロップでよく使う、暗い背景でも見分けやすい色を順に使う */
const SPEAKER_PALETTE = [
  '#c8156a',
  '#2f6fe0',
  '#3a8a52',
  '#e6a23c',
  '#8e44ad',
  '#16a2b8',
  '#d35400',
  '#7f8c8d'
] as const

/** 話者が無いテロップの色 */
export const NO_SPEAKER_COLOR = '#555555'

/**
 * 話者名から色を決める。**名前だけで決まる**(並び順や件数で色が変わると、
 * テロップを足すたびに色が入れ替わって見分けの役に立たない)。
 */
export function speakerColor(speaker: string | undefined): string {
  const name = speaker?.trim()
  if (!name) return NO_SPEAKER_COLOR
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return SPEAKER_PALETTE[h % SPEAKER_PALETTE.length]
}

/** 企画の中に出てくる話者の一覧(多い順、同数なら名前順)。入力欄の候補に使う */
export function listSpeakers(overlays: readonly { speaker?: string }[]): string[] {
  const counts = new Map<string, number>()
  for (const o of overlays) {
    const name = o.speaker?.trim()
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
    .map(([name]) => name)
}

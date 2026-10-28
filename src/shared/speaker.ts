/**
 * 話者(出演者)の扱い。テロップ一覧の色分けと、話者の候補の出し方を、
 * 画面のどこから見ても同じにするための置き場。
 */

/**
 * 話者ごとの色(8 色)。暗い地で見分けやすく、画面の意味の色(注意の琥珀 #e5b84f・AI の紫 #a493d9・
 * 差し色の青 #4d8fe6)とテロップのクリップの色(#b0588a)に近い色は使わない(印の意味と取り違えない)
 */
export const SPEAKER_PALETTE = [
  '#5cc1b3',
  '#e08a9a',
  '#6cc3d5',
  '#8fd16a',
  '#d9785f',
  '#b9c25a',
  '#d6d6d6',
  '#7aa88e'
] as const

/** 話者が無いテロップの色(灰) */
export const NO_SPEAKER_COLOR = '#8c8c8c'

/**
 * 話者名から色を決める。**名前だけで決まる**(並び順や件数で色が変わると、
 * テロップを足すたびに色が入れ替わって見分けの役に立たない)。
 */
export function speakerColor(speaker: string | undefined): string {
  const i = speakerIndex(speaker)
  return i === null ? NO_SPEAKER_COLOR : SPEAKER_PALETTE[i]
}

/**
 * 話者名の色の番号(0〜7。`SPEAKER_PALETTE` と画面の `--ve-speaker-*` の番号)。話者が無ければ null。
 * `speakerColor` と同じく名前だけで決まる
 */
export function speakerIndex(speaker: string | undefined): number | null {
  const name = speaker?.trim()
  if (!name) return null
  let h = 0
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return h % SPEAKER_PALETTE.length
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

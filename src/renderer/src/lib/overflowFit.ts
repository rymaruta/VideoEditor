/**
 * 1 行の帯に並べる操作を、帯の幅に合わせて選ぶ(入らない物は「その他 ▾」へ)。
 * 帯は折り返さず、切り落とさない(切り落とすと右端のコピー・複製・削除に届かなくなった)。
 *
 * 決めた順に 1 つずつ回していき、入った所で止める。順の中の `COMPACT` は「選択の欄を詰める」段。
 * 「その他」のボタンは、1 つでも回すときは必ず場所を取る(最優先)。
 */

/** 回す順の中で「選択の欄を詰める」段 */
export const COMPACT = '@compact'

export interface FitElement {
  id: string
  /** 普段の幅 */
  width: number
  /** 詰めたときの幅(選択の欄だけ) */
  narrowWidth?: number
}

export interface FitInput {
  /** 帯の中で使える幅 */
  available: number
  /** 回さない物(題名・拡大縮小・道具 など)が使う幅(間を含む) */
  fixed: number
  /** 回せる物(並びの順) */
  elements: readonly FitElement[]
  /** 回す順(先に回す物から。COMPACT を含めてよい) */
  removal: readonly string[]
  /** 並べた物の間 */
  gap: number
  /** 「その他 ▾」のボタンの幅 */
  moreWidth: number
}

export interface FitResult {
  /** 「その他」へ回す物の id */
  hidden: string[]
  /** 選択の欄を詰めるか */
  compact: boolean
}

/** その並べ方の幅 */
export function rowWidth(input: FitInput, hidden: ReadonlySet<string>, compact: boolean): number {
  const shown = input.elements.filter((e) => !hidden.has(e.id))
  const items = shown.reduce(
    (t, e) => t + (compact ? (e.narrowWidth ?? e.width) : e.width) + input.gap,
    0
  )
  return input.fixed + items + (hidden.size > 0 ? input.moreWidth + input.gap : 0)
}

export function fitByLevels(input: FitInput): FitResult {
  const present = new Set(input.elements.map((e) => e.id))
  const steps = input.removal.filter((id) => id === COMPACT || present.has(id))
  for (let level = 0; level <= steps.length; level++) {
    const done = steps.slice(0, level)
    const hidden = new Set(done.filter((id) => id !== COMPACT))
    const compact = done.includes(COMPACT)
    if (rowWidth(input, hidden, compact) <= input.available) return { hidden: [...hidden], compact }
  }
  return { hidden: steps.filter((id) => id !== COMPACT), compact: steps.includes(COMPACT) }
}

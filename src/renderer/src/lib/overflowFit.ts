/**
 * 1 行の帯に、後ろへ回せる操作をいくつ並べられるか(残りは「その他 ▾」へ)。
 * 帯は折り返さず、切り落とさない(切り落とすと右端のコピー・複製・削除に届かなくなった)。
 *
 * - available: 帯の中で使える幅
 * - fixed: 回せない物(題名・拡大縮小・道具・右端のコピー・複製・削除など)が使う幅(間を含む)
 * - items: 回せる操作の幅(並べる順)
 * - gap: 並べた物の間
 * - moreWidth: 「その他 ▾」のボタンの幅(1 つでも回すときだけ要る)
 *
 * 前から順に、入るだけ並べる。全部入らないときは「その他」の分も空ける。
 */
export function itemsThatFit(
  available: number,
  fixed: number,
  items: readonly number[],
  gap: number,
  moreWidth: number
): number {
  const total = (n: number): number => items.slice(0, n).reduce((t, w) => t + w + gap, 0)
  if (fixed + total(items.length) <= available) return items.length
  const room = available - fixed - (moreWidth + gap)
  let n = 0
  while (n < items.length && total(n + 1) <= room) n++
  return n
}

/**
 * 今の帯の幅から、回せない物の幅を出す(今並べている回せる物と「その他」の分を引く)。
 * contentWidth は帯の中身の幅(scrollWidth から左右の余白を引いたもの)
 */
export function fixedWidthOf(
  contentWidth: number,
  shownItems: readonly number[],
  gap: number,
  moreShown: boolean,
  moreWidth: number
): number {
  const shown = shownItems.reduce((t, w) => t + w + gap, 0)
  return Math.max(0, contentWidth - shown - (moreShown ? moreWidth + gap : 0))
}

/**
 * 帯の並べ方を決める。回せる操作を前から入るだけ並べ、残りは「その他」へ。全部回しても入らない
 * ときだけ、選択の欄を詰める(compact)。contentWidth は詰めていない(普段の)幅で数えた中身の幅
 */
export function fitToolbar(input: {
  available: number
  contentWidth: number
  shownNow: number
  items: readonly number[]
  gap: number
  moreWidth: number
  /** 欄を詰めたら減る幅 */
  compactSaving: number
}): { shown: number; compact: boolean } {
  const { available, contentWidth, shownNow, items, gap, moreWidth, compactSaving } = input
  const now = Math.min(shownNow, items.length)
  const fixed = fixedWidthOf(contentWidth, items.slice(0, now), gap, now < items.length, moreWidth)
  const shown = itemsThatFit(available, fixed, items, gap, moreWidth)
  if (shown > 0) return { shown, compact: false }
  const withMore = fixed + (items.length > 0 ? moreWidth + gap : 0)
  if (withMore <= available) return { shown, compact: false }
  // 欄を詰めると入るなら、詰めた上で並べ直す
  const compactFixed = fixed - compactSaving
  return { shown: itemsThatFit(available, compactFixed, items, gap, moreWidth), compact: true }
}

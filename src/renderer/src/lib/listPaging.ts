/**
 * 長い一覧を何件ずつ見せるか(ページ送り)。
 *
 * テロップの一覧は1件ごとに入力欄を数十個持つので、全部を一度に描くと件数に比例して重くなる
 * (実測: 1,000件で一覧だけで DOM 要素 86,000個、企画を開くのに 10〜30秒)。
 * 1ページぶんだけ描けば、件数によらず一定の重さで済む。
 */
export const OVERLAY_PAGE_SIZE = 50

export function pageCount(total: number, pageSize: number = OVERLAY_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1
  return Math.ceil(total / Math.max(1, pageSize))
}

/** 範囲外のページ番号を、存在するページへ戻す */
export function clampPage(
  page: number,
  total: number,
  pageSize: number = OVERLAY_PAGE_SIZE
): number {
  const last = pageCount(total, pageSize) - 1
  if (!Number.isFinite(page)) return 0
  return Math.min(last, Math.max(0, Math.floor(page)))
}

/** そのページに入る [始まり, 終わり) の添字 */
export function pageSlice(
  page: number,
  total: number,
  pageSize: number = OVERLAY_PAGE_SIZE
): { start: number; end: number } {
  const p = clampPage(page, total, pageSize)
  const start = p * pageSize
  return { start, end: Math.min(Math.max(0, total), start + pageSize) }
}

/**
 * 再生位置のテロップが載っているページ。再生位置に出ているものが無ければ、
 * その後で最初に出るもの、それも無ければ最後のページ。
 */
export function pageForTime(
  items: readonly { startTime: number; endTime: number }[],
  time: number,
  pageSize: number = OVERLAY_PAGE_SIZE
): number {
  if (items.length === 0) return 0
  let index = items.findIndex((o) => time >= o.startTime && time < o.endTime)
  if (index < 0) {
    let best = -1
    items.forEach((o, i) => {
      if (o.startTime >= time && (best < 0 || o.startTime < items[best].startTime)) best = i
    })
    index = best >= 0 ? best : items.length - 1
  }
  return Math.floor(index / pageSize)
}

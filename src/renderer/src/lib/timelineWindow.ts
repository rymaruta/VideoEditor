import { useEffect, useState, type RefObject } from 'react'

/**
 * タイムラインのうち、**いま見えている範囲(秒)**。長尺の企画で、見えないクリップを描かないために使う。
 *
 * クリップ・テロップ・音声はどれも `left = 秒 × 1秒あたりの画素` で絶対配置しており、
 * レーンの幅も尺から決めている(中身の数で幅が変わらない)。だから見えていないものを
 * 描かなくても、位置もスクロールの幅も変わらない。
 * (実測: 3,000クリップ・テロップ1,000本・60分の企画で、全部を描くとズーム1回の反映に
 *  300〜480ms かかっていた)
 *
 * 左右に1画面ぶんずつ余分に描いておく(スクロールした瞬間に空白が見えないように)。
 */
export function visibleWindowSeconds(
  scrollLeft: number,
  clientWidth: number,
  pixelsPerSecond: number,
  overscanPx: number = clientWidth
): { from: number; to: number } {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
    return { from: -Infinity, to: Infinity }
  }
  // 幅がまだ測れていない(描く前)ときは全部描く。見えているのに描かれない、を避ける
  if (!Number.isFinite(clientWidth) || clientWidth <= 0) return { from: -Infinity, to: Infinity }
  const left = Math.max(0, Number.isFinite(scrollLeft) ? scrollLeft : 0)
  const pad = Math.max(0, Number.isFinite(overscanPx) ? overscanPx : 0)
  return {
    from: (left - pad) / pixelsPerSecond,
    to: (left + clientWidth + pad) / pixelsPerSecond
  }
}

/** [start, end] が見えている範囲に掛かるか */
export function inWindow(
  window: { from: number; to: number },
  start: number,
  end: number
): boolean {
  return end >= window.from && start <= window.to
}

/**
 * 操作中・選択中のものは見えていなくても描く(つかんだまま画面外へ出たものを消すと、
 * ドラッグの途中で要素が無くなり操作が切れる)。状態の形はさまざまなので、
 * 中に入っている文字列(ID)を全部拾う。余分に拾っても描く数が少し増えるだけ。
 */
export function pinnedIds(states: readonly unknown[]): Set<string> {
  const out = new Set<string>()
  const visit = (v: unknown, depth: number): void => {
    if (typeof v === 'string') out.add(v)
    else if (Array.isArray(v) && depth < 2) v.forEach((x) => visit(x, depth + 1))
    else if (v && typeof v === 'object' && depth < 2)
      Object.values(v).forEach((x) => visit(x, depth + 1))
  }
  states.forEach((s) => visit(s, 0))
  return out
}

/** スクロールとリサイズに追従して、見えている範囲を返す(1フレームに1回だけ更新) */
export function useVisibleWindow(
  ref: RefObject<HTMLElement | null>,
  pixelsPerSecond: number
): { from: number; to: number } {
  const [box, setBox] = useState({ scrollLeft: 0, clientWidth: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    const read = (): void => {
      raf = 0
      setBox((prev) =>
        prev.scrollLeft === el.scrollLeft && prev.clientWidth === el.clientWidth
          ? prev
          : { scrollLeft: el.scrollLeft, clientWidth: el.clientWidth }
      )
    }
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(read)
    }
    read()
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ref])
  return visibleWindowSeconds(box.scrollLeft, box.clientWidth, pixelsPerSecond)
}

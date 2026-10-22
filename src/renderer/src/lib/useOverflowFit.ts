import { useLayoutEffect, useState } from 'react'
import { fitToolbar } from './overflowFit'

/**
 * 1 行の帯(`containerRef`)に、後ろへ回せる操作をいくつ並べられるかを測る(残りは「その他 ▾」)。
 * 回せる操作を全部回しても入らないときは、選択の欄を詰めた幅にする(compact)。
 *
 * 測り方:
 * - 帯に並べている回せる操作には `data-fit-shown` を付ける
 * - 見えない測り用の写し(`measureRef`)の中に、回せる操作(`[data-fit-item]`)・「その他」のボタン
 *   (`[data-fit-more]`)・詰められる欄の普段の幅(`[data-fit-natural="名前"]`)と詰めた幅
 *   (`[data-fit-narrow="名前"]`)を置く
 * - 帯の中の詰められる欄には `data-fit-compact="名前"` を付ける
 * - 帯の直下の物は縮めない(flex-shrink: 0)。直下の物の幅の合計を中身の幅とする
 * 帯の大きさ・中身が変わるたびに測り直す(ResizeObserver と key)。
 */
export function useOverflowFit(
  containerRef: React.RefObject<HTMLElement | null>,
  measureRef: React.RefObject<HTMLElement | null>,
  itemCount: number,
  /** 回せる操作の間(px) */
  gap: number,
  /** これが変わったら測り直す(選んだクリップ・操作の並びなど) */
  key: string
): { shown: number; compact: boolean } {
  const [state, setState] = useState({ shown: itemCount, compact: false })

  useLayoutEffect(() => {
    const c = containerRef.current
    if (!c) return
    const width = (e: Element): number => e.getBoundingClientRect().width
    const byName = (m: HTMLElement, attr: string): Map<string, number> =>
      new Map(
        [...m.querySelectorAll<HTMLElement>(`[data-fit-${attr}]`)].map((e) => [
          e.getAttribute(`data-fit-${attr}`) ?? '',
          width(e)
        ])
      )
    const run = (): void => {
      const m = measureRef.current
      if (!m) return
      const items = [...m.querySelectorAll('[data-fit-item]')].map(width)
      const more = [...m.querySelectorAll('[data-fit-more]')].map(width)[0] ?? 0
      const natural = byName(m, 'natural')
      const narrow = byName(m, 'narrow')
      const fields = [...c.querySelectorAll<HTMLElement>('[data-fit-compact]')].map((e) => ({
        name: e.dataset.fitCompact ?? '',
        now: width(e)
      }))
      const cs = getComputedStyle(c)
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      const colGap = parseFloat(cs.columnGap) || 0
      const kids = [...c.children].filter(
        (k) => k !== m && getComputedStyle(k).position !== 'absolute'
      )
      const content =
        kids.reduce((t, k) => {
          const s = getComputedStyle(k)
          return t + width(k) + parseFloat(s.marginLeft) + parseFloat(s.marginRight)
        }, 0) +
        colGap * Math.max(0, kids.length - 1)
      const next = fitToolbar({
        available: c.clientWidth - pad,
        // 詰めている欄は普段の幅に戻して数える
        contentWidth:
          content +
          fields.reduce((t, f) => t + Math.max(0, (natural.get(f.name) ?? f.now) - f.now), 0),
        shownNow: Math.min(c.querySelectorAll('[data-fit-shown]').length, items.length),
        items,
        gap,
        moreWidth: more,
        compactSaving: fields.reduce(
          (t, f) => t + Math.max(0, (natural.get(f.name) ?? f.now) - (narrow.get(f.name) ?? f.now)),
          0
        )
      })
      setState((prev) => (prev.shown === next.shown && prev.compact === next.compact ? prev : next))
    }
    run()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => run())
    ro.observe(c)
    return () => ro.disconnect()
  }, [containerRef, measureRef, itemCount, gap, key])

  return { shown: Math.min(state.shown, itemCount), compact: state.compact }
}

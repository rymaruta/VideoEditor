import { useLayoutEffect, useState } from 'react'
import { fitByLevels, type FitResult } from './overflowFit'

/**
 * 1 行の帯(`containerRef`)に並べる操作を、帯の幅を測って選ぶ(入らない物は「その他 ▾」へ)。
 *
 * 測り方:
 * - 帯の中で、回せる物を並べる行(`[data-fit-row]`)と、それ以外(題名・拡大縮小など。回さない)
 * - 見えない測り用の写し(`measureRef`)の中に、回せる物の普段の幅(`[data-fit-id="名前"]`)・詰めた幅
 *   (`[data-fit-narrow-id="名前"]`)・「その他」のボタン(`[data-fit-more]`)を置く
 * - 帯の直下の物は縮めない(flex-shrink: 0)。右へ寄せる物は `data-fit-push`(左の auto の余白を数えない)
 * 帯の大きさ・中身が変わるたびに測り直す(ResizeObserver と key)。
 */
export function useOverflowFit(
  containerRef: React.RefObject<HTMLElement | null>,
  measureRef: React.RefObject<HTMLElement | null>,
  /** 回す順(先に回す物から。COMPACT を含めてよい) */
  removal: readonly string[],
  /** 並べた物の間(px) */
  gap: number,
  /** これが変わったら測り直す(選んだクリップ・操作の並びなど) */
  key: string
): FitResult {
  const [state, setState] = useState<FitResult>({ hidden: [], compact: false })
  const removalKey = removal.join(',')

  useLayoutEffect(() => {
    const c = containerRef.current
    if (!c) return
    const width = (e: Element): number => e.getBoundingClientRect().width
    const run = (): void => {
      const m = measureRef.current
      if (!m) return
      const narrow = new Map(
        [...m.querySelectorAll<HTMLElement>('[data-fit-narrow-id]')].map((e) => [
          e.dataset.fitNarrowId ?? '',
          width(e)
        ])
      )
      const elements = [...m.querySelectorAll<HTMLElement>('[data-fit-id]')].map((e) => {
        const id = e.dataset.fitId ?? ''
        const n = narrow.get(id)
        return n === undefined ? { id, width: width(e) } : { id, width: width(e), narrowWidth: n }
      })
      const more = [...m.querySelectorAll('[data-fit-more]')].map(width)[0] ?? 0
      const cs = getComputedStyle(c)
      const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
      const colGap = parseFloat(cs.columnGap) || 0
      const kids = [...c.children].filter((k) => getComputedStyle(k).position !== 'absolute')
      const fixed =
        kids
          .filter((k) => k.getAttribute('data-fit-row') === null)
          .reduce((t, k) => {
            const s = getComputedStyle(k)
            // 右へ寄せる物(margin-left: auto)の左の余白は空きなので数えない
            const left = k.hasAttribute('data-fit-push') ? 0 : parseFloat(s.marginLeft)
            return t + width(k) + left + parseFloat(s.marginRight)
          }, 0) +
        colGap * Math.max(0, kids.length - 1)
      const next = fitByLevels({
        available: c.clientWidth - pad,
        fixed,
        elements,
        removal: removalKey ? removalKey.split(',') : [],
        gap,
        moreWidth: more
      })
      setState((prev) =>
        prev.compact === next.compact && prev.hidden.join(',') === next.hidden.join(',')
          ? prev
          : next
      )
    }
    run()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => run())
    ro.observe(c)
    return () => ro.disconnect()
  }, [containerRef, measureRef, removalKey, gap, key])

  return state
}

/**
 * ダイアログ(`.modal-backdrop`)を開いている間、キーボードの操作をダイアログの中に閉じ込める。
 *
 * ダイアログは画面の上に重ねて描くだけなので、フォーカスは開いたボタン(裏の画面)に残ったまま、
 * Tab で裏の「分割」「削除」へ移れた。Enter で、開いているトリムのダイアログの裏のクリップが
 * 分割・削除されていた。
 * - ダイアログが出たら、フォーカスが外にあれば中の最初の操作できる所へ移す
 * - Tab・Shift+Tab は中で回す
 * - 何かの拍子にフォーカスが外へ出たら、中へ戻す
 * ダイアログから開いた吹き出し(document.body に出す色・候補の一覧・右クリックのメニュー)は外とみなさない
 */
const FOCUSABLE =
  'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), ' +
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
const PORTALS = '.app-popover, .color-popover, .clip-context-menu, [role="menu"]'

function topModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('.modal-backdrop')
  return all.length > 0 ? all[all.length - 1] : null
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

function allowed(modal: HTMLElement, el: Element | null): boolean {
  return !el || el === document.body || modal.contains(el) || Boolean(el.closest(PORTALS))
}

function focusInto(modal: HTMLElement): void {
  const first = focusables(modal)[0]
  if (first) first.focus({ preventScroll: true })
  else {
    if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1')
    modal.focus({ preventScroll: true })
  }
}

export function installModalFocusTrap(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return
    const modal = topModal()
    if (!modal) return
    const active = document.activeElement
    if (active && active.closest(PORTALS) && !modal.contains(active)) return
    const list = focusables(modal)
    if (list.length === 0) {
      e.preventDefault()
      return
    }
    const i = active instanceof HTMLElement ? list.indexOf(active) : -1
    const next = e.shiftKey
      ? i <= 0
        ? list[list.length - 1]
        : list[i - 1]
      : i < 0 || i === list.length - 1
        ? list[0]
        : list[i + 1]
    e.preventDefault()
    next.focus()
  }
  const onFocusIn = (e: FocusEvent): void => {
    const modal = topModal()
    if (!modal || allowed(modal, e.target as Element | null)) return
    focusInto(modal)
  }
  let lastModal: HTMLElement | null = null
  const observer = new MutationObserver(() => {
    const modal = topModal()
    if (modal && modal !== lastModal && !allowed(modal, document.activeElement)) focusInto(modal)
    lastModal = modal
  })
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('keydown', onKey, true)
  document.addEventListener('focusin', onFocusIn)
  return () => {
    observer.disconnect()
    window.removeEventListener('keydown', onKey, true)
    document.removeEventListener('focusin', onFocusIn)
  }
}

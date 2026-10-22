import { useEffect, useState } from 'react'
import { isModalOpen } from './useKeyboardShortcuts'

/**
 * ダイアログ(`.modal-backdrop`)が開いているか。開け閉めを見張って描き直す
 * (上の帯をダイアログの間だけ inert にし、Tab で裏のボタンに届かないようにするため)
 */
export function useModalOpen(): boolean {
  const [open, setOpen] = useState(() => isModalOpen())
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const update = (): void => setOpen(isModalOpen())
    // ダイアログは body の直下か、その近くに足される。子の出入りだけを見る(属性・文字は見ない)
    const mo = new MutationObserver(update)
    mo.observe(document.body, { childList: true, subtree: true })
    update()
    return () => mo.disconnect()
  }, [])
  return open
}

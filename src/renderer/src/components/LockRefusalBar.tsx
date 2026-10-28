import { useEffect } from 'react'
import { useProjectStore } from '../store/projectStore'
import { XIcon } from './icons'
import { lockRefusalMessage } from '../lib/trackLock'

/** 帯を出しておく時間(ミリ秒)。同じ断りが続いたら出し直す */
const SHOW_MS = 6000

/**
 * ストアがトラックの固定を理由に書き込みを断ったら、画面の下に帯で知らせる。
 * どの経路(メニューバー・ナレーション・自動の仕上げ…)から来ても、黙って何も起きないことにしない
 */
export function LockRefusalBar(): React.JSX.Element | null {
  const refusal = useProjectStore((s) => s.lockRefusal)
  const dismiss = useProjectStore((s) => s.dismissLockRefusal)
  const count = refusal?.count ?? 0
  useEffect(() => {
    if (count === 0) return
    const id = window.setTimeout(() => useProjectStore.getState().dismissLockRefusal(), SHOW_MS)
    return () => window.clearTimeout(id)
  }, [count])
  if (!refusal) return null
  return (
    <div className="ve-lock-refusal" role="status" aria-live="polite">
      <span>{lockRefusalMessage(refusal)}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="知らせを閉じる"
        title="閉じる"
        onClick={dismiss}
      >
        <XIcon width={12} height={12} />
      </button>
    </div>
  )
}

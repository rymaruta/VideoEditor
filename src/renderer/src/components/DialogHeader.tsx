import { XIcon } from './icons'

/**
 * ダイアログの見出しの帯(1 つの部品)。見出し 48px・文字 16/600・閉じるはアイコンのボタン 28px。
 * 枠・中・足の見た目は dialogsG3.css(.dialog-titlebar / .modal の中の帯と .modal-actions も同じ見た目に
 * そろえてある)。閉じるの「×」は文字でなく線のアイコン。
 */
export function DialogHeader({
  title,
  onClose,
  closeTitle = '閉じる',
  closeDisabled = false
}: {
  title: React.ReactNode
  onClose: () => void
  /** 閉じるボタンの吹き出し(書き出し中は「閉じても書き出しは続きます」など) */
  closeTitle?: string
  /** 閉じられない間(作っている途中など。外を押しても閉じないのと同じ) */
  closeDisabled?: boolean
}): React.JSX.Element {
  return (
    <div className="dialog-titlebar">
      <span className="dialog-title">{title}</span>
      <button
        type="button"
        className="dialog-close"
        aria-label="閉じる"
        title={closeTitle}
        disabled={closeDisabled}
        onClick={onClose}
      >
        <XIcon width={16} height={16} />
      </button>
    </div>
  )
}

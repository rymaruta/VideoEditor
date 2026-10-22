/**
 * ダイアログの見出しの帯(1 つの部品)。見出し 48px・文字 16/600・閉じるはアイコンのボタン 28px。
 * 枠・中・足の見た目は dialogsG3.css(.dialog-titlebar / .modal の h3 と .modal-actions も同じ見た目に
 * そろえてある)。閉じるの「×」は文字でなく線のアイコン。
 */
export function DialogHeader({
  title,
  onClose,
  closeTitle = '閉じる'
}: {
  title: React.ReactNode
  onClose: () => void
  /** 閉じるボタンの吹き出し(書き出し中は「閉じても書き出しは続きます」など) */
  closeTitle?: string
}): React.JSX.Element {
  return (
    <div className="dialog-titlebar">
      <span className="dialog-title">{title}</span>
      <button
        type="button"
        className="dialog-close"
        aria-label="閉じる"
        title={closeTitle}
        onClick={onClose}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6 6 18" vectorEffect="non-scaling-stroke" />
        </svg>
      </button>
    </div>
  )
}

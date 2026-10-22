import { useEffect, useRef } from 'react'
import { useSettingsStore } from '../store/settingsStore'
import { useEscapeToClose } from '../lib/useEscapeToClose'
import {
  getEditorKeymap,
  isMacPlatform,
  KEYMAP_SCHEME_LABELS,
  matchesEditorBinding
} from '../lib/keymap'
import { shortcutHelpSections, useShortcutHelpStore } from '../lib/shortcutHelp'
import '../assets/shortcutHelp.css'

/**
 * キー操作の一覧(? / Ctrl+/ で開け閉め、Esc・背景で閉じる)。今のキー配置の分だけを出す。
 * 開いている間は `.modal-backdrop` があるので、編集のキーは裏のタイムラインへ届かない
 */
export function ShortcutHelpDialog(): React.JSX.Element | null {
  const open = useShortcutHelpStore((s) => s.open)
  const setOpen = useShortcutHelpStore((s) => s.setOpen)
  const scheme = useSettingsStore((s) => s.keymapScheme)
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeToClose(backdropRef, () => setOpen(false), open)

  // 開いている間は編集のキーの処理が止まるので、閉じるキー(? / Ctrl+/)はここで受ける
  useEffect(() => {
    if (!open) return
    const bindings = getEditorKeymap(scheme).shortcutHelp
    const onKey = (e: KeyboardEvent): void => {
      if (!bindings.some((b) => matchesEditorBinding(e, b))) return
      const all = document.querySelectorAll('.modal-backdrop')
      if (all[all.length - 1] !== backdropRef.current) return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, scheme, setOpen])

  if (!open) return null
  const mac = isMacPlatform()
  const sections = shortcutHelpSections(scheme, mac)

  return (
    <div className="modal-backdrop" ref={backdropRef} onClick={() => setOpen(false)}>
      <div
        className="modal shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcut-help-head">
          <h3 id="shortcut-help-title">キー操作</h3>
          <span className="shortcut-help-scheme">{KEYMAP_SCHEME_LABELS[scheme]}</span>
          <button
            className="icon-button shortcut-help-close"
            aria-label="閉じる"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        <div className="shortcut-help-grid">
          {sections.map((section) => (
            <section key={section.title} className="shortcut-help-section">
              <h4>{section.title}</h4>
              <dl>
                {section.rows.map((row) => (
                  <div key={row.label} className="shortcut-help-row">
                    <dt>{row.label}</dt>
                    <dd>
                      {row.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span className="shortcut-help-or">/</span>}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="hint-text shortcut-help-note">
          文字を打つ欄・ダイアログの上では効きません。戻る方向の送りと
          2倍・4倍は、再生位置を送って画だけを見せます(音は出ません)。
          {mac ? ' ⌘ は Command、⌥ は Option、⇧ は Shift。' : ''}
        </p>
      </div>
    </div>
  )
}

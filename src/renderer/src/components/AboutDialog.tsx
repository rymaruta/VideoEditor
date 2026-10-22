import { useEffect, useState } from 'react'
import { useMenuCommand } from '../lib/menuCommands'
import { ABOUT_NOTE, aboutLines, type AboutInfo } from '@shared/about'
import { DialogHeader } from './DialogHeader'

/**
 * ヘルプ > バージョン情報。OS の白い確認の窓をやめ、アプリの中のダイアログで出す
 * (統一のダイアログの枠・幅 440)。ライセンスの文書は今まで通り main が別の窓で開く。
 */
export function AboutDialog(): React.JSX.Element | null {
  const [info, setInfo] = useState<AboutInfo | null>(null)
  useMenuCommand((id) => {
    if (id !== 'help.about') return
    void window.api.appAbout().then(setInfo)
  })
  useEffect(() => {
    if (!info) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setInfo(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [info])
  if (!info) return null
  const { title, runtime } = aboutLines(info)
  return (
    <div className="modal-backdrop" onMouseDown={() => setInfo(null)}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="バージョン情報"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DialogHeader title="バージョン情報" onClose={() => setInfo(null)} />
        <div className="about-dialog-body">
          <div className="about-dialog-product">
            <span className="workflow-bar-logo about-dialog-logo" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
              </svg>
            </span>
            <span className="about-dialog-title">{title}</span>
          </div>
          <p className="about-dialog-runtime">{runtime}</p>
          <p className="about-dialog-note">{ABOUT_NOTE}</p>
          <div className="about-dialog-links">
            <button
              type="button"
              className="small-button"
              onClick={() => window.api.openLicense('notices')}
            >
              サードパーティのライセンス…
            </button>
            <button
              type="button"
              className="small-button"
              onClick={() => window.api.openLicense('chromium')}
            >
              Chromium のライセンス…
            </button>
          </div>
        </div>
        <div className="dialog-footer">
          <div className="dialog-footer-spacer" />
          <button type="button" className="primary-button" autoFocus onClick={() => setInfo(null)}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

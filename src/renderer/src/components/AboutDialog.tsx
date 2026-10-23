import { useRef, useState } from 'react'
import { useEscapeToClose } from '../lib/useEscapeToClose'
import { useMenuCommand } from '../lib/menuCommands'
import { ABOUT_NOTE, aboutLines, sourceOfferView, type AboutInfo } from '@shared/about'
import { DialogHeader } from './DialogHeader'

/**
 * ヘルプ > バージョン情報。アプリの中のダイアログで出す(統一のダイアログの枠・幅 440)。
 * 「オープンソースの表記」「Chromium のライセンス」の文書は main が別の窓で開く。
 * 「ソースの入手方法」(GPL の FFmpeg のソースの提供の申し出)はこのダイアログの中で開く。
 */
export function AboutDialog(): React.JSX.Element | null {
  const [info, setInfo] = useState<AboutInfo | null>(null)
  const [showOffer, setShowOffer] = useState(false)
  const close = (): void => {
    setInfo(null)
    setShowOffer(false)
  }
  useMenuCommand((id) => {
    if (id !== 'help.about') return
    void window.api.appAbout().then(setInfo)
  })
  // Esc で閉じる(ほかのダイアログと同じ。上に重なった窓があればそちらが先)
  const backdropRef = useRef<HTMLDivElement>(null)
  useEscapeToClose(backdropRef, close, info !== null)
  if (!info) return null
  const { title, runtime } = aboutLines(info)
  const offer = sourceOfferView(info.sourceOffer)
  return (
    <div className="modal-backdrop" ref={backdropRef} onMouseDown={close}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="バージョン情報"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DialogHeader title="バージョン情報" onClose={close} />
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
              オープンソースの表記…
            </button>
            <button
              type="button"
              className="small-button"
              onClick={() => window.api.openLicense('chromium')}
            >
              Chromium のライセンス…
            </button>
            <button
              type="button"
              className="small-button"
              aria-expanded={showOffer}
              aria-controls="about-source-offer"
              onClick={() => setShowOffer((v) => !v)}
            >
              ソースの入手方法
            </button>
          </div>
          {showOffer && (
            <section
              id="about-source-offer"
              className="about-dialog-offer"
              aria-label="ソースの入手方法"
            >
              {offer.paragraphs.map((p) => (
                <p key={p}>{p}</p>
              ))}
              {offer.url && (
                <button
                  type="button"
                  className="small-button"
                  onClick={() => offer.url && void window.api.openExternal(offer.url)}
                >
                  入手先を開く
                </button>
              )}
            </section>
          )}
        </div>
        <div className="dialog-footer">
          <div className="dialog-footer-spacer" />
          <button type="button" className="primary-button" autoFocus onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { useEscapeToClose } from '../lib/useEscapeToClose'
import { useMenuCommand } from '../lib/menuCommands'
import { envCheckSections, type EnvCheckProgress, type EnvCheckResult } from '@shared/envCheck'
import { DialogHeader } from './DialogHeader'

/**
 * ヘルプ > 環境チェック…。GPU・ハードウェアのエンコーダ・書き出しの速さ・ローカル AI・文字起こしの
 * 構成を調べて表で出し、テキストで保存できる(どこにも自動では送らない)。
 * 調べている間(1〜2 分)は進み具合を出し、閉じると止める。
 */
const ENV_CHECK_LEAD =
  'このPCで分かったことです。不具合の相談や GPU の確認のときは「テキストで保存…」で保存して送ってください' +
  '(API キーとパスの中の利用者名は伏せてあります。自動では送りません)。'

type State =
  | { kind: 'closed' }
  | { kind: 'running'; progress: EnvCheckProgress | null }
  | { kind: 'done'; result: EnvCheckResult; savedTo?: string }
  | { kind: 'failed'; message: string }

export function EnvCheckDialog(): React.JSX.Element | null {
  const [state, setState] = useState<State>({ kind: 'closed' })
  const runId = useRef(0)
  const backdropRef = useRef<HTMLDivElement>(null)

  const start = (): void => {
    const id = ++runId.current
    setState({ kind: 'running', progress: null })
    window.api.envCheckRun().then(
      (result) => {
        if (runId.current === id) setState({ kind: 'done', result })
      },
      (e: unknown) => {
        if (runId.current === id)
          setState({ kind: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    )
  }
  const close = (): void => {
    if (state.kind === 'running') window.api.envCheckCancel()
    runId.current++
    setState({ kind: 'closed' })
  }

  useMenuCommand((id) => {
    if (id === 'help.envCheck' && state.kind !== 'running') start()
  })
  useEffect(() => {
    if (state.kind !== 'running') return
    return window.api.onEnvCheckProgress((p) =>
      setState((s) => (s.kind === 'running' ? { kind: 'running', progress: p } : s))
    )
  }, [state.kind])
  useEscapeToClose(backdropRef, close, state.kind !== 'closed')
  if (state.kind === 'closed') return null

  const save = async (result: EnvCheckResult): Promise<void> => {
    const savedTo = await window.api.envCheckSave(result)
    if (savedTo) setState({ kind: 'done', result, savedTo })
  }
  const percent =
    state.kind === 'running' && state.progress
      ? Math.round((state.progress.done / Math.max(1, state.progress.total)) * 100)
      : 0

  return (
    <div className="modal-backdrop" ref={backdropRef} onMouseDown={close}>
      <div
        className="env-check-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="環境チェック"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <DialogHeader title="環境チェック" onClose={close} />
        <div className="env-check-body">
          {state.kind === 'running' && (
            <div className="env-check-running" aria-live="polite">
              <p>
                GPU・書き出し・AI の構成を調べています(1〜2
                分)。試し書き出しをするので、その間は他の書き出しをしないでください。
              </p>
              <div className="progress-bar" aria-hidden="true">
                <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="env-check-step">{state.progress?.step ?? '準備しています'}</p>
            </div>
          )}
          {state.kind === 'failed' && (
            <p className="env-check-error">調べられませんでした: {state.message}</p>
          )}
          {state.kind === 'done' && (
            <>
              <p className="env-check-lead">{ENV_CHECK_LEAD}</p>
              {envCheckSections(state.result).map((section) => (
                <section key={section.title} className="env-check-section">
                  <h4>{section.title}</h4>
                  <dl>
                    {section.rows.map(([k, v], i) => (
                      <div key={`${k}-${i}`} className="env-check-row">
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              {state.savedTo && <p className="env-check-saved">保存しました: {state.savedTo}</p>}
            </>
          )}
        </div>
        <div className="dialog-footer">
          {state.kind === 'done' && (
            <button type="button" className="small-button" onClick={start}>
              もう一度調べる
            </button>
          )}
          {state.kind === 'failed' && (
            <button type="button" className="small-button" onClick={start}>
              もう一度調べる
            </button>
          )}
          <div className="dialog-footer-spacer" />
          {state.kind === 'running' ? (
            <button type="button" className="small-button" onClick={close}>
              止める
            </button>
          ) : (
            <>
              {state.kind === 'done' && (
                <button
                  type="button"
                  className="small-button"
                  onClick={() => void save(state.result)}
                >
                  テキストで保存…
                </button>
              )}
              <button type="button" className="primary-button" autoFocus onClick={close}>
                閉じる
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useProjectStore } from '../store/projectStore'
import { useAutosaveStore } from '../store/autosaveStore'
import { checkMissingAssets } from '../lib/projectFileActions'
import { formatIpcError } from '../lib/ipcError'

function formatTimestamp(mtimeMs?: number): string {
  if (!mtimeMs) return '日時不明'
  const d = new Date(mtimeMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 起動時に自動保存データが見つかったときの確認。
 *
 * `confirm()` 1つだと「いいえ」も ESC も同じ扱いで、押し間違えた瞬間に唯一の
 * 復元手段が消えていた。閉じる操作(ESC・背景クリック)は**何もしない**扱いにし、
 * 破棄は明示的に選んだときだけ、しかも消さずに退避する。
 */
export function AutosaveRestoreModal(): React.JSX.Element | null {
  const pending = useAutosaveStore((s) => s.pending)
  const clearPending = useAutosaveStore((s) => s.clearPending)
  const refresh = useAutosaveStore((s) => s.refresh)
  const restoreAutosave = useProjectStore((s) => s.restoreAutosave)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!pending) return null

  async function handleRestore(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const project = await window.api.loadAutosave()
      restoreAutosave(project)
      clearPending()
      await checkMissingAssets()
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDiscard(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await window.api.discardAutosave()
      clearPending()
      await refresh()
    } catch (e) {
      setError(formatIpcError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    // 背景クリックは「あとで決める」と同じ。閉じただけでデータを失わせない
    <div className="modal-backdrop" onClick={() => !busy && clearPending()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>自動保存されたデータが見つかりました</h3>
        <p className="hint-text">
          前回、保存せずに終了した可能性があります(自動保存: {formatTimestamp(pending.mtimeMs)})。
        </p>
        <p className="hint-text">
          「あとで決める」を選ぶと今は何もしません。「破棄する」を選んでも中身は消さずに
          取っておきます。どちらの場合も、上部バーの「破棄した自動保存データを戻す」から
          あとで復元できます。
        </p>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button onClick={() => clearPending()} disabled={busy}>
            あとで決める
          </button>
          <button className="danger" onClick={handleDiscard} disabled={busy}>
            破棄する
          </button>
          <button className="primary-button" onClick={handleRestore} disabled={busy}>
            復元する
          </button>
        </div>
      </div>
    </div>
  )
}

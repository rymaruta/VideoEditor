import type { ReactElement } from 'react'
import { SECRET_LABELS, type SecretName } from '@shared/secrets'
import { useSettingsStore } from '../store/settingsStore'

/**
 * API キーの欄の下に出す知らせ。
 * - 暗号化して保存できない PC(Linux で鍵の保管場所が無いなど): 鍵は今までどおり保存して使える
 * - 保存してあった鍵を読めなかった(別の PC から移した・OS の鍵が変わった、この起動では暗号化が
 *   使えない): 黙って空にせず、入れ直すよう知らせる
 */
export function KeyStorageNote({ names }: { names: readonly SecretName[] }): ReactElement | null {
  const mode = useSettingsStore((s) => s.keyStorage)
  const note = useSettingsStore((s) => s.keyStorageNote)
  const unreadableKeys = useSettingsStore((s) => s.unreadableKeys)
  const cause = useSettingsStore((s) => s.unreadableCause)
  const fileNote = useSettingsStore((s) => s.secretsFileNote)
  const unreadable = names.filter((n) => unreadableKeys.includes(n))
  if (mode !== 'plain' && unreadable.length === 0 && !fileNote) return null
  const labels = unreadable.map((n) => SECRET_LABELS[n]).join('・')
  return (
    <>
      {fileNote && <p className="hint-text">{fileNote}</p>}
      {unreadable.length > 0 && (
        <p className="hint-text">
          {cause === 'unavailable'
            ? `保存していた鍵(${labels})を、この起動では読めません(OS の暗号化が使えないため)。消してはいないので、暗号化が使える起動では戻ります。今すぐ使うなら入れ直してください。`
            : `保存していた鍵(${labels})を読めませんでした(別の PC から移した・OS の鍵が変わった等)。入れ直してください。`}
        </p>
      )}
      {mode === 'plain' && (
        <p className="hint-text">
          {note || 'API キーを暗号化して保存できません。'}
          鍵は今までどおりこのアプリの設定に保存します(暗号化はされません)。
        </p>
      )}
    </>
  )
}

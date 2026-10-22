import type { ReactElement } from 'react'
import { useSettingsStore } from '../store/settingsStore'

/**
 * API キーの欄の下に出す一文。暗号化して保存できない PC(Linux で鍵の保管場所が無いなど)だけ出す。
 * そのときも鍵は今までどおり保存して使える。
 */
export function KeyStorageNote(): ReactElement | null {
  const mode = useSettingsStore((s) => s.keyStorage)
  const note = useSettingsStore((s) => s.keyStorageNote)
  if (mode !== 'plain') return null
  return (
    <p className="hint-text">
      {note || 'API キーを暗号化して保存できません。'}
      鍵は今までどおりこのアプリの設定に保存します(暗号化はされません)。
    </p>
  )
}

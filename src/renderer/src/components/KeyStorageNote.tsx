import type { ReactElement } from 'react'
import type { SecretName } from '@shared/secrets'
import { useSettingsStore } from '../store/settingsStore'
import { keyStorageNotes } from '../lib/keyStorageNotes'

/**
 * API キーの欄の下に出す知らせ(中身は `keyStorageNotes`)。
 * - 暗号化して保存できない PC(Linux で鍵の保管場所が無いなど): 鍵は今までどおり保存して使える
 * - 保存してあった鍵を読めなかった(別の PC から移した・OS の鍵が変わった、この起動では暗号化が
 *   使えない): 黙って空にせず、入れ直すよう知らせる(その鍵の欄だけ)
 * - 保存ファイルが壊れていた・新しい版のもの・読めない
 */
export function KeyStorageNote({ names }: { names: readonly SecretName[] }): ReactElement | null {
  const keyStorage = useSettingsStore((s) => s.keyStorage)
  const keyStorageNote = useSettingsStore((s) => s.keyStorageNote)
  const unreadableKeys = useSettingsStore((s) => s.unreadableKeys)
  const unreadableCause = useSettingsStore((s) => s.unreadableCause)
  const secretsFileNote = useSettingsStore((s) => s.secretsFileNote)
  const secretsFileProblemNote = useSettingsStore((s) => s.secretsFileProblemNote)
  const notes = keyStorageNotes(
    {
      keyStorage,
      keyStorageNote,
      unreadableKeys,
      unreadableCause,
      secretsFileNote,
      secretsFileProblemNote
    },
    names
  )
  if (notes.length === 0) return null
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="hint-text">
          {n}
        </p>
      ))}
    </>
  )
}

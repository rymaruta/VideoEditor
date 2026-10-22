import type { ReactElement } from 'react'
import type { SecretName } from '@shared/secrets'
import { useSettingsStore } from '../store/settingsStore'
import { keyStorageNotes } from '../lib/keyStorageNotes'
import { AlertTriangleIcon } from './icons'

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
  // 「暗号化して保存できない」の知らせは 4 つのパネル(投稿準備・YouTube・ゲームトレンド・音源)の鍵の欄に
  // 同じ長い文で出ていた。1 行の要点にし、開けば全文を読めるようにする(中身は変えない)
  const plain = keyStorage === 'plain' ? notes[notes.length - 1] : null
  return (
    <>
      {notes
        .filter((n) => n !== plain)
        .map((n) => (
          <p key={n} className="key-note" role="note">
            <AlertTriangleIcon width={12} height={12} />
            <span>{n}</span>
          </p>
        ))}
      {plain && (
        <div className="key-note" role="note">
          <AlertTriangleIcon width={12} height={12} />
          <details>
            <summary>API キーは暗号化せずに保存します</summary>
            <p>{plain}</p>
          </details>
        </div>
      )}
    </>
  )
}

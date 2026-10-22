import { SECRET_LABELS, type SecretName } from '@shared/secrets'

/** 鍵の欄の知らせを決めるのに要る設定の状態 */
export interface KeyStorageNoteState {
  keyStorage: 'pending' | 'encrypted' | 'plain'
  keyStorageNote: string
  unreadableKeys: readonly SecretName[]
  unreadableCause: 'decrypt' | 'unavailable' | null
  secretsFileNote: string
  secretsFileProblemNote: string
}

/**
 * ある鍵の欄の下に出す知らせ(出す順)。**どの欄にも出す。** 鍵の欄は投稿準備・トレンド・音源の
 * タブに分かれて常に置かれていて(見えないタブは隠すだけ)、同時に見えるのは1つなので、
 * 「最初の欄にだけ出す」と、見えない欄にだけ出て見えている欄に出ないことがあった。
 */
export function keyStorageNotes(
  state: KeyStorageNoteState,
  names: readonly SecretName[]
): string[] {
  const notes: string[] = []
  if (state.secretsFileNote) notes.push(state.secretsFileNote)
  if (state.secretsFileProblemNote) notes.push(state.secretsFileProblemNote)
  const unreadable = names.filter((n) => state.unreadableKeys.includes(n))
  if (unreadable.length > 0) {
    const labels = unreadable.map((n) => SECRET_LABELS[n]).join('・')
    notes.push(
      state.unreadableCause === 'unavailable'
        ? `保存していた鍵(${labels})を、この起動では読めません(OS の暗号化が使えないため)。消してはいないので、暗号化が使える起動では戻ります。今すぐ使うなら入れ直してください。`
        : `保存していた鍵(${labels})を読めませんでした(別の PC から移した・OS の鍵が変わった等)。入れ直してください。`
    )
  }
  if (state.keyStorage === 'plain')
    notes.push(
      `${state.keyStorageNote || 'API キーを暗号化して保存できません。'}鍵は今までどおりこのアプリの設定に保存します(暗号化はされません)。`
    )
  return notes
}

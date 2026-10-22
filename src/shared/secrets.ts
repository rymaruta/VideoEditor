/**
 * 外部のサービスの鍵(API キー)。main が OS の仕組み(Electron の safeStorage: Windows の DPAPI・
 * macOS のキーチェーン・Linux の Secret Service)で暗号化して userData/secrets.json に置く。
 *
 * 前の版までは画面の保存領域(localStorage)に平文で置いていた。起動のたびに、そこに残っている鍵を
 * main へ移して、移せたものから消す(下の `LEGACY_SECRET_STORAGE_KEYS`。10/09 版以前もこの名前)。
 * 暗号化が使えない PC では今までどおり localStorage に置き、設定の欄にその旨を出す。
 */
export const SECRET_NAMES = [
  'geminiApiKey',
  'youtubeApiKey',
  'jamendoClientId',
  'freesoundApiKey'
] as const

export type SecretName = (typeof SECRET_NAMES)[number]

/** 前の版が鍵を置いていた localStorage の名前(変えない。古い設定から読むため) */
export const LEGACY_SECRET_STORAGE_KEYS: Record<SecretName, string> = {
  youtubeApiKey: 've-youtube-api-key',
  jamendoClientId: 've-jamendo-client-id',
  freesoundApiKey: 've-freesound-api-key',
  geminiApiKey: 've-gemini-api-key'
}

/** 鍵の長さの上限(これより長いものは鍵ではない) */
export const MAX_SECRET_LENGTH = 4096

export function isSecretName(name: unknown): name is SecretName {
  return typeof name === 'string' && (SECRET_NAMES as readonly string[]).includes(name)
}

/** main から画面へ渡す、起動時の鍵の状態 */
export interface SecretsSnapshot {
  /** 暗号化して保存できるか */
  available: boolean
  /** 使えないときの理由(画面に出す一文) */
  reason?: string
  /** 復号できた鍵(無いものは入れない) */
  values: Partial<Record<SecretName, string>>
}

/**
 * localStorage に残っている鍵のうち、main へ移すもの。
 * 残っている値(空も「消した」として)を優先する: 暗号化が使えなかった間に、利用者が
 * 入れ直した・消したものがそこにあるため。
 */
export function legacySecretsToMigrate(
  read: (storageKey: string) => string | null
): Partial<Record<SecretName, string>> {
  const out: Partial<Record<SecretName, string>> = {}
  for (const name of SECRET_NAMES) {
    let value: string | null = null
    try {
      value = read(LEGACY_SECRET_STORAGE_KEYS[name])
    } catch {
      value = null
    }
    if (typeof value === 'string' && value.length <= MAX_SECRET_LENGTH) out[name] = value
  }
  return out
}

import { safeStorage } from 'electron'
import type { SecretCipher } from './secretStore'

/**
 * Electron の safeStorage で鍵を暗号化する(Windows: DPAPI、macOS: キーチェーン、Linux: Secret Service
 * / KWallet)。Linux で OS の鍵の保管場所が無いとき(basic_text)は、決まった鍵で隠すだけで暗号化に
 * ならないので「使えない」とする(画面は今までどおり保存し、その旨を出す)。
 */
export const safeStorageCipher: SecretCipher = {
  isAvailable(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    if (process.platform === 'linux') {
      try {
        return safeStorage.getSelectedStorageBackend() !== 'basic_text'
      } catch {
        return false
      }
    }
    return true
  },
  unavailableReason(): string {
    return process.platform === 'linux'
      ? 'OS の鍵の保管場所(GNOME キーリング・KWallet など)が見つからないため、API キーを暗号化できません。'
      : 'OS の暗号化の仕組みが使えないため、API キーを暗号化できません。'
  },
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data)
}

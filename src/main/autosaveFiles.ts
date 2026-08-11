import { existsSync, renameSync, statSync } from 'fs'

/**
 * 破棄した自動保存データの置き場。`autosave.veproj` の隣に、拡張子の前へ
 * `-discarded` を挟んだ名前で置く。
 */
export function discardedPathFor(autosavePath: string): string {
  return autosavePath.replace(/(\.veproj)?$/, '-discarded$1')
}

export interface AutosaveStatus {
  exists: boolean
  mtimeMs?: number
  /** 破棄して退避したデータがあるか(あれば利用者が戻せる) */
  discardedExists: boolean
  discardedMtimeMs?: number
}

export function autosaveStatus(autosavePath: string): AutosaveStatus {
  const discardedPath = discardedPathFor(autosavePath)
  const exists = existsSync(autosavePath)
  const discardedExists = existsSync(discardedPath)
  return {
    exists,
    ...(exists ? { mtimeMs: statSync(autosavePath).mtimeMs } : {}),
    discardedExists,
    ...(discardedExists ? { discardedMtimeMs: statSync(discardedPath).mtimeMs } : {})
  }
}

/**
 * 自動保存データを「破棄」する。消さずに退避先へ移すだけなので、あとから戻せる。
 *
 * 前回落ちたときの唯一の復元手段を、確認ダイアログの押し間違いひとつで永久に
 * 失わせないための措置。退避先は1つだけで、破棄するたびに上書きされる。
 *
 * @returns 退避したら true。元ファイルが無ければ false(退避先はそのまま残す)
 */
export function discardAutosaveFile(autosavePath: string): boolean {
  if (!existsSync(autosavePath)) return false
  renameSync(autosavePath, discardedPathFor(autosavePath))
  return true
}

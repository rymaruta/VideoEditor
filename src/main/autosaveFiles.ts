import { existsSync, renameSync, statSync } from 'fs'
import { saveProjectFile } from './projectFileService'
import type { Project } from '@shared/types'

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

/**
 * 自動保存を書く。`setAsideExisting` なら、居座っている自動保存を**退避してから**上書きする。
 *
 * 起動時の確認で「あとで決める」を選ぶと `autosave.veproj` は残る。その状態で編集すると
 * 60秒ごとの自動保存が**前回の作業をそのまま上書き**してしまい、見送っただけのつもりが
 * 戻す手段ごと消えていた(見送ったぶんは**まだどのファイルにもなっていない前回の作業**で、
 * 中身は他のどこにも無い)。退避先は「破棄する」と同じ1つなので、上部バーの
 * 「破棄した自動保存データを戻す」からそのまま戻せる。
 *
 * 退避するかどうかを**呼び出し側から渡す**のは、退避してよいのが
 * **そのセッションで初めて書くときだけ**だから。毎回退避すると、2回目以降は
 * 「1分前の自分」で退避先が上書きされ、結局前回のぶんが消える。
 *
 * @returns 実際に退避したら true(自動保存が無ければ false)
 */
export function writeAutosaveFile(
  autosavePath: string,
  project: Project,
  setAsideExisting: boolean
): boolean {
  const setAside = setAsideExisting ? discardAutosaveFile(autosavePath) : false
  saveProjectFile(autosavePath, project)
  return setAside
}

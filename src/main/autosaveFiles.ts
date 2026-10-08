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
  setAsideExisting: boolean,
  options: {
    /**
     * 退避した直後に呼ぶ(書き込みが失敗しても、退避したことは呼び出し側に伝わる。
     * 伝わらないと、次の自動保存がもう一度退避して、退避した前回の作業を上書きしていた)
     */
    onSetAside?: () => void
    /**
     * 退避先に前に退避したもの(前回のセッションの作業)があれば、消さずに日時付きの名前で残す
     * (画面が落ちて読み込み直したときに、落ちる前の作業を退避すると、前回の作業が消えていた)
     */
    keepPreviousDiscarded?: boolean
  } = {}
): boolean {
  const setAside = setAsideExisting
    ? setAsideAutosaveFile(autosavePath, options.keepPreviousDiscarded ?? false)
    : false
  if (setAside) options.onSetAside?.()
  saveProjectFile(autosavePath, project)
  return setAside
}

/**
 * 自動保存を退避先へ移す(`discardAutosaveFile`)。`keepPreviousDiscarded` なら、退避先に前から
 * 居るもの(前回のセッションの作業)を日時付きの名前で残してから移す。自動保存・破棄・開く・新規・
 * 終了のどの経路で退避しても同じ扱いにする(自動保存の経路でしか残していなかった)
 *
 * @returns 退避したら true
 */
export function setAsideAutosaveFile(
  autosavePath: string,
  keepPreviousDiscarded: boolean
): boolean {
  if (!existsSync(autosavePath)) return false
  const discarded = discardedPathFor(autosavePath)
  if (keepPreviousDiscarded && existsSync(discarded)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(discarded, discarded.replace(/(\.veproj)?$/, `-${stamp}$1`))
  }
  return discardAutosaveFile(autosavePath)
}

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { Project } from '@shared/types'

// 同じプロセス内で保存が重なっても衝突しない一時ファイル名を作るための連番。
let saveSequence = 0

/**
 * プロジェクトを保存する。**隣に書いてから rename する**。
 *
 * 保存先へ直接 `writeFileSync` すると、**書き込みを始めた瞬間に元のファイルが空になる**
 * (`O_TRUNC`)。そこでアプリが落ちる・電源が切れると、**上書き前の内容はどこにも残らない**。
 * (実測: 17088バイトの有効なプロジェクトを上書き中にサイズが 0 になり、その瞬間に
 * 強制終了すると 2,097,152バイトの断片だけが残って「ファイルが壊れているか、対応して
 * いない形式です」で開けなくなった)
 *
 * rename は同じファイルシステム内なら不可分なので、途中で落ちても元のファイルがそのまま
 * 残る。**自動保存(60秒ごと)も同じ関数を通る**ので、クラッシュ復旧用のファイルが
 * クラッシュで壊れることも防げる。一時ファイルは保存先と同じディレクトリに置くこと
 * (別のファイルシステムへ跨ると rename が `EXDEV` で失敗する)。
 */
export function saveProjectFile(filePath: string, project: Project): void {
  // **一時ファイルの名前は、保存先の名前から作らない。**
  // `${filePath}.saving-…` のように後ろへ足すと、一時ファイルだけが名前の長さの上限
  // (1要素 255バイト)を先に超えて、**利用者が付けられる名前なのに保存だけできない**
  // という状態になる。付け足す約22バイトぶん、使える名前が短くなっていた。
  // (実測: 日本語の名前は **76文字(235バイト)までは保存でき、77文字(238バイト)から
  //  `ENAMETOOLONG` で失敗**した。同じ名前へ直に書けば 255バイトまで通るので、
  //  失われていたのは一時ファイルのぶんだけ。半角なら 232文字までしか保存できなかった)
  // 同じディレクトリに**長さの決まった**名前で置く。rename が不可分なのは同一
  // ファイルシステム内という条件だけなので、ディレクトリさえ変えなければよい。
  const tmpPath = join(dirname(filePath), `.ve-save-${process.pid}-${saveSequence++}.tmp`)
  try {
    writeFileSync(tmpPath, JSON.stringify(project, null, 2), 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (e) {
    // 書けなかったぶんを残すと、保存先の隣にゴミが溜まり続ける。
    // **後始末で投げないこと。** `force: true` は「無かったことにする」だけで、
    // `lstat` の失敗(長すぎるパスなど)は投げるので、そのまま書くと**本当の原因が
    // 後始末の失敗にすり替わって外へ出る**。実測では、保存できなかったときの文言が
    // `open` ではなく **`lstat` の `ENAMETOOLONG`** になっており、書き込みが
    // なぜ失敗したのかは残っていなかった。
    try {
      rmSync(tmpPath, { force: true })
    } catch {
      /* 消せなくても、報告すべきは元の失敗のほう */
    }
    throw e
  }
}

export function loadProjectFile(filePath: string): Project {
  // 最近使った一覧から開くと、移動・削除されたファイルを指すことがある。ここで止めないと
  // 「ENOENT: no such file or directory, open '/...'」という生のエラーがそのまま画面に出る。
  if (!existsSync(filePath)) {
    throw new Error(
      `プロジェクトファイルが見つかりません。移動または削除された可能性があります: ${filePath}`
    )
  }
  const raw = readFileSync(filePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      'プロジェクトファイルを読み込めませんでした。ファイルが壊れているか、対応していない形式です。'
    )
  }
  // Without this, a file that parses to null/an array/a number reaches the store
  // and blows up later with an opaque "Cannot read properties of null".
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('プロジェクトファイルの形式が正しくありません。')
  }
  return parsed as Project
}

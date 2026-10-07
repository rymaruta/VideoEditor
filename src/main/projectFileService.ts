import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import type { Project } from '@shared/types'

// 同じプロセス内で保存が重なっても衝突しない一時ファイル名を作るための連番。
let saveSequence = 0

/** 見慣れない原因を原文で残すときの上限 */
const MAX_SAVE_DETAIL_LENGTH = 120

/**
 * 書き込みが失敗したときの、Node のエラーコードごとの日本語。
 *
 * **同じ形の表が `audioLibraryService` にもある**(あちらは音源のダウンロード用で、
 * 通信の失敗が主なので文言が違う)。重なっているのは `ENOSPC` と権限系の2行だけ。
 * 片方を直したらもう片方も見ること。
 */
const SAVE_ERROR_MESSAGES: [RegExp, string][] = [
  [/^(ENOENT|ENOTDIR)$/, '保存先のフォルダが見つかりません。移動または削除された可能性があります'],
  [/^(EACCES|EPERM|EROFS)$/, '保存先に書き込む権限がありません'],
  [/^(ENOSPC|EDQUOT)$/, 'ディスクの空き容量が足りません'],
  [/^ENAMETOOLONG$/, 'ファイル名が長すぎます。短い名前を付けてください'],
  [/^EISDIR$/, '同じ名前のフォルダがあります。別の名前を付けてください'],
  [/^EBUSY$/, 'ファイルが他のアプリで使用中です']
]

/**
 * 保存の失敗を、利用者に見せられる短い日本語にする。
 *
 * **読み込みだけが日本語になっていて、保存は生のままだった。** 同じ機能の逆方向なのに、
 * 片方にしか手当てが育っていない典型。`writeFileSync` / `renameSync` が投げるのは
 * Node の生のシステムエラーで、そのまま画面に出ていた。
 * (実測: 保存先のフォルダが消えていると **92文字・日本語なし**の
 *  `ENOENT: no such file or directory, open '/…/.ve-save-7492-0.tmp'`。
 *  フォルダのはずの場所がファイルなら 78文字の `ENOTDIR:`、保存先がフォルダなら
 *  118文字の `EISDIR:`。同じファイルの `loadProjectFile` は3通りとも
 *  23〜72文字の日本語で出ている)
 *
 * **出すのは利用者が付けたパス。** 生のエラーに載っているのは
 * `.ve-save-<pid>-<連番>.tmp` という**利用者が一度も見たことのない名前**で、
 * 自分が保存しようとしたファイルの名前はどこにも出てこない。アプリの不具合にしか
 * 見えないうえ、「フォルダが消えている」という直せる原因にも辿り着けない。
 *
 * 見慣れない原因は**捨てずに**、1行にして長さで切って残す(唯一の手がかりになる)。
 */
function describeSaveFailure(filePath: string, e: unknown): Error {
  const code =
    typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : ''
  if (code) {
    for (const [pattern, message] of SAVE_ERROR_MESSAGES) {
      if (pattern.test(code)) {
        return new Error(`プロジェクトを保存できませんでした。${message}: ${filePath}`)
      }
    }
  }
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
  const detail =
    raw.length > MAX_SAVE_DETAIL_LENGTH ? `${raw.slice(0, MAX_SAVE_DETAIL_LENGTH)}…` : raw
  return new Error(`プロジェクトを保存できませんでした: ${detail}`)
}

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
/**
 * 書いて、**ディスクに届くまで待ってから**閉じる。
 *
 * rename が不可分でも、中身がまだ OS のキャッシュにしか無いうちに電源が落ちると、
 * 「名前だけ新しく、中身は空(か途中まで)」のファイルが残りうる(ファイルシステムは名前の
 * 書き換えと中身の書き込みの順番を保証しない。NTFS・ext4 の既定でも起きる)。
 * そうなると上書き前の内容も消えているので、rename の前に中身を確定させる。
 * 待つのは 1回の保存で数〜数十 ms(自動保存は 60秒ごとなので体感に響かない)
 */
function writeDurably(path: string, text: string): void {
  const fd = openSync(path, 'w')
  try {
    writeFileSync(fd, text, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

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
    writeDurably(tmpPath, JSON.stringify(project, null, 2))
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
    // 投げるのは**元の失敗**を日本語にしたもの(後始末の失敗ではない)。
    throw describeSaveFailure(filePath, e)
  }
}

/**
 * 読み込みが失敗したときの、Node のエラーコードごとの日本語。
 *
 * **上の保存側と対になる表。** 片方を直したらもう片方も見ること
 * (`SAVE_ERROR_MESSAGES` と重なるのは「見つからない」「権限」「使用中」の3行だが、
 * 書けないのか読めないのかで利用者の次の一手が違うので文言は分けてある)。
 */
const LOAD_ERROR_MESSAGES: [RegExp, string][] = [
  [/^(ENOENT|ENOTDIR)$/, 'ファイルが見つかりません。移動または削除された可能性があります'],
  [/^(EACCES|EPERM)$/, 'このファイルを読み込む権限がありません'],
  [/^EISDIR$/, '指定された場所はフォルダです。プロジェクトファイル(.veproj)を選んでください'],
  [/^EBUSY$/, 'ファイルが他のアプリで使用中です'],
  [/^ENAMETOOLONG$/, 'ファイルの場所が長すぎて開けません'],
  [/^(EIO|ENXIO|ENODEV)$/, 'ファイルを読み取れませんでした。ディスクや接続を確認してください']
]

/**
 * 読み込みの失敗を、利用者に見せられる短い日本語にする。
 *
 * **「無い」「壊れている」だけを日本語にしていて、`readFileSync` そのものの失敗は
 * 生のままだった。** 同じファイルの `saveProjectFile` はコード別の表を持っているのに、
 * 対になる読み込み側はここだけ抜けていた——**逆方向を対にしたつもりで、
 * 後から片方にだけ表が育った**形。
 *
 * 入口は**最近使ったプロジェクト一覧**。ダイアログを通さずに覚えていたパスを直接開くので、
 * ファイルが別の物に置き換わっていることがある。しかも一覧の「見つかりません」印は
 * `existsSync` で付けるので、**同じ名前のフォルダができていると「在る」と判定されて
 * 印すら付かない**。
 * (実測: そのパスがフォルダのとき、画面に出るのは
 *  **`EISDIR: illegal operation on a directory, read`——46文字・日本語なし**。
 *  同じ状況で `probeMedia` は 35文字の日本語、保存の失敗は 158文字の日本語で出ており、
 *  IPC 21経路のうち生の英語が出るのはここだけだった)
 *
 * 見慣れない原因は**捨てずに**、1行にして長さで切って残す(保存側と同じ扱い)。
 */
function describeLoadFailure(filePath: string, e: unknown): Error {
  const code =
    typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : ''
  if (code) {
    for (const [pattern, message] of LOAD_ERROR_MESSAGES) {
      if (pattern.test(code)) {
        return new Error(`プロジェクトファイルを開けませんでした。${message}: ${filePath}`)
      }
    }
  }
  const raw = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
  const detail =
    raw.length > MAX_SAVE_DETAIL_LENGTH ? `${raw.slice(0, MAX_SAVE_DETAIL_LENGTH)}…` : raw
  return new Error(`プロジェクトファイルを開けませんでした: ${detail}`)
}

export function loadProjectFile(filePath: string): Project {
  // 最近使った一覧から開くと、移動・削除されたファイルを指すことがある。ここで止めないと
  // 「ENOENT: no such file or directory, open '/...'」という生のエラーがそのまま画面に出る。
  if (!existsSync(filePath)) {
    throw new Error(
      `プロジェクトファイルが見つかりません。移動または削除された可能性があります: ${filePath}`
    )
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (e) {
    // 存在は確かめたのに読めない——フォルダだった・権限が無い・他のアプリが掴んでいる・
    // ネットワークドライブが切れた。**どれも `existsSync` は通る。**
    throw describeLoadFailure(filePath, e)
  }
  let parsed: unknown
  try {
    // メモ帳などで手直しすると、頭に BOM が付く(JSON.parse はそれを読めない)
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
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

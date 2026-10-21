import { randomBytes } from 'crypto'
import { renameSync, rmSync } from 'fs'
import { dirname, extname, join } from 'path'

/**
 * 書き出しは、同じフォルダの一時ファイルへ書き、終わってから本来の名前に置き換える。
 *
 * そのまま本来の名前へ書くと、途中で失敗したとき**壊れた動画が完成品の名前で残る**
 * (再生すると途中で止まる。前に書き出した同じ名前の完成品も、書き始めた時点で消えている)。
 * 一時ファイルの拡張子は本来と同じにする(ffmpeg は拡張子で入れ物を決める)。
 *
 * **一時ファイルの名前は、保存先の名前から作らない。** 以前は `${名前}.partial-xxxxxxxx${拡張子}` と
 * 17バイト足していたので、保存ダイアログが通した長い名前ほど**一時ファイルだけが1要素 255バイトの
 * 上限を先に超え**、書き出しが `ENAMETOOLONG` で失敗していた
 * (実測: 日本語 80文字 + `.mp4` = 244バイトの名前は直に書けるのに、一時ファイル名は 261バイトになり失敗)。
 * 企画の保存(`saveProjectFile`)と同じく、同じフォルダに**長さの決まった**名前で置く
 * (置き換えが不可分なのは同じファイルシステムの中だけなので、フォルダは変えない)。
 * プロセス番号と乱数で、同時に走る書き出し同士も重ならない。
 * 隠しファイルにしないのは、置き換えに失敗したとき、残した場所を利用者に伝えて探してもらうため。
 * `.partial-` の印は前の版と同じにしてあり、前の版が残した一時ファイルとも同じ見分け方で見つかる。
 */
export function partialPathFor(outputPath: string): string {
  const ext = extname(outputPath)
  const tag = `${process.pid}-${randomBytes(4).toString('hex')}`
  return join(dirname(outputPath), `ve-export.partial-${tag}${ext}`)
}

/**
 * 書き出し先の名前を `.mp4` で終わらせる。Linux の保存ダイアログは拡張子を足さないので、
 * 「clip」と打つと拡張子の無い一時ファイルになり、ffmpeg が入れ物を決められず、
 * 全部書き終えた最後に英語のエラーで失敗していた
 */
export function withMp4Extension(outputPath: string): string {
  return extname(outputPath).toLowerCase() === '.mp4' ? outputPath : `${outputPath}.mp4`
}

/**
 * 企画の保存先の名前を `.veproj` で終わらせる。Linux の保存ダイアログは拡張子を足さないので、
 * 「myshow」と打つと拡張子の無いファイルになり、「開く」のダイアログ(.veproj だけを出す)に出なかった
 */
export function withVeprojExtension(filePath: string): string {
  return extname(filePath).toLowerCase() === '.veproj' ? filePath : `${filePath}.veproj`
}

export async function writeViaPartial<T>(
  outputPath: string,
  write: (path: string) => Promise<T>
): Promise<T> {
  const partial = partialPathFor(outputPath)
  let result: T
  try {
    result = await write(partial)
  } catch (e) {
    // 書き出し先が読み取り専用・外付けディスクが抜けた等では、後始末の rm 自体も
    // 失敗しうる。後始末の例外で本来の ffmpeg/書き込みエラーを上書きしない。
    try {
      rmSync(partial, { force: true })
    } catch {
      /* 報告すべきなのは元の失敗 */
    }
    throw e
  }
  // 同じフォルダの中の置き換え(Windows でも、あれば上書きする)。前の完成品を再生中・ウイルス対策の
  // 検査中だと一時的に置き換えられないので、少し待って何度か試す。それでも駄目なら、書き上げた動画は
  // 消さずに残し、その場所を伝える(何十分もかけた書き出しを捨てない)
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(partial, outputPath)
      return result
    } catch (e) {
      if (attempt >= RENAME_RETRIES) {
        throw new Error(
          `書き出しは終わりましたが、「${outputPath}」を置き換えられませんでした` +
            `(再生中・ほかのアプリが開いている可能性があります)。書き出した動画は「${partial}」に残しています。` +
            `(${e instanceof Error ? e.message : String(e)})`
        )
      }
      await new Promise((r) => setTimeout(r, RENAME_WAIT_MS))
    }
  }
}

const RENAME_RETRIES = 5
const RENAME_WAIT_MS = 400

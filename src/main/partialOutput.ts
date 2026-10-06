import { randomBytes } from 'crypto'
import { renameSync, rmSync } from 'fs'
import { basename, dirname, extname, join } from 'path'

/**
 * 書き出しは、同じフォルダの一時ファイルへ書き、終わってから本来の名前に置き換える。
 *
 * そのまま本来の名前へ書くと、途中で失敗したとき**壊れた動画が完成品の名前で残る**
 * (再生すると途中で止まる。前に書き出した同じ名前の完成品も、書き始めた時点で消えている)。
 * 一時ファイルの拡張子は本来と同じにする(ffmpeg は拡張子で入れ物を決める)。
 */
export function partialPathFor(outputPath: string): string {
  const ext = extname(outputPath)
  const stem = basename(outputPath, ext)
  return join(dirname(outputPath), `${stem}.partial-${randomBytes(4).toString('hex')}${ext}`)
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

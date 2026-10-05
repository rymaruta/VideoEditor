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
  try {
    const result = await write(partial)
    // 同じフォルダの中の置き換え(Windows でも、あれば上書きする)
    renameSync(partial, outputPath)
    return result
  } catch (e) {
    rmSync(partial, { force: true })
    throw e
  }
}

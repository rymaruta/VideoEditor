import { statSync } from 'fs'
import { basename, dirname, extname, resolve } from 'path'
import { writeViaPartial } from './partialOutput'
import type { Project } from '@shared/types'

/**
 * 書き出し先が、この企画が読んでいるファイル(素材・プロキシ・ノイズ除去の前後・OBS から取り出した音声)
 * や企画ファイル・自動保存と同じでないかを、**書き出しを始める前に main で**確かめる。
 *
 * 書き出しは一時ファイルへ書いてから最後に `renameSync` で本来の名前へ置き換える(`writeViaPartial`)。
 * 保存ダイアログで素材の名前を選ぶと、出るのは OS の「上書きしますか」だけで、**最後の置き換えで
 * 素材そのものが書き出した動画に差し替わり、元の撮影データが消えていた**
 * (実測: 6秒・320x180 の素材 `cam1.mp4` を書き出し先にすると、書き出しは成功で終わり、
 * `cam1.mp4` は 2秒・854x480 の書き出した動画に置き換わった。企画を開き直すと、その素材から
 * 作ったカットは全部別の絵・足りない尺になる)。
 * 一括書き出し・ショートの書き出し・区間ごとの書き出しも全部 `IPC.exportProject` を通るので、
 * ここ1か所で止める(画面側で止めるだけだと、別の呼び出し口を足したときに漏れる)。
 */

/** 書き出しで上書きしてはいけないファイルと、その説明(利用者に見せる) */
export interface ProtectedPath {
  path: string
  label: string
}

/**
 * 比べるための形。絶対パスにして `..`・重複した区切りを畳む。Windows は大文字・小文字を
 * 区別しない(`C:\Media\Cam1.MP4` と `c:\media\cam1.mp4` は同じファイル)ので小文字にそろえる
 */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const abs = resolve(p)
  return platform === 'win32' ? abs.replace(/\//g, '\\').toLowerCase() : abs
}

/**
 * 同じファイルか。文字列で比べたうえで、両方が在れば**中身の実体(デバイスと i-node)**でも比べる。
 * シンボリックリンク・ハードリンク・大文字小文字を区別しない macOS の既定のディスクでは、
 * 違う綴りでも同じファイルを指す(文字列だけだと素通りして、素材が上書きされる)
 */
export function isSamePath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!a || !b) return false
  if (pathKey(a, platform) === pathKey(b, platform)) return true
  try {
    const sa = statSync(a, { bigint: true })
    const sb = statSync(b, { bigint: true })
    // i-node を返さない環境(一部のネットワークドライブ)は 0 になる。0 同士を同じとみなさない
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}

/** 企画が読んでいるファイル。書き出しはどれも `filePath` を読むが、プロキシ等も上書きすれば壊れる */
export function projectSourcePaths(project: Pick<Project, 'assets'>): ProtectedPath[] {
  const out: ProtectedPath[] = []
  for (const a of project.assets ?? []) {
    const name = a.fileName || basename(a.filePath ?? '')
    if (a.filePath) out.push({ path: a.filePath, label: `素材「${name}」` })
    if (a.proxyPath) out.push({ path: a.proxyPath, label: `素材「${name}」のプレビュー用ファイル` })
    if (a.denoisedFrom)
      out.push({ path: a.denoisedFrom, label: `素材「${name}」のノイズ除去前の元の録音` })
    if (a.proxyBeforeDenoise)
      out.push({
        path: a.proxyBeforeDenoise,
        label: `素材「${name}」のノイズ除去前のプレビュー用ファイル`
      })
  }
  return out
}

/**
 * 書き出し先がどれかと重なれば、利用者に見せる理由を返す(重ならなければ null)。
 * 企画ファイル(`.veproj`)は拡張子だけでも止める: 書き出しは常に MP4 なので、`.veproj` へ
 * 書く正当な理由が無い(このセッションで開いていない企画ファイルも守れる)
 */
export function exportOutputConflict(
  outputPath: string,
  protectedPaths: ProtectedPath[],
  platform: NodeJS.Platform = process.platform
): string | null {
  const hit = protectedPaths.find((p) => isSamePath(outputPath, p.path, platform))
  if (hit)
    return (
      `書き出し先「${outputPath}」は、この企画の${hit.label}と同じファイルです。` +
      `このまま書き出すと元のファイルが書き出した動画で上書きされて失われるため、書き出しを止めました。` +
      `別の名前か別の場所を選んでください。`
    )
  if (extname(outputPath).toLowerCase() === '.veproj')
    return (
      `書き出し先「${outputPath}」は企画ファイル(.veproj)です。` +
      `上書きすると企画が失われるため、書き出しを止めました。別の名前(.mp4)を選んでください。`
    )
  return null
}

/**
 * 書き出し先を確かめてから、一時ファイル経由で書く。重なれば**何も書かずに**投げる
 * (一時ファイルも作らない。ffmpeg も起こさない)
 */
export async function writeExportGuarded<T>(
  outputPath: string,
  protectedPaths: ProtectedPath[],
  write: (path: string) => Promise<T>
): Promise<T> {
  const conflict = exportOutputConflict(outputPath, protectedPaths)
  if (conflict) throw new Error(conflict)
  return writeViaPartial(outputPath, write)
}

/**
 * 書き出し先のフォルダが在るか。無ければ、書き出し先の問題だと分かる文面で止める。
 * 前は ffmpeg の `No such file or directory` を素材の読み込みと同じ表で訳し、
 * 「ファイルが見つかりません。移動または削除された可能性があります」と出ていた(素材が消えたと誤解させた)
 */
export function assertOutputFolderExists(outputPath: string): void {
  const dir = dirname(resolve(outputPath))
  let ok = false
  try {
    ok = statSync(dir).isDirectory()
  } catch {
    ok = false
  }
  if (!ok)
    throw new Error(
      `書き出し先のフォルダが見つかりません(${dir})。フォルダの名前が変わっていないか・` +
        '外付けのディスクが外れていないかを確かめるか、保存先を選び直してください(素材は無事です)'
    )
}

/**
 * ffmpeg / ffprobe の失敗を、利用者に見せられる短い日本語にする。
 *
 * fluent-ffmpeg が投げるエラーの `message` は **`ffprobe exited with code 1` +
 * 標準エラー出力の全文**で、その大半は版数とビルド設定の羅列(`--enable-gpl`
 * `--enable-libx264` …)。本当に必要な1行は**一番最後**にある。
 * これがそのまま画面に出ていた——実測: 動画でないファイルを1つ読み込ませると、
 * メディアパネルに **1,563文字**のエラーが出て、その高さは **821px**。
 * パネル自体の高さが 792px なので、**入れ物より説明文のほうが大きい**状態だった。
 *
 * ffmpeg の失敗でないもの(`loadProjectFile` の日本語メッセージ、書き出しの
 * `EXPORT_CANCELED` など)は**素通しで返す**。ここで握って別物にすると、
 * 呼び出し側が見ている目印まで消えてしまう。
 */

/** 原因の行として意味を持たない行(進捗・締めの決まり文句・版数とビルド設定) */
const NOISE = [
  /^ffmpeg version /i,
  /^ffprobe version /i,
  /^\s+(built with|configuration:|lib[a-z]+\s)/i,
  /^Conversion failed!?$/i,
  /^\s*(frame|size)=/i,
  /^Press \[q\]/i,
  /^Input #\d/i,
  /^Output #\d/i,
  /^\s*Stream #\d/i,
  /^\s*Metadata:/i,
  /^\s*encoder\s*:/i,
  /^At least one output file must be specified$/i
]

/** 見慣れた原因は、その場で何をすればよいか分かる日本語に置き換える */
const KNOWN: [RegExp, string][] = [
  [/No such file or directory/i, 'ファイルが見つかりません。移動または削除された可能性があります'],
  [/Permission denied/i, 'ファイルを開く権限がありません'],
  [/Invalid data found when processing input/i, '対応していない形式か、ファイルが壊れています'],
  [
    /moov atom not found/i,
    '動画ファイルが壊れています(書き込みが最後まで終わっていない可能性があります)'
  ],
  [/No space left on device/i, 'ディスクの空き容量が足りません'],
  [/Unknown encoder|Encoder .* not found/i, 'この形式の書き出しに必要な機能が見つかりませんでした'],
  [/Output file .* does not contain any stream/i, '出力に入れる映像・音声がありませんでした']
]

/** 原因が分からないときに残す長さの上限。これ以上出しても読めない。 */
const MAX_DETAIL_LENGTH = 160

function looksLikeFfmpegFailure(message: string): boolean {
  return /(ffmpeg|ffprobe) (exited with code|was killed)/i.test(message)
}

/** 一番最後の「意味のある行」を探す。ffmpeg は本当の原因を末尾に書く。 */
function causeLine(message: string): string {
  const lines = message
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (NOISE.some((re) => re.test(line))) continue
    if (/exited with code|was killed/i.test(line)) continue
    return line.trim()
  }
  return ''
}

/** 先頭の絶対パスを落とす(ファイル名は呼び出し側が既に出している) */
function stripLeadingPath(line: string): string {
  return line.replace(/^(\/|[A-Za-z]:\\)[^\s:]*:\s*/, '')
}

export function describeFfmpegError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  const message = original.message ?? ''
  if (!looksLikeFfmpegFailure(message)) return original

  const cause = causeLine(message)
  for (const [re, text] of KNOWN) {
    if (re.test(cause) || re.test(message)) return new Error(text)
  }
  const detail = stripLeadingPath(cause)
  if (!detail) return new Error('メディアファイルを処理できませんでした')
  return new Error(`メディアファイルを処理できませんでした: ${detail.slice(0, MAX_DETAIL_LENGTH)}`)
}

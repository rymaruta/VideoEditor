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

/**
 * 「出力に入れるストリームが1本も無かった」失敗。
 *
 * 素材から**特定の種類だけを取り出す**経路(BPM解析は音声だけを `-f s16le` へ出す)では、
 * これは道具の失敗ではなく**その素材にその種類が無い**という意味になる。呼び出し側が
 * 素材に即した案内(「音声データを取得できませんでした」)へ倒せるように、
 * 判定をここへ置いて**同じ正規表現を1つだけ持つ**(各所で英文を照合し直さない)。
 */
// 版によって `Output file #0 does not contain any stream`(添字つき)と
// `Output file does not contain any stream`(添字なし・ffmpeg 7)の両方がある。
// **`.*` を挟む形だと添字が無い側に当たらない**——実測でこの表が一度も引けておらず、
// 音声を持たない動画に BPM解析を掛けると
// 「メディアファイルを処理できませんでした: Error opening output files: Invalid argument」
// (65文字・英語混じり)が出ていた。
const NO_OUTPUT_STREAM = /Output file(?: #\d+)? does not contain any stream/i

/**
 * その標準エラー出力が「出力に入れるストリームが無かった」を言っているか。
 * 直に `spawn` した側が、自分の素材に即した案内へ差し替えるかを決めるために使う。
 */
export function isNoOutputStreamFailure(stderr: string): boolean {
  return NO_OUTPUT_STREAM.test(stderr)
}

/** 見慣れた原因は、その場で何をすればよいか分かる日本語に置き換える */
const KNOWN: [RegExp, string][] = [
  [/No such file or directory/i, 'ファイルが見つかりません。移動または削除された可能性があります'],
  [/Permission denied/i, 'ファイルを開く権限がありません'],
  // **「途中で切れた」は「対応していない形式」より先に置く。**
  // 表は上から順に当て、しかも `cause` だけでなく**標準エラー出力の全文**を見るので、
  // 後ろに置くと先に当たった方が勝つ。切れた mp4 は `moov atom not found` と
  // `Invalid data found when processing input` を**両方**出すため、この行が下にあった
  // あいだ**一度も当たっていなかった**——「書き込みが最後まで終わっていない」という
  // 具体的な案内が、誰にも出ないまま表に載っていた。
  // (実測: 8秒の mp4 を 90% / 50% / 0バイトに切って取り込みと解析に掛けると、
  //  4通りとも 22文字「対応していない形式か、ファイルが壊れています」。
  //  上へ移すと 39文字の具体的な案内になる)
  //
  // `End of file` は**行末に限って**当てる。AVERROR_EOF の文言で、切れ方によっては
  // `moov atom not found` ではなくこちらだけが出る(`Error opening input files: End of
  // file`)。語がありふれているので、文中にたまたま出てきただけの行を拾わないよう
  // 行末で縛る。
  [
    /moov atom not found|End of file\s*$/im,
    '動画ファイルが壊れています(書き込みが最後まで終わっていない可能性があります)'
  ],
  [/Invalid data found when processing input/i, '対応していない形式か、ファイルが壊れています'],
  [/No space left on device/i, 'ディスクの空き容量が足りません'],
  [/Unknown encoder|Encoder .* not found/i, 'この形式の書き出しに必要な機能が見つかりませんでした'],
  [NO_OUTPUT_STREAM, '出力に入れる映像・音声がありませんでした']
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

/**
 * `spawn` / `execFile` で**直に**動かした ffmpeg の失敗を日本語にする。
 *
 * `describeFfmpegError` は fluent-ffmpeg が投げるエラー(`ffmpeg exited with code N` +
 * 標準エラー出力)の形を前提にしているので、直に動かした側はここを通すこと。
 * **経路ごとに自前のメッセージを組み立てない**——組み立てた瞬間、その経路だけ
 * 「見慣れた原因を日本語にする」表からも、長さの上限からも外れる。
 *
 * (実測: 同じ「ファイルが見つからない」で、`probeMedia` は **31文字**の
 *  「ファイルが見つかりません。移動または削除された可能性があります」なのに、
 *  文字起こしは `execFile` の失敗がそのまま出て **1,724文字・16行**——
 *  コマンドライン全文と ffmpeg の版数・ビルド設定の羅列まで画面に並んでいた。
 *  ハイライト検出・参考動画の解析・長尺スキャンの3つは自前の文面を組んでおり、
 *  日本語の前置きは付くが英語の生ログがそのまま尾に付いていた(83文字))
 */
export function describeFfmpegExit(code: number | null | undefined, stderr: unknown): Error {
  const tail = typeof stderr === 'string' ? stderr : ''
  return describeFfmpegError(new Error(`ffmpeg exited with code ${code ?? '?'}\n${tail}`))
}

/**
 * @param stderr fluent-ffmpeg の `.on('error', (err, stdout, stderr))` の**第3引数**。
 *   渡すこと。渡さないと、この表の**上のほうの行が丸ごと死ぬ**。
 *
 *   `err.message` に入っているのは **標準エラー出力の末尾2行だけ**で、原因を名指しする
 *   行(`moov atom not found` など)は**その前に出ている**ため入っていない。
 *   直に `spawn` した側(`describeFfmpegExit`)は全文を渡しているので、
 *   **同じ表に通していても、経路によって渡している証拠の量が違う**——結果、
 *   同じファイルなのに押したボタンで診断が変わっていた。
 *   (実測: 途中で切れた mp4 で、`err.message` は **222文字/3行**、
 *    第3引数の標準エラー出力は **1,564文字/16行**。`moov atom not found` は
 *    後者にしか入っていない)
 */
export function describeFfmpegError(err: unknown, stderr?: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  const message = original.message ?? ''
  if (!looksLikeFfmpegFailure(message)) return original

  // 表を当てる相手は「message + 標準エラー出力の全文」。**`cause` は message から取る**
  // ——原因の1行は末尾にあり、そこは `err.message` にも入っているので、
  // 全文から取り直すと分からないときの文面が経路ごとに揺れる。
  const evidence = typeof stderr === 'string' && stderr ? `${message}\n${stderr}` : message
  const cause = causeLine(message)
  for (const [re, text] of KNOWN) {
    if (re.test(cause) || re.test(evidence)) return new Error(text)
  }
  const detail = stripLeadingPath(cause)
  if (!detail) return new Error('メディアファイルを処理できませんでした')
  return new Error(`メディアファイルを処理できませんでした: ${detail.slice(0, MAX_DETAIL_LENGTH)}`)
}

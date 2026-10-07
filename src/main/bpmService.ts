import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpegService'
import { ffSeconds } from './ffArgs'
import { describeFfmpegExit, isNoOutputStreamFailure } from './ffmpegError'
import type { BpmAnalysisResult } from '@shared/types'

const SAMPLE_RATE = 22050
const FRAME_SIZE = 256
const MIN_BPM = 70
const MAX_BPM = 190
const MAX_ANALYZE_SECONDS = 60
const OCTAVE_SCORE_RATIO = 0.65

/**
 * 標準エラー出力から手元に残す長さ。原因の行は**一番最後**にあるので末尾を取る。
 * 読まずに捨てると、失敗の理由がどこにも残らない。
 */
const STDERR_TAIL_LIMIT = 8192

/**
 * 音声を PCM に落とす。**ffmpeg の終了コードを見る。**
 *
 * 見ないと、`close` は失敗でも必ず来るので**取れたバイト数だけ**で判断することになり、
 * 「ファイルが無い」「壊れている」「音声トラックが無い」の**3つの別々の原因が
 * ひとつの案内に潰れる**。しかもその案内は「音声データを取得できませんでした」なので、
 * ファイルが移動しただけの人が**音の問題を疑って探し回る**ことになる。
 * (実測: 存在しないファイル・乱数で埋めた `.mp4`・音声を持たない動画の3つとも
 *  **同じ16文字**。同じ入力で取り込みとハイライト検出は
 *  **31文字「ファイルが見つかりません…」/ 22文字「対応していない形式か…」**を出していた)
 *
 * 変換は**直に `spawn` した側の共通の入口**(`describeFfmpegExit`)を通す。ここで自前の
 * 文面を組むと、その経路だけが「見慣れた原因の表」からも長さの上限からも外れる。
 *
 * **ただし「出力に入れるストリームが無かった」だけは通さない。** 音声だけを取り出す
 * この経路では、それは道具の失敗ではなく**その素材に音が無い**という意味なので、
 * 空の結果として返して呼び出し側の案内(「音声データを取得できませんでした」)に倒す
 * ——ここが今まででいちばん正しく案内できていた1件で、直すついでに壊さない。
 *
 * 範囲が素材より長い・完全に範囲外のときは ffmpeg が**終了コード0**で返す
 * (実測: 12秒の素材に 60秒を要求→0、20秒地点から要求→0・出力0バイト)ので、
 * 今までどおり尺の判定に落ちる。
 */
function decodePcm(filePath: string, start: number, duration: number): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss',
      ffSeconds(start),
      '-t',
      ffSeconds(duration),
      '-i',
      filePath,
      '-f',
      's16le',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-'
    ]
    const proc = spawn(ffmpegPath, args)
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk) => chunks.push(chunk))
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_LIMIT)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0 && !isNoOutputStreamFailure(stderr)) {
        reject(describeFfmpegExit(code, stderr))
        return
      }
      const buf = Buffer.concat(chunks)
      const sampleCount = Math.floor(buf.length / 2)
      const samples = new Int16Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = buf.readInt16LE(i * 2)
      }
      resolve(samples)
    })
  })
}

function computeBpm(samples: Int16Array): BpmAnalysisResult {
  const frameCount = Math.floor(samples.length / FRAME_SIZE)
  const energies = new Float64Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    const base = i * FRAME_SIZE
    for (let j = 0; j < FRAME_SIZE; j++) {
      const s = samples[base + j] / 32768
      sum += s * s
    }
    energies[i] = Math.sqrt(sum / FRAME_SIZE)
  }

  // Onset/flux envelope: emphasizes transients (note attacks, drum hits) rather
  // than raw loudness, which is a better signal to lock a tempo grid onto.
  const flux = new Float64Array(frameCount)
  for (let i = 1; i < frameCount; i++) {
    flux[i] = Math.max(0, energies[i] - energies[i - 1])
  }

  const frameRate = SAMPLE_RATE / FRAME_SIZE
  const minLag = Math.max(1, Math.round((60 / MAX_BPM) * frameRate))
  const maxLag = Math.round((60 / MIN_BPM) * frameRate)

  const fluxMean = flux.reduce((a, b) => a + b, 0) / (flux.length || 1)
  const centered = Float64Array.from(flux, (v) => v - fluxMean)

  const scoreByLag = new Map<number, number>()
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    let count = 0
    for (let i = 0; i + lag < centered.length; i++) {
      sum += centered[i] * centered[i + lag]
      count++
    }
    const normalized = count > 0 ? sum / count : 0
    scoreByLag.set(lag, normalized)
    if (normalized > bestScore) {
      bestScore = normalized
      bestLag = lag
    }
  }

  // Autocorrelation of a periodic beat signal peaks at every integer multiple of
  // the true period, so the strongest peak can land on 2x/3x the real beat
  // interval (a classic "half-tempo" octave error). Prefer the fastest lag among
  // the winner and its divisors whose score is still comparably strong.
  //
  // **強さは1点ではなく、隣り合う3つをまとめて比べる。** lag は整数だが本当の周期は
  // そうとは限らず、間に落ちると相関は**両隣の2つに割れる**。しかもその2倍・3倍は
  // 誤差も2倍・3倍されるので、**遅いほうだけ整数に近く**なって強く出ることがある。
  // 1点で比べると、割れた側（＝本当の速さ）だけが不当に弱く見えて門を通れない。
  // (実測・175BPM のクリック音源: 本当の lag は 29.53 で、lag 29 が最良比 **0.560**、
  //  lag 30 が **0.641**。門は 0.65 なので**どちらも通らず**、2倍の lag 59
  //  (＝87.6BPM) が勝って **88BPM** と答えていた。3つまとめると 29 も 30 も
  //  **0.983** になり、素直に 175 側が選ばれる)
  const lagWindowScore = (lag: number): number =>
    (scoreByLag.get(lag - 1) ?? 0) + (scoreByLag.get(lag) ?? 0) + (scoreByLag.get(lag + 1) ?? 0)

  const originalBestLag = bestLag
  const originalBestWindow = lagWindowScore(originalBestLag)
  let chosenLag = originalBestLag
  for (const divisor of [2, 3]) {
    // 割った先は整数にならないので、**両隣を候補にして、通った中から一番近いほうを採る**。
    // 先に見たほうを即採用すると、`候補 < chosenLag` の条件で**もう片方を見られなくなる**。
    // 割り算は必ず切り捨て側が先に来るので、常に「速すぎるほう」に倒れてしまう。
    // (実測・145BPM のクリック音源: 本当の lag は 35.64 で、lag 35 の強さが 0.516、
    //  lag 36 が **0.912**。近いのは 36 なのに 35 を先に採ってしまい **148BPM**
    //  ——真値より速い側へ 3 も外れていた。近いほうを採れば **144BPM**)
    const candidates = [
      Math.floor(originalBestLag / divisor),
      Math.ceil(originalBestLag / divisor)
    ].filter((c) => c >= minLag && c < chosenLag && scoreByLag.has(c))
    // 門(「まだ十分強いか」)は隣を含めた強さで、**選ぶ**のは1点の強さで。
    // 門は割れに強く、選択は本当の周期に近いほうを採る、と役割を分ける。
    const passing = candidates.filter(
      (c) => lagWindowScore(c) >= originalBestWindow * OCTAVE_SCORE_RATIO
    )
    if (passing.length === 0) continue
    chosenLag = passing.reduce((a, b) =>
      (scoreByLag.get(b) ?? -Infinity) > (scoreByLag.get(a) ?? -Infinity) ? b : a
    )
  }
  bestLag = chosenLag

  // Parabolic interpolation across the winning lag's neighbors for sub-frame precision.
  let refinedLag = bestLag
  const y0 = scoreByLag.get(bestLag - 1)
  const y1 = scoreByLag.get(bestLag)
  const y2 = scoreByLag.get(bestLag + 1)
  if (y0 !== undefined && y1 !== undefined && y2 !== undefined) {
    const denom = y0 - 2 * y1 + y2
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (y0 - y2)) / denom
      if (Math.abs(delta) < 1) refinedLag = bestLag + delta
    }
  }

  const bpm = Math.round((60 * frameRate) / refinedLag)

  const scores = [...scoreByLag.values()]
  const avgScore = scores.reduce((a, b) => a + b, 0) / (scores.length || 1)
  const spread = scores.reduce((sum, s) => sum + Math.abs(s - avgScore), 0) / (scores.length || 1)
  const confidence =
    spread > 0 ? Math.min(1, Math.max(0, (bestScore - avgScore) / (spread * 4))) : 0

  let bestOffsetFrame = 0
  let bestOffsetScore = -Infinity
  for (let i = 0; i < Math.min(bestLag, flux.length); i++) {
    if (flux[i] > bestOffsetScore) {
      bestOffsetScore = flux[i]
      bestOffsetFrame = i
    }
  }

  return {
    bpm,
    confidence,
    offsetSeconds: bestOffsetFrame / frameRate
  }
}

export async function analyzeBpm(
  filePath: string,
  start: number,
  duration: number
): Promise<BpmAnalysisResult> {
  const clampedDuration = Math.min(duration, MAX_ANALYZE_SECONDS)
  // **`< 2` ではなく `>= 2` の否定で見る。** NaN はどちらの比較でも false なので、
  // `< 2` だとこの門を素通りして `-t NaN` のまま ffmpeg へ渡る。終了コードを見るように
  // した今は、それが「メディアファイルを処理できませんでした: Error opening input files:
  // Invalid argument」(64文字・英語混じり)として画面に出てしまう
  // (見ていなかった頃は「音声データを取得できませんでした」に潰れて隠れていた)。
  // 範囲で挟む形にすれば NaN は自然にこの案内へ落ちる。
  if (!(clampedDuration >= 2)) {
    throw new Error('BPM解析には2秒以上の音声が必要です')
  }
  const samples = await decodePcm(filePath, start, clampedDuration)
  if (samples.length < SAMPLE_RATE * 2) {
    throw new Error('音声データを取得できませんでした')
  }
  return computeBpm(samples)
}

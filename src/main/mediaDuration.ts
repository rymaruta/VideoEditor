/**
 * 素材の尺を決める部分。
 *
 * **`ffprobe` が尺を答えないファイルがある。** ブラウザの MediaRecorder や、
 * パイプへ書く録画ソフト(OBS の mkv など)が作るファイルは、書き終わりに戻って
 * ヘッダを埋められないので、コンテナに尺が入っていない。途中で強制終了した録画も同じ。
 * 中身は完全に再生できるのに、尺だけが分からない状態になる。
 */

/**
 * `fluent-ffmpeg` は**値が無いところに文字列 `'N/A'` を入れて**返す。
 * `undefined` ではないので `??` を素通りし、`Number('N/A')` = `NaN` がそのまま外へ出る。
 * 数値として使える値だけを取り出し、それ以外は「無い」と答える。
 */
export function finiteSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * パケットの一覧から尺を求める。行は `pts_time,duration_time` の CSV。
 *
 * **最後の行ではなく最大値を採る。** B フレームがあるとパケットは DTS 順に並ぶので、
 * ファイル末尾のパケットが一番遅い時刻とは限らない。
 * `duration_time` が無い行は、その時刻までは確実にあるものとして `pts_time` だけ使う。
 */
export function durationFromPacketCsv(csv: string): number | null {
  let end = -1
  for (const line of csv.split('\n')) {
    const [ptsRaw, durRaw] = line.split(',')
    const pts = finiteSeconds(ptsRaw)
    if (pts === null) continue
    const dur = finiteSeconds(durRaw) ?? 0
    if (pts + dur > end) end = pts + dur
  }
  return end >= 0 ? end : null
}

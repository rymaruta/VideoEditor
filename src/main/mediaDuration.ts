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

/** ffprobe のストリーム(長さを決めるのに要る所だけ) */
export interface ProbeStreamLike {
  codec_type?: string
  duration?: unknown
  start_time?: unknown
  disposition?: { attached_pic?: number } | Record<string, unknown>
  tags?: Record<string, unknown>
}

/** Matroska のストリームの長さのタグ(`00:03:00.000000000`) */
function tagSeconds(tags: Record<string, unknown> | undefined): number | null {
  if (!tags) return null
  const raw = Object.entries(tags).find(([k]) => k.toUpperCase() === 'DURATION')?.[1]
  if (typeof raw !== 'string') return null
  const m = /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(raw.trim())
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null
}

function isMediaStream(s: ProbeStreamLike): boolean {
  const pic = (s.disposition as { attached_pic?: number } | undefined)?.attached_pic
  return (s.codec_type === 'video' && !pic) || s.codec_type === 'audio'
}

/**
 * 素材の長さ(秒)。分からなければ null。
 *
 * **映像・音声のストリームの終わりで決める。** 同梱の ffprobe(4.0.2)は、入れ物の長さ(`format.duration`)に
 * データ・字幕・チャプターのトラック(m4b のテキストトラックなど)の長さまで含める。180 秒のカメラ素材が
 * 1550 秒として取り込まれ、仮編集が「25分50秒」・末尾の映像が止まっていた。
 * 映像・音声のほかにトラックがあり、映像・音声の長さが分かるときだけ、その終わり(入れ物の頭から)を使う。
 * それ以外(映像・音声だけ・ストリームの長さが分からない)は今までどおり 入れ物 → 映像 → 音声 の順
 *
 * **MP4・MOV のストリームの長さは、ストリームの頭からではなく時刻 0 から数えた値。** 同梱の ffprobe は、
 * 遅れて始まる音声(編集リストの空き)を「開始 1.476・長さ 5.5」と返す(5.5 秒で終わる)。開始を足すと
 * 遅れの分を二重に足して 6.98 秒と長く読んでいた。MP4・MOV では長さそのものを終わりの時刻とする
 */
export function mediaDurationSeconds(
  format: { duration?: unknown; start_time?: unknown; format_name?: unknown } | undefined,
  streams: readonly ProbeStreamLike[]
): number | null {
  const media = streams.filter(isMediaStream)
  const declared =
    finiteSeconds(format?.duration) ??
    finiteSeconds(media.find((s) => s.codec_type === 'video')?.duration) ??
    finiteSeconds(media.find((s) => s.codec_type === 'audio')?.duration)
  if (media.length === streams.length) return declared
  const formatStart = finiteSeconds(format?.start_time) ?? 0
  const fromZero =
    typeof format?.format_name === 'string' && format.format_name.split(',').includes('mov')
  let end: number | null = null
  for (const s of media) {
    const d = finiteSeconds(s.duration) ?? tagSeconds(s.tags)
    if (d === null) continue
    const start = finiteSeconds(s.start_time) ?? formatStart
    // 時刻 0 から数えた長さが頭より短いことは無い。そのときは頭から数えたものとみなす
    const streamEnd = fromZero && d >= start ? d : start + d
    end = Math.max(end ?? 0, streamEnd - formatStart)
  }
  if (end === null || end <= 0) return declared
  return declared === null ? end : Math.min(declared, end)
}

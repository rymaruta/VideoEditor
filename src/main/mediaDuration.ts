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
  nb_frames?: unknown
  avg_frame_rate?: unknown
}

/** 映像の枚数と平均の速さから求めた、絵が続く長さ(秒)。分からなければ null */
function videoFramesSeconds(s: ProbeStreamLike): number | null {
  if (s.codec_type !== 'video') return null
  const frames = finiteSeconds(s.nb_frames)
  const m = typeof s.avg_frame_rate === 'string' ? /^(\d+)\/(\d+)$/.exec(s.avg_frame_rate) : null
  const rate = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 0
  return frames !== null && frames > 0 && rate > 0 ? frames / rate : null
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
  /**
   * 字幕・データのトラックの長さに引っ張られた映像の長さか。編集リストで頭を切った MP4(`-ss 2.4 -c copy`)
   * では、同梱の ffprobe が映像の長さを字幕のトラックと同じ 30 秒と返す(枚数 300・30fps = 10 秒より長く、
   * 実際の最後の絵は 7.57 秒)。枚数と速さから分かる長さより長く、ほかのトラックの長さと同じなら信じない
   */
  const otherLengths = streams
    .filter((s) => !isMediaStream(s))
    .map((s) => finiteSeconds(s.duration) ?? tagSeconds(s.tags))
    .filter((d): d is number => d !== null)
  const pulled = (s: ProbeStreamLike, d: number): boolean => {
    const frames = videoFramesSeconds(s)
    return frames !== null && d > frames + 0.5 && otherLengths.some((o) => Math.abs(o - d) < 0.01)
  }
  const lengthOf = (s: ProbeStreamLike): number | null =>
    finiteSeconds(s.duration) ?? tagSeconds(s.tags)
  // 引っ張られた映像は、ほかの映像・音声の長さが分かればそれで決め、分からなければ枚数と速さの長さで抑える
  const trusted = media.filter((s) => {
    const d = lengthOf(s)
    return d !== null && !pulled(s, d)
  })
  const fromZero =
    typeof format?.format_name === 'string' && format.format_name.split(',').includes('mov')
  let end: number | null = null
  for (const s of media) {
    let d = lengthOf(s)
    if (d === null) continue
    if (pulled(s, d)) {
      if (trusted.length > 0) continue
      d = videoFramesSeconds(s) ?? d
    }
    const start = finiteSeconds(s.start_time) ?? formatStart
    // 時刻 0 から数えた長さが頭より短いことは無い。そのときは頭から数えたものとみなす。
    // 編集リストの無い MP4(-use_editlist 0)の映像は、B フレームの遅れの分だけ頭が 0 でなく、長さは頭から
    // 数えた値(開始 0.08・長さ 8.0 で 8.08 秒まで)。映像の枚数から分かる長さに近いほうで読む
    // (時刻 0 からとすると 2 フレーム短く 7.92 秒と読んでいた)
    const frames = videoFramesSeconds(s)
    const startCounted = frames !== null && Math.abs(d - frames) < Math.abs(d - start - frames)
    const streamEnd = fromZero && d >= start && !startCounted ? d : start + d
    end = Math.max(end ?? 0, streamEnd - formatStart)
  }
  if (end === null || end <= 0) return declared
  return declared === null ? end : Math.min(declared, end)
}

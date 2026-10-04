/**
 * ffprobe のタグから「録画・録音を始めた時刻」を読む(収録フォルダの振り分けと同期の手がかり)。
 *
 * - カメラ(MP4/MOV)は creation_time に日付と時刻が入っている(例: 2024-05-01T01:11:12.000000Z)
 * - BWF の wav(録音機)は日付と時刻が別のタグに入る(origination_date / origination_time。
 *   ffmpeg によっては creation_time に時刻だけ・date に日付だけが入る)ので、つなげて読む
 * - 日付だけの値は 0:00 と読めてしまい、同期の手がかりとして誤るので「分からない」とする
 */

/** タグを大文字小文字を区別せずに引く */
export function tagValue(
  tags: Record<string, string> | undefined,
  ...names: string[]
): string | undefined {
  if (!tags) return undefined
  const lower = Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]))
  for (const n of names) {
    const v = lower[n.toLowerCase()]
    if (v && v.trim()) return v.trim()
  }
  return undefined
}

/** 日付だけ(2024-05-01・2024:05:01・2024/05/01) */
const DATE_ONLY = /^(\d{4})[-:/.](\d{1,2})[-:/.](\d{1,2})$/
/** 時刻だけ(10:11:12・10-11-12・10:11:12.345) */
const TIME_ONLY = /^(\d{1,2})[:\-.](\d{2})[:\-.](\d{2})(\.\d+)?$/
/** 日付と時刻の両方が入っている */
const DATE_TIME = /^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}/

const pad = (s: string): string => s.padStart(2, '0')

function parseDateTime(v: string): number | undefined {
  if (!DATE_TIME.test(v)) return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t / 1000 : undefined
}

/** 日付と時刻をつなげる。どちらかの形が違えば undefined(時差の記載が無いので、その機材の現地時刻として読む) */
function combine(date: string | undefined, time: string | undefined): number | undefined {
  const d = date !== undefined ? DATE_ONLY.exec(date) : null
  const t = time !== undefined ? TIME_ONLY.exec(time) : null
  if (!d || !t) return undefined
  return parseDateTime(
    `${d[1]}-${pad(d[2])}-${pad(d[3])}T${pad(t[1])}:${t[2]}:${t[3]}${t[4] ?? ''}`
  )
}

/** 録画を始めた時刻(秒、Unix 時刻)。分からなければ undefined */
export function recordedAtFromTags(tags: Record<string, string> | undefined): number | undefined {
  const created = tagValue(tags, 'creation_time', 'com.apple.quicktime.creationdate')
  const candidates = [
    created,
    tagValue(tags, 'origination_date'),
    tagValue(tags, 'origination_time'),
    tagValue(tags, 'date'),
    tagValue(tags, 'time')
  ].filter((v): v is string => v !== undefined)

  // 日付と時刻がそろった値がいちばん確か(date タグにそろって入っている機材もある)
  for (const v of candidates) {
    const full = parseDateTime(v)
    if (full !== undefined) return full
  }
  // creation_time が時刻だけ・日付だけなら、ほかのタグの日付・時刻と組み合わせる
  return combine(
    candidates.find((v) => DATE_ONLY.test(v)),
    candidates.find((v) => TIME_ONLY.test(v))
  )
}

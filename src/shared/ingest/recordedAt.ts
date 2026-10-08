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

/** 日付と時刻(区切りは - : / どれでも、時は1桁でも、秒・時差は無くても) */
const DATE_TIME_PARTS =
  /^(\d{4})[-:/](\d{1,2})[-:/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i

function parseDateTime(v: string): number | undefined {
  // 部分ごとに読んで、Date.parse の読める形(2桁にそろえた ISO)に組み直す。
  // そのまま Date.parse に渡すと、「T9:11:12」(時が1桁)・「2024:05:01 10:11:12」(日付の区切りが :)を
  // 読めず、撮影時刻が分からないものとして扱っていた
  const m = DATE_TIME_PARTS.exec(v.trim())
  if (m) {
    const zone = m[8]
      ? /^z$/i.test(m[8])
        ? 'Z'
        : m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
      : ''
    const iso = `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] ?? '00'}${m[7] ?? ''}${zone}`
    const t = Date.parse(iso)
    return Number.isFinite(t) ? t / 1000 : undefined
  }
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

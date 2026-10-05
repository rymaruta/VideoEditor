import { parseTelopMarkup, stripTelopMarkup, telopSourceUnits } from './render'

/**
 * 字幕ファイル(SRT)の書き出し・読み込み。Premiere・DaVinci・YouTube と字幕をやり取りする。
 *
 * - 書き出し: テロップの文字(装飾の印 `**` `__` やルビは外す)を、時刻の順に番号を振って並べる
 * - 読み込み: 番号・時刻・文字のまとまりを読み、`{start,end,text}` にする。SRT の書式タグ(`<i>` など)は外す
 */

/** 秒 → `00:01:02,345` */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`
}

export function buildSrt(
  telops: readonly { text: string; startTime: number; endTime: number }[]
): string {
  return (
    [...telops]
      // ミリ秒に丸めて長さが無くなるもの(読み込むと捨てられる)は書かない
      .filter((t) => stripTelopMarkup(t.text).trim() && srtTime(t.endTime) > srtTime(t.startTime))
      .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
      .map((t, i) => {
        // 字幕の中の空行は字幕の区切りと読まれ、後ろが消えるので詰める
        const body = stripTelopMarkup(t.text)
          .trim()
          .replace(/\r\n?/g, '\n')
          .replace(/\n\s*\n/g, '\n')
          .replace(/\n/g, '\r\n')
        return `${i + 1}\r\n${srtTime(t.startTime)} --> ${srtTime(t.endTime)}\r\n${body}\r\n`
      })
      .join('\r\n')
  )
}

/** `00:01:02,345`(`.` 区切り・時の省略も受ける)→ 秒。読めなければ NaN */
export function parseSrtTime(text: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(text.trim())
  if (!m) return NaN
  const ms = Number(m[4].padEnd(3, '0'))
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + ms / 1000
}

export function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  const lines = text
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  // 字幕は空行で区切る。空行が抜けていても読めるよう、次の「-->」の行の手前でも区切る
  // (その直前の番号だけの行は、次の字幕のもの)
  const cueAt: number[] = []
  lines.forEach((l, i) => {
    if (l.includes('-->')) cueAt.push(i)
  })
  cueAt.forEach((at, k) => {
    let stop = k + 1 < cueAt.length ? cueAt[k + 1] : lines.length
    if (k + 1 < cueAt.length && stop - 1 > at && /^\s*\d+\s*$/.test(lines[stop - 1])) stop--
    // ふつうは空行で終わる(空行の後ろの、時刻の無い壊れたまとまりは読まない)
    const blank = lines.findIndex((l, i) => i > at && i < stop && l.trim() === '')
    if (blank >= 0) stop = blank
    const [a, b] = lines[at].split('-->')
    const start = parseSrtTime(a)
    // 「--> 00:00:02,000 X1:...」のような位置指定は捨てる
    const end = parseSrtTime((b ?? '').trim().split(/\s+/)[0] ?? '')
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return
    const body = lines
      .slice(at + 1, stop)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim()
    if (body) out.push({ start, end, text: body })
  })
  return out
}

/** 検索・置換のオプション */
export interface FindOptions {
  /** 大文字・小文字、全角・半角を区別しない */
  loose?: boolean
}

/** 比べるための形(区別しないときは NFKC + 小文字) */
function norm(s: string, loose: boolean): string {
  return loose ? s.normalize('NFKC').toLowerCase() : s
}

/**
 * 見えている文字(装飾の印 `**` `__`・ルビの読みを外したもの)の並びの中で、探す文字に当たる所。
 * [先頭, 終わり) を見えている文字の番号で返す。区別しないときは、並びを伸ばしながら正規化して比べる
 * (半角の「ｶﾞ」は2文字で「ガ」に、「㍿」は1文字で「株式会社」になる)
 */
function findVisible(units: readonly string[], query: string, loose: boolean): [number, number][] {
  const q = norm(query, loose)
  const out: [number, number][] = []
  let i = 0
  while (i < units.length) {
    let matched = 0
    for (let j = i + 1; j <= units.length; j++) {
      const acc = norm(units.slice(i, j).join(''), loose)
      // 次の文字が濁点などで前の文字とくっつく(「ｶ」+「ﾞ」)なら、ここで切ると別の文字になるので取らない
      const joins =
        loose &&
        j < units.length &&
        norm(units.slice(i, j + 1).join(''), loose) !== acc + norm(units[j], loose)
      if (acc === q && !joins) {
        matched = j
        break
      }
      // 最後の1文字は、後ろの濁点とくっついて変わりうるので除いて比べる
      if (!q.startsWith(acc.slice(0, -1)) || acc.length > q.length + 1) break
    }
    if (matched > i) {
      out.push([i, matched])
      i = matched
    } else i++
  }
  return out
}

/**
 * 本文の中に、探す文字があるか。一覧に見えている文字で探す
 * (「完食まで**3皿**」は「完食まで3皿」で見つかる。印の「*」では見つからない)
 */
export function telopMatches(text: string, query: string, options: FindOptions = {}): boolean {
  if (!query) return false
  const units = parseTelopMarkup(text).map((g) => g.ch)
  return findVisible(units, query, options.loose ?? false).length > 0
}

/**
 * 本文の中の、探す文字をすべて置き換える。見えている文字で探し、装飾の印・ルビの読みは残す
 * (「完食まで**3皿**」の「まで3」を「まで5」にすると「完食まで5**皿**」)
 */
export function replaceInTelop(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions = {}
): string {
  if (!query) return text
  const glyphs = parseTelopMarkup(text).filter((g) => g.src !== undefined)
  const hits = findVisible(
    glyphs.map((g) => g.ch),
    query,
    options.loose ?? false
  )
  if (hits.length === 0) return text
  const units = telopSourceUnits(text)
  for (const [a, b] of hits) {
    units[glyphs[a].src!] = replacement
    for (let k = a + 1; k < b; k++) units[glyphs[k].src!] = ''
  }
  // 中身ごと置き換えて空になった印の組(「****」「____」)は外す(描くと何も出ない)
  return units.join('').replace(/\*\*\*\*|____/g, '')
}

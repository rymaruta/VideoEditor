import { stripTelopMarkup } from './render'

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
  return [...telops]
    .filter((t) => stripTelopMarkup(t.text).trim() && t.endTime > t.startTime)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
    .map(
      (t, i) =>
        `${i + 1}\r\n${srtTime(t.startTime)} --> ${srtTime(t.endTime)}\r\n${stripTelopMarkup(t.text).trim().replace(/\r?\n/g, '\r\n')}\r\n`
    )
    .join('\r\n')
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
  const blocks = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const [a, b] = lines[at].split('-->')
    const start = parseSrtTime(a)
    // 「--> 00:00:02,000 X1:...」のような位置指定は捨てる
    const end = parseSrtTime((b ?? '').trim().split(/\s+/)[0] ?? '')
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    const body = lines
      .slice(at + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim()
    if (body) out.push({ start, end, text: body })
  }
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

/** 本文の中に、探す文字があるか */
export function telopMatches(text: string, query: string, options: FindOptions = {}): boolean {
  if (!query) return false
  return norm(text, options.loose ?? false).includes(norm(query, options.loose ?? false))
}

/**
 * 本文の中の、探す文字をすべて置き換える。区別しないときは、全角・半角の違いを無視して見つけた所を
 * 置き換える(元の文字の位置を保つため、1文字ずつ正規化して比べる)
 */
export function replaceInTelop(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions = {}
): string {
  if (!query) return text
  if (!options.loose) return text.split(query).join(replacement)
  const chars = [...text]
  const normChars = chars.map((c) => norm(c, true))
  const q = norm(query, true)
  let out = ''
  let i = 0
  while (i < chars.length) {
    let acc = ''
    let j = i
    while (j < chars.length && acc.length < q.length && q.startsWith(acc + normChars[j])) {
      acc += normChars[j]
      j++
    }
    if (acc === q && j > i) {
      out += replacement
      i = j
    } else {
      out += chars[i]
      i++
    }
  }
  return out
}

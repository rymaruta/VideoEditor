import type { TextStyle } from '@shared/types'
import { normalizeTextStyle } from '@shared/textStyle'

/**
 * テロップスタイルのファイル(Premiere の .prtextstyle と同じ使い方。番組や編集者の間で
 * テロップの見た目を受け渡す)。中身は JSON: `{ version: 1, styles: [{ name, style }] }`。
 *
 * 読み込みは外から来た値なので、見た目は1つずつ `normalizeTextStyle` で直してから使う。
 */

export const TELOP_STYLE_FILE_VERSION = 1
/** 1つのファイルから読み込むスタイルの上限(壊れた巨大なファイルで固まらないように) */
export const MAX_IMPORT_STYLES = 500

export interface NamedStyle {
  name: string
  style: TextStyle
}

/**
 * 自由配置を外すか。置き場所はテロップごとのものなので外す。ただし縦書きの見た目は、右端に置く
 * 置き場所も見た目の一部(外すと縦の文字が下の真ん中に出た)なので残す
 */
const dropPlacement = (style: TextStyle): TextStyle =>
  style.vertical ? style : { ...style, customPosition: undefined }

/** 書き出す JSON(置き場所はテロップごとのものなので、自由配置は外す。縦書きは残す) */
export function buildStyleFile(styles: readonly NamedStyle[]): string {
  return `${JSON.stringify(
    {
      version: TELOP_STYLE_FILE_VERSION,
      styles: styles.map((s) => ({
        name: s.name,
        style: dropPlacement(s.style)
      }))
    },
    null,
    2
  )}\n`
}

export type ParseStyleFileResult =
  { ok: true; styles: NamedStyle[]; skipped: number } | { ok: false; error: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** ファイルの中身を読む。読めない所は日本語の理由を返す */
export function parseStyleFile(text: string): ParseStyleFileResult {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, error: 'スタイルのファイルとして読めませんでした(JSON の形が壊れています)' }
  }
  // { version, styles: [...] } のほか、配列だけ・スタイル1つだけも受け付ける
  let list: unknown
  if (Array.isArray(raw)) list = raw
  else if (isRecord(raw) && Array.isArray(raw.styles)) {
    if (typeof raw.version === 'number' && raw.version > TELOP_STYLE_FILE_VERSION) {
      return {
        ok: false,
        error: `新しい版(${raw.version})のスタイルのファイルです。アプリを新しくしてから読み込んでください`
      }
    }
    list = raw.styles
  } else if (isRecord(raw) && isRecord(raw.style)) list = [raw]
  else return { ok: false, error: 'テロップスタイルが入っていないファイルです' }

  const items = (list as unknown[]).slice(0, MAX_IMPORT_STYLES)
  const styles: NamedStyle[] = []
  let skipped = Math.max(0, (list as unknown[]).length - items.length)
  items.forEach((item, i) => {
    if (!isRecord(item) || !isRecord(item.style)) {
      skipped++
      return
    }
    const name =
      typeof item.name === 'string' && item.name.trim()
        ? item.name.trim().slice(0, 80)
        : `読み込んだスタイル ${i + 1}`
    styles.push({ name, style: dropPlacement(normalizeTextStyle(item.style)) })
  })
  if (styles.length === 0) return { ok: false, error: 'テロップスタイルが入っていないファイルです' }
  return { ok: true, styles, skipped }
}

/** 名前がかぶらないようにする(「名前 (2)」「名前 (3)」…)。読み込んだもの同士のかぶりも避ける */
export function uniqueStyleNames(
  existing: readonly { name: string }[],
  incoming: readonly NamedStyle[]
): NamedStyle[] {
  const taken = new Set(existing.map((s) => s.name.trim()))
  return incoming.map((s) => {
    const base = s.name.trim() || '名前のないスタイル'
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`
    taken.add(name)
    return { ...s, name }
  })
}

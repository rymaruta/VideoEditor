import { defaultTextStyle, normalizeTextStyle } from '@shared/textStyle'
import type { TextStyle } from '@shared/types'

/**
 * サムネイルの文字の見た目と文。
 *
 * 見た目は番組(チャンネル)で揃えることが多いので、企画をまたいでアプリの設定として覚える。
 * 文は動画ごとに違うので、企画ごとに覚える。
 */

const STYLE_KEY = 've-thumbnail-style'
const TEXT_KEY_PREFIX = 've-thumbnail-text:'

/** はじめのサムネイルの文字(太い丸ゴシック・黄色の文字・黒と白の二重縁。小さく表示されても読める) */
export function defaultThumbnailStyle(): TextStyle {
  return defaultTextStyle({
    fontFamily: 'RocknRoll One',
    fontSize: 150,
    color: '#ffe600',
    bold: true,
    outline: true,
    outlineColor: '#000000',
    outlineWidth: 6,
    extraStrokes: [{ color: '#ffffff', width: 6 }],
    position: 'bottom',
    lineHeight: 1.1,
    // **…** で囲んだ所は赤く大きく(「まさかの」を目立たせる)
    accent: { scale: 1.15, color: '#ff3b3b' }
  })
}

export function readThumbnailStyle(): TextStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY)
    return raw ? normalizeTextStyle(JSON.parse(raw)) : defaultThumbnailStyle()
  } catch {
    return defaultThumbnailStyle()
  }
}

export function writeThumbnailStyle(style: TextStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style))
  } catch {
    // 覚えられなくても今回は使える
  }
}

export function readThumbnailText(projectId: string): string {
  try {
    return localStorage.getItem(TEXT_KEY_PREFIX + projectId) ?? ''
  } catch {
    return ''
  }
}

export function writeThumbnailText(projectId: string, text: string): void {
  try {
    if (text) localStorage.setItem(TEXT_KEY_PREFIX + projectId, text)
    else localStorage.removeItem(TEXT_KEY_PREFIX + projectId)
  } catch {
    // 覚えられなくても今回は使える
  }
}

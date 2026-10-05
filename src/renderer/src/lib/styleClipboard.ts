import { create } from 'zustand'
import type { TextStyle } from '@shared/types'

/**
 * 見た目のクリップボード(Premiere の「属性をコピー / ペースト」)。
 * テロップ・スタイルの管理・サムネイルの文字のどこでコピーしても、どこにでも貼り付けられる。
 * 文字のクリップボードとは別に持つ(本文のコピーを邪魔しない)。アプリを閉じるまで残る。
 */
interface StyleClipboardState {
  style: TextStyle | null
  /** どこからコピーしたか(「水をマレーシアから…」など、貼り付けの欄に見せる) */
  from: string
  copy: (style: TextStyle, from: string) => void
}

export const useStyleClipboard = create<StyleClipboardState>((set) => ({
  style: null,
  from: '',
  copy: (style, from) => set({ style: { ...style }, from })
}))

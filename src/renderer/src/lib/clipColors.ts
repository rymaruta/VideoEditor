import type { ClipColorLabel } from '@shared/types'

export interface ClipColorDef {
  id: ClipColorLabel
  label: string
  color: string
}

// 色の実値はここだけに持つ。タイムラインの帯もインスペクタのスウォッチも同じ一覧から
// 引くので、色を足したときに片方だけ対応が漏れる(型にはあるのに色が付かない)ことがない。
export const CLIP_COLORS: ClipColorDef[] = [
  { id: 'red', label: '赤', color: '#e5484d' },
  { id: 'orange', label: 'オレンジ', color: '#f76b15' },
  { id: 'yellow', label: '黄', color: '#ffb224' },
  { id: 'green', label: '緑', color: '#30a46c' },
  { id: 'blue', label: '青', color: '#3e63dd' },
  { id: 'purple', label: '紫', color: '#8e4ec6' }
]

/** 色ラベルに対応する色。未設定・未知の値なら null(= 帯を出さない) */
export function clipColorOf(label: ClipColorLabel | undefined): string | null {
  if (!label) return null
  return CLIP_COLORS.find((c) => c.id === label)?.color ?? null
}

import type { AutoEditStyle, TransitionType } from '@shared/types'

export const AUTO_EDIT_STYLES: AutoEditStyle[] = [
  'score',
  'jumpcut',
  'story',
  'longtake',
  'mix',
  'director'
]

export const TRANSITION_TYPES: TransitionType[] = ['none', 'crossfade', 'fade', 'wipe']

export const STYLE_LABELS: Record<AutoEditStyle, string> = {
  score: 'ハイライト重視',
  jumpcut: 'ジャンプカット',
  story: 'ストーリー順',
  longtake: 'ロングテイク',
  mix: 'ミックス',
  director: 'AIディレクター'
}

export const STYLE_DESCRIPTIONS: Record<AutoEditStyle, string> = {
  score: 'スコアが高い名シーンだけを厳選したハイライト重視の編集です。',
  jumpcut: '短いカットを連続させたテンポの良いジャンプカット編集です。',
  story: '素材の時系列に沿ったストーリー展開重視の編集です。',
  longtake: 'カットを絞り、じっくり見せるロングテイク編集です。',
  mix: 'スタイルをバランスよく組み合わせたミックス編集です。',
  director: 'Geminiが構成・順番・つなぎ方まで一括で組み立てた編集案です。'
}

export const TRANSITION_LABELS: Record<TransitionType, string> = {
  none: 'カットのみ',
  crossfade: 'クロスフェード',
  fade: 'フェード',
  wipe: 'ワイプ'
}

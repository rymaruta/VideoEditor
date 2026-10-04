import type { TextStyle } from '../types'
import { defaultTextStyle } from '../textStyle'
import { EFFECT_LABEL, effectStyle, type EffectKind } from './effects'

/**
 * テロップの種類の一覧(テロップ図鑑と同じ並び)。
 * 見た目の一覧(プリセット)・「種類から追加」・自動編集の説明が、ここから同じ名前と見本を取る。
 *
 * - `how`: 自動(AI を使わない)/ AI の提案 / 人が置く
 * - `sample`: 見本の文。`**…**` は強調、`__…__` は小さく、改行の前は1行目
 * - `seconds`: 人が置くときの既定の長さ
 */

export type TelopKindId = 'speech' | EffectKind

export interface TelopKindInfo {
  id: TelopKindId
  label: string
  how: 'auto' | 'ai' | 'manual'
  /** どこで・何に使うか(1文) */
  use: string
  sample: string
  seconds: number
  style: () => TextStyle
}

const kind = (
  id: EffectKind,
  how: TelopKindInfo['how'],
  use: string,
  sample: string,
  seconds = 2.5
): TelopKindInfo => ({
  id,
  label: EFFECT_LABEL[id],
  how,
  use,
  sample,
  seconds,
  style: () => effectStyle(id)
})

export const TELOP_KINDS: readonly TelopKindInfo[] = [
  {
    id: 'speech',
    label: '発言テロップ',
    how: 'auto',
    use: '出演者の発言を下に出す(文字起こしから自動)',
    sample: 'ここの水 めっちゃおいしい!',
    seconds: 2.5,
    style: () => defaultTextStyle({ fontSize: 48, outlineWidth: 5, bold: true })
  },
  kind('name', 'auto', '各出演者の最初の発言に名前を出す', '田中 太郎', 3.5),
  kind('laugh', 'auto', '笑い声を検出した所に添える', '(一同爆笑)', 2),
  kind(
    'clock',
    'auto',
    '場面の頭に撮影時刻を出す(天気・気温は書き足す)',
    'AM 10:32 __晴れ 28℃__',
    3
  ),
  kind('chapter', 'auto', '大きな場面の変わり目に章の見出しを出す', '第2章\n島の水事情', 3),
  kind('bubble', 'auto', '短い発言を、話している人の顔の横に吹き出しで', 'えっ ここ?', 2),
  kind('tsukkomi', 'ai', '発言へのひとこと', 'いや早すぎ!'),
  kind('kokoro', 'ai', '話者の内心', '(帰りたい…)'),
  kind('situation', 'ai', '状況の説明', 'ここまで歩いて40分'),
  kind('place', 'ai', '発言に出た地名・店名', '浄土ヶ浜'),
  kind('corner', 'ai', '企画の区切り', '大食いチャレンジ'),
  kind('emphasis', 'ai', '発言の中の印象的な言葉を大きく', 'ヤバい'),
  kind('sfx', 'ai', '場面の空気を音の文字で', 'ドーン!'),
  kind('note', 'ai', '誤解されそうな所の補足', '※撮影時の価格です'),
  kind('translate', 'ai', '外国語の発言の日本語訳', '本当においしい!'),
  kind('dialect', 'ai', '方言・聞き取りにくい発言の意味', '(訳:とってもおいしいね)'),
  kind('teaser', 'ai', '見どころの手前で続きをあおる', 'このあと\nまさかの展開に…!?', 3),
  kind(
    'price',
    'ai',
    '店名・品名・値段の札(値段は人が確かめる)',
    '浄土ヶ浜 海鮮食堂\nうに丼 **2,800円**(税込)',
    4
  ),
  kind(
    'route',
    'ai',
    '移動の「どこからどこへ・どれくらい」',
    '宮古駅 __→ 車で20分 →__ 浄土ヶ浜',
    3.5
  ),
  kind('narration', 'manual', 'ナレーションを明朝で', '一行が向かったのは、島の北端だった。', 4),
  kind('quiz', 'manual', '出演者へのお題・問題', '**Q.** この島の人口は?', 5),
  kind('counter', 'manual', '食べた数・残り時間などを出し続ける', '完食まで**3皿**', 10),
  kind('hand', 'manual', '画の一部を手書きの文字と矢印で指す', 'ここ注目!', 3)
]

export const HOW_LABEL: Record<TelopKindInfo['how'], string> = {
  auto: '自動',
  ai: 'AI が提案',
  manual: '手で置く'
}

export function telopKind(id: TelopKindId): TelopKindInfo | undefined {
  return TELOP_KINDS.find((k) => k.id === id)
}

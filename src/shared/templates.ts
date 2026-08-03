import { EditTemplate } from './types'
import { defaultTextStyle } from './textStyle'

/**
 * Curated short-form editing structures based on commonly observed public
 * conventions (hook-first pacing, jump cuts, list format, etc). These are
 * generic structural templates, not derived from any specific creator's
 * video — no YouTube content is fetched or copied to build this list.
 */
export const editTemplates: EditTemplate[] = [
  {
    id: 'hook-body-cta',
    name: 'フック→本編→CTA',
    description: '最初の3秒で惹きつけ、本編を見せてから行動を促す定番構成。',
    segments: [
      { label: 'フック', durationHint: '0-3秒', suggestion: '結論や驚きの一言を最初に見せる' },
      { label: '本編', durationHint: '3秒-終盤', suggestion: '内容を簡潔にテンポよく見せる' },
      {
        label: 'CTA',
        durationHint: 'ラスト2-3秒',
        suggestion: '「フォロー」「続きは概要欄」等を表示'
      }
    ],
    captionStyle: defaultTextStyle({ fontSize: 42, position: 'top' })
  },
  {
    id: 'jump-cut-fast',
    name: 'ジャンプカット高速テンポ',
    description: '数秒おきにカットを切り替え、テンポよく飽きさせない構成。',
    jumpCutSeconds: 3,
    segments: [
      { label: 'フック', durationHint: '0-2秒', suggestion: '一番インパクトのある場面から開始' },
      {
        label: 'テンポカット',
        durationHint: '2-3秒毎',
        suggestion: '2〜3秒ごとにカットを切り替える'
      }
    ],
    captionStyle: defaultTextStyle({
      fontSize: 44,
      color: '#fff200',
      position: 'bottom',
      animation: 'popIn'
    })
  },
  {
    id: 'before-after',
    name: 'Before/After',
    description: '変化・ビフォーアフターを見せて興味を引く構成。',
    segments: [
      { label: 'Before提示', durationHint: '0-3秒', suggestion: '変化前の状態を見せる' },
      { label: '過程', durationHint: '3秒-終盤前', suggestion: '変化の過程を簡潔に見せる' },
      { label: 'After', durationHint: 'ラスト3-5秒', suggestion: '結果を強調して見せる' }
    ],
    captionStyle: defaultTextStyle({ fontSize: 40, position: 'center' })
  },
  {
    id: 'list-format',
    name: 'リスト形式(3選/5選)',
    description: '「〇選」形式で複数項目を順番に紹介する構成。',
    segments: [
      { label: '導入', durationHint: '0-3秒', suggestion: '「〇〇な3選」など全体像を提示' },
      { label: '項目1〜N', durationHint: '各5-8秒', suggestion: '項目ごとに番号ラベルを表示' },
      { label: 'まとめ', durationHint: 'ラスト2-3秒', suggestion: 'お気に入りはどれかを問いかける' }
    ],
    captionStyle: defaultTextStyle({ fontSize: 40, position: 'top' })
  },
  {
    id: 'storytelling',
    name: 'ストーリーテリング',
    description: '起承転結で共感・驚きを軸に物語形式で見せる構成。',
    segments: [
      { label: '起(導入)', durationHint: '0-4秒', suggestion: '状況設定を短く提示' },
      { label: '承(展開)', durationHint: '4秒-中盤', suggestion: '出来事を順を追って見せる' },
      { label: '転(山場)', durationHint: '中盤-終盤前', suggestion: '一番の見せ場・意外性を配置' },
      { label: '結(締め)', durationHint: 'ラスト', suggestion: '結末とひとことコメントで締める' }
    ],
    captionStyle: defaultTextStyle({ fontSize: 40, position: 'bottom' })
  }
]

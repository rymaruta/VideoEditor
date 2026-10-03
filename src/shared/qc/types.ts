/** 自動確認(計画書 §5.12)で知らせる項目 */
export type QcKind =
  | 'black'
  | 'freeze'
  | 'silence'
  | 'loudness'
  | 'truePeak'
  | 'telopSafe'
  | 'telopFast'
  | 'telopWord'
  | 'telopDictionary'

export interface QcIssue {
  id: string
  kind: QcKind
  /** error: 直すべき / warn: 確かめてほしい */
  severity: 'error' | 'warn'
  /** 完成品(タイムライン)の時刻(秒) */
  start: number
  end: number
  message: string
  /** テロップの項目なら、そのテロップ */
  overlayId?: string
}

export const QC_KIND_LABEL: Record<QcKind, string> = {
  black: '黒味',
  freeze: 'フリーズ',
  silence: '無音',
  loudness: 'ラウドネス',
  truePeak: 'ピーク',
  telopSafe: 'はみ出し',
  telopFast: '表示が短い',
  telopWord: '確認する言葉',
  telopDictionary: '表記'
}

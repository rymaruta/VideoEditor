import type { MediaAsset, TextStyle, TranscriptWord, TransitionType } from '../types'

/**
 * データモデル v2(長尺バラエティ向けの汎用マルチトラック)。
 * 計画書: `docs/VARIETY_AUTO_EDIT_PLAN.md` §4.2
 *
 * v1(`Project.clips` が本編1本・PiP は4隅固定)との違い:
 *
 * - **映像トラックの枚数に上限が無い。** `videoTracks[0]` が一番下(V1)で、後ろほど手前に重なる。
 * - **シーケンス上の時刻は「書き出しの時刻」そのもの**で、**整数のフレーム**で持つ。
 *   v1 は「前から詰めたタイムラインの秒」で置き、書き出し時に繋ぎのぶんを換算していた
 *   (`exportTimeline`)。その換算を移行のときに1回だけ済ませ、以後は換算しない。
 *   長尺(数時間・29.97fps)で秒の小数を足し続けると誤差が積み上がるので、位置はフレームで持つ。
 * - **素材側の時刻(イン点)は秒のまま**。素材ごとにフレームレートが違うため。
 * - 1本のトラックの中でアイテムは重ならない。例外は繋ぎ(`transitionIn`)の重なりだけ。
 */

/** 29.97 を 30000/1001 のように誤差なく表すための有理数 */
export interface Rational {
  num: number
  den: number
}

export interface Sequence {
  width: number
  height: number
  fps: Rational
  /** 下から順。`[0]` が V1 */
  videoTracks: VideoTrack[]
  audioTracks: SequenceAudioTrack[]
}

export interface VideoTrack {
  id: string
  name: string
  hidden: boolean
  items: VideoItem[]
}

export interface SequenceAudioTrack {
  id: string
  name: string
  muted: boolean
  /** トラック全体の音量(倍率) */
  volume: number
  duckingEnabled: boolean
  /** 出演者の声のトラック(ダッキングの基準に数える) */
  voice?: boolean
  items: AudioItem[]
}

export interface ItemBase {
  id: string
  /** シーケンス上の開始(フレーム) */
  startFrame: number
  /** シーケンス上の長さ(フレーム、1以上) */
  durationFrames: number
  /** 自動生成か人の修正か。再計算は `manual` を上書きしない(計画書 §5.13) */
  origin: 'auto' | 'manual'
  /** 自動生成したときの自信度(0〜1)。レビュー対象の抽出に使う */
  confidence?: number
}

/** 画面のどこにどの大きさで置くか */
export type Placement =
  | {
      /** 画面いっぱいの枠に収める(本編の置き方) */
      kind: 'frame'
      /** `contain` は余白あり(黒帯 or ぼかし背景)、`cover` ははみ出しを切る */
      fit: 'contain' | 'cover'
      cropCenter?: { x: number; y: number }
      blurBackground?: boolean
    }
  | {
      /** 画面の隅を基準にした箱(ワイプの置き方) */
      kind: 'box'
      anchor: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
      /** 隅からの距離。**フレームの幅**に対する比(上下も幅基準。`pipLayout` と同じ規則) */
      margin: number
      /** 箱の幅。フレームの幅に対する比。高さは素材の縦横比から決まる */
      width: number
    }

export interface SequenceTransition {
  type: Exclude<TransitionType, 'none'>
  /** 手前のアイテムと重なっているフレーム数 */
  durationFrames: number
}

export interface MediaItem extends ItemBase {
  kind: 'media'
  assetId: string
  /** 素材の秒 */
  sourceIn: number
  speed: number
  placement: Placement
  /** 手前のアイテムとこのフレーム数だけ重ねて繋ぐ */
  transitionIn?: SequenceTransition
  colorLabel?: string
}

export interface TelopItem extends ItemBase {
  kind: 'telop'
  text: string
  /** 当面は v1 のスタイルをそのまま持つ(共通テロップレンダラは計画書 §4.4) */
  style: TextStyle
  /** 単語ごとの時刻。**アイテムの開始からの秒** */
  words?: TranscriptWord[]
  /**
   * 重なったときの描く順(小さいほど下)。v1 のテロップの並び順で、プレビューと同じ。
   * 段(トラック)は空いた段を使い回すので、段の順では重なりの上下がプレビューと食い違う
   */
  z?: number
  /**
   * 消える動き(フェードアウトなど)の基準になる終わりのフレーム。本編の終わりで切ったテロップは、
   * 切る前の終わり(プレビューと同じ)を持つ。無ければアイテムの終わり
   */
  motionEndFrame?: number
}

export type VideoItem = MediaItem | TelopItem

export interface AudioItem extends ItemBase {
  kind: 'audio'
  assetId: string
  sourceIn: number
  /**
   * 素材の秒の終わり(クリップの出点)。長さはフレーム数に丸めるので、丸めで伸びたぶんは
   * 出点の先の音を読まず無音にする(読むと、切った先の音が最大半フレーム漏れる)
   */
  sourceOut?: number
  speed: number
  /** クリップの音量(倍率)。未設定は等倍 */
  volume?: number
  fadeInFrames?: number
  fadeOutFrames?: number
  /** 一緒に動く映像アイテム(本編の音・分離した音) */
  linkedItemId?: string
}

export interface ProjectV2 {
  version: 2
  id: string
  name: string
  sequence: Sequence
  /** 素材の一覧は v1 と同じ形 */
  assets: MediaAsset[]
}

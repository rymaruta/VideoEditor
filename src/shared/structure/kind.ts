import type { SceneOptions } from './scenes'
import type { TightenOptions } from '../cut/tighten'

/**
 * 番組の種類。種類によって、場面の分け方・面白い所の判定・間の詰め方を変える
 * (`docs/GAME_AUTO_EDIT_PLAN.md`)。
 */
export type EpisodeKind = 'location' | 'game'

export const EPISODE_KINDS: readonly EpisodeKind[] = ['location', 'game']

export const EPISODE_KIND_LABEL: Record<EpisodeKind, string> = {
  location: 'ロケ・バラエティ',
  game: 'ゲーム実況'
}

export interface KindProfile {
  /** 場面の分け方 */
  scene: SceneOptions
  /** 長い無音を絵として残す長さ(`tightenRanges` の insert…) */
  insert: Pick<TightenOptions, 'insertMinSec' | 'insertBaseSec' | 'insertRate' | 'insertMaxSec'>
  /** 「面白い所だけ」のとき、場面の中を山(叫び・笑い)の前後だけに絞る */
  peakWindows: boolean
}

export const KIND_PROFILES: Record<EpisodeKind, KindProfile> = {
  location: { scene: {}, insert: {}, peakWindows: false },
  game: {
    // 実況の山は数十秒で終わる。ロケ(最長 90 秒)の大きさで分けると、山と黙々とプレイする所が
    // 同じ場面に入り、残すか落とすかを細かく選べない
    scene: { joinGapSec: 3, maxSceneSec: 45, quietSec: 6 },
    // 声の無いプレイの絵はロケの料理の寄りと違い、見せ場でないことが多い。残すのは短く
    insert: { insertMinSec: 3, insertBaseSec: 0.8, insertRate: 0.1, insertMaxSec: 2 },
    // 実況は話し続けるので、山のある場面を丸ごと残すと落ち着いた解説も一緒に残る
    peakWindows: true
  }
}

/**
 * 編集の方針(何を一番大事にするか)。番組の種類とは別に選ぶ。
 * - highlights: 面白い所だけ残す(盛り上がりの無い場面は、長さを決めなくても落とす)
 * - tempo: 不要な場面を落とし、間を詰めてテンポよく(ロケの今までの動き)
 * - light: 場面は落とさず、長い無言だけを詰める(配信アーカイブの軽い整え)
 */
export type EditPolicy = 'highlights' | 'tempo' | 'light'

export const EDIT_POLICIES: readonly EditPolicy[] = ['highlights', 'tempo', 'light']

export const EDIT_POLICY_LABEL: Record<EditPolicy, string> = {
  highlights: '面白い所だけ',
  tempo: 'テンポよく',
  light: '軽く整える'
}

export const EDIT_POLICY_HINT: Record<EditPolicy, string> = {
  highlights: '叫び・笑い・掛け合いのある所だけを残し、盛り上がりの無い所は落とします',
  tempo: '不要な場面(移動・待機・黙々とプレイ)を落とし、間を詰めてテンポよくします',
  light: '場面は落とさず、長い無言(ロード・離席など)だけを詰めます。配信アーカイブ向け'
}

/** 番組の種類ごとの、方針の既定 */
export const DEFAULT_POLICY: Record<EpisodeKind, EditPolicy> = {
  location: 'tempo',
  game: 'highlights'
}

export interface PolicyProfile {
  /** 仕上がりの長さを決めないときに残す点数の下限(見どころは必ず残す) */
  minScoreWithoutTarget: number
  /** 「不要」の場面を落とす */
  dropUnneeded: boolean
  /** 仕上がりの長さに合わせて場面を落とす */
  useTarget: boolean
  /** 間の詰め方(未指定は番組スタイル・既定値) */
  tighten?: Pick<TightenOptions, 'maxPauseSec' | 'keepPauseSec' | 'insertMinSec'>
}

export const POLICY_PROFILES: Record<EditPolicy, PolicyProfile> = {
  highlights: { minScoreWithoutTarget: 50, dropUnneeded: true, useTarget: true },
  tempo: { minScoreWithoutTarget: -Infinity, dropUnneeded: true, useTarget: true },
  // 話している途中の短い間は残し、3 秒を超える無言だけを 1 秒に詰める
  light: {
    minScoreWithoutTarget: -Infinity,
    dropUnneeded: false,
    useTarget: false,
    tighten: { maxPauseSec: 3, keepPauseSec: 1, insertMinSec: Infinity }
  }
}

export function isEditPolicy(v: unknown): v is EditPolicy {
  return typeof v === 'string' && (EDIT_POLICIES as readonly string[]).includes(v)
}

export function isEpisodeKind(v: unknown): v is EpisodeKind {
  return typeof v === 'string' && (EPISODE_KINDS as readonly string[]).includes(v)
}

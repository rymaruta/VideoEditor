import type { SourceKind } from '../ingest/classify'
import type { Placement, SyncIssue } from './solve'

/** 同期にかける素材1本 */
export interface SyncInputFile {
  id: string
  path: string
  sourceId: string
  sourceKind: SourceKind
  duration: number
  recordedAt?: number
  /** 解析結果の使い回しの判定に使う(同じ大きさ・更新時刻なら同じファイル) */
  size: number
  mtimeMs: number
}

/** 音で比べた1組の結果 */
export interface SyncPairResult {
  a: string
  b: string
  /** b の頭が a の頭から何秒後か(細かく詰めた後の値) */
  offset: number
  confidence: number
  distinctness: number
  /** 重なっている長さ(秒) */
  overlap: number
  /** 一致を信じてよいか(基準は sync/correlate の MIN_CONFIDENCE ほか) */
  reliable: boolean
  /** 波形で細かく詰められたか */
  refined: boolean
  /** 時計の進み方の差(百万分率)。重なりが長いときだけ測る。+ なら b の時計が速い */
  driftPpm?: number
  /** a の時計で1秒進む間に、b の時計が何秒進むか(1 + ドリフト)。測れたときだけ */
  rate?: number
  /** offset を測った位置(a の時刻、秒)。時計のずれの補正に使う */
  center?: number
}

export interface SyncReport {
  placements: Placement[]
  issues: SyncIssue[]
  pairs: SyncPairResult[]
  elapsedMs: number
}

export type SyncWorkerMessage =
  | { type: 'progress'; percent: number; stage: string }
  | { type: 'done'; report: SyncReport }
  | { type: 'error'; message: string }

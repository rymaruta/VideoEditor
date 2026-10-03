import type { SourceKind } from '../ingest/classify'

/**
 * 同期した収録素材の情報(企画に保存する)。仮編集(構成・カット・アングルの切り替え)は
 * これと文字起こしから何度でも作り直せる。
 *
 * 時刻は「共通の時間軸」= 基準カメラの時計の秒。素材の時刻 = (共通の時刻 - start) × rate。
 */
export interface MulticamSource {
  id: string
  name: string
  kind: SourceKind
  /** カメラが主に映している出演者(マイクの名前と同じ)。全体を映すカメラは undefined */
  subject?: string
}

export interface MulticamFile {
  assetId: string
  sourceId: string
  start: number
  rate: number
  duration: number
}

export interface MulticamInfo {
  anchorSourceId: string
  sources: MulticamSource[]
  files: MulticamFile[]
}

/** 共通の時刻 t を録っている、その機材の素材(無ければ null) */
export function fileAt(info: MulticamInfo, sourceId: string, t: number): MulticamFile | null {
  for (const f of info.files) {
    if (f.sourceId !== sourceId) continue
    if (t >= f.start - 1e-6 && t < f.start + f.duration / f.rate) return f
  }
  return null
}

/** 素材の時刻 → 共通の時刻 */
export function toCommon(f: MulticamFile, sourceTime: number): number {
  return f.start + sourceTime / f.rate
}

/** 共通の時刻 → 素材の時刻 */
export function toSource(f: MulticamFile, commonTime: number): number {
  return (commonTime - f.start) * f.rate
}

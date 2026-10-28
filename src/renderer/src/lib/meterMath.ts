/**
 * プログラムの音量計(縦の 2ch)の計算。目盛りは 0〜−60 dBFS の dB で直線。
 * −6 dBFS から黄、−3 dBFS から赤。ピークは少し留めてから落とす(ピークホールド)。
 */

export const METER_FLOOR_DB = -60
export const METER_WARN_DB = -6
export const METER_OVER_DB = -3
/** ピークを留める時間(ミリ秒) */
export const PEAK_HOLD_MS = 1500
/** 留めたあとのピークの落ち方(dB/秒) */
export const PEAK_FALL_DB_PER_SEC = 20
/** 棒の落ち方(dB/秒)。上がるのはすぐ */
export const BAR_FALL_DB_PER_SEC = 30

/** 振幅(0〜1。1 = 0 dBFS)を dBFS に。無音は −Infinity */
export function toDbfs(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return -Infinity
  return 20 * Math.log10(linear)
}

/** 目盛りの上での高さ(0〜1)。−60 dBFS 以下は 0、0 dBFS 以上は 1 */
export function meterFraction(db: number): number {
  if (!(db > METER_FLOOR_DB)) return 0
  if (db >= 0) return 1
  return (db - METER_FLOOR_DB) / -METER_FLOOR_DB
}

export type MeterZone = 'ok' | 'warn' | 'over'

/** 色の帯: −6 dBFS から黄、−3 dBFS から赤 */
export function meterZone(db: number): MeterZone {
  if (db >= METER_OVER_DB) return 'over'
  if (db >= METER_WARN_DB) return 'warn'
  return 'ok'
}

/** 棒の次の値。上がるのはすぐ、下がるのは `BAR_FALL_DB_PER_SEC` で */
export function nextBarDb(previousDb: number, inputDb: number, dtMs: number): number {
  if (inputDb >= previousDb || !Number.isFinite(previousDb)) return inputDb
  const fallen = previousDb - (BAR_FALL_DB_PER_SEC * Math.max(0, dtMs)) / 1000
  const next = Math.max(inputDb, fallen)
  return next <= METER_FLOOR_DB ? -Infinity : next
}

export interface PeakHold {
  /** 留めているピーク(dBFS) */
  db: number
  /** そのピークを付けた時刻(ミリ秒) */
  at: number
}

/** 今見せるピークの高さ(dBFS)。`PEAK_HOLD_MS` は留め、そのあと `PEAK_FALL_DB_PER_SEC` で落とす */
export function peakHoldDisplay(hold: PeakHold, now: number): number {
  if (!Number.isFinite(hold.db)) return -Infinity
  const over = now - hold.at - PEAK_HOLD_MS
  const db = over <= 0 ? hold.db : hold.db - (PEAK_FALL_DB_PER_SEC * over) / 1000
  return db <= METER_FLOOR_DB ? -Infinity : db
}

/** ピークホールドの次の値。今見せている高さ以上が来たら付け直す */
export function nextPeakHold(previous: PeakHold, inputDb: number, now: number): PeakHold {
  if (inputDb >= peakHoldDisplay(previous, now) && Number.isFinite(inputDb))
    return { db: inputDb, at: now }
  return previous
}

/** 波形の窓の中の最大の振幅(0 以上) */
export function peakOf(samples: ArrayLike<number>): number {
  let m = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > m) m = v
  }
  return m
}

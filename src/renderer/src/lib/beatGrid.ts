/**
 * ビートグリッドの BPM / オフセットを手で直すための、入力の解釈とクランプ。
 *
 * 検出は外すことがある(実測: 140BPM の素材が 70BPM = ちょうど半分のオクターブ誤り)ので、
 * 利用者が値を打ち直せる必要がある。ここは「打ち込んだ文字列 → 数値」だけを担当し、
 * **打っている途中で値を丸めない**(丸めるのは確定時に呼び出し側が `clampBpm` を使う)。
 */

// 入力欄の min/max と必ず揃えること。20 未満・300 超はビートとして使い物にならず、
// 間隔が3秒を超える/0.2秒を切るのでグリッド線としても意味を成さない。
export const BPM_MIN = 20
export const BPM_MAX = 300

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return BPM_MIN
  return Math.min(BPM_MAX, Math.max(BPM_MIN, bpm))
}

/**
 * 打ち込み中の BPM 文字列を解釈する。**クランプはしない。**
 * ストアへ流せない値(空・数値でない・0以下)のときは `null` を返し、
 * 呼び出し側は「ストアを更新しない = 直前の値のまま」にする。
 * ここでクランプすると、制御された入力欄では打った桁がその場で跳ねて別の数字になる。
 */
export function parseBpmInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * 打ち込み中のオフセット(秒)を解釈する。負の値も有効
 * (最初のビートが素材の頭より前にあることは普通にある)。
 */
export function parseOffsetInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === '.' || trimmed === '-.') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return null
  return value
}

/**
 * オクターブ誤り(半分・2倍)の直し。範囲に収まらない場合は `null` を返すので、
 * 呼び出し側はボタンを無効にできる(押せるのに何も起きない、を作らない)。
 * クランプで丸めて通さないのは、70→140 のつもりが 300 に化けると
 * 直したはずのグリッドが別物になるため。
 */
export function scaleBpm(bpm: number, factor: number): number | null {
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  const scaled = bpm * factor
  if (!Number.isFinite(scaled) || scaled < BPM_MIN || scaled > BPM_MAX) return null
  return scaled
}

/** 表示用。検出値は整数だが、半分にすると 49.5 のような値になるので小数2桁まで見せる。 */
export function formatBpm(bpm: number): string {
  if (!Number.isFinite(bpm)) return ''
  return String(Math.round(bpm * 100) / 100)
}

/** 表示用。秒は3桁(ms)まで。 */
export function formatOffset(seconds: number): string {
  if (!Number.isFinite(seconds)) return ''
  return String(Math.round(seconds * 1000) / 1000)
}

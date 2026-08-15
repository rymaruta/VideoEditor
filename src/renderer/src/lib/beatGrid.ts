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

/**
 * BPM 解析の結果を、**タイムラインの目盛り**へ直す。
 *
 * 解析が返すのは**素材の秒**での BPM とオフセット(`bpmService` は素材を復号して数える)。
 * ビートグリッドは**タイムラインの秒**に線を引き、スナップもそこで効くので、
 * 速度を変えたクリップでは倍率ぶん食い違う。
 * - 速度2倍のクリップは**2倍の速さで聞こえる**ので、線も2倍細かく引く必要がある。
 * - オフセットは素材の頭からの秒数なので、タイムラインでは速度で割る。
 *
 * (実測: 120BPM(0.5秒ごと)のクリック音源を分離して速度2倍にし、解析ボタンを押すと、
 *  グリッドは **120BPM・オフセット 0.4876秒**。ところが書き出して測った実際のクリックは
 *  **0.2499秒間隔 = 240.1BPM**、最初のクリックは **0.2368秒**——線は**1つおきにしか
 *  合わず**、スナップも半分のビートにしか吸着しなかった)
 *
 * BPM は入力欄と同じ範囲へ収める。ここで収めておかないと、欄に出る数字(例 480)と
 * 実際に引かれる線(描画側が `clampBpm` する = 300)が食い違う。
 * 速度が等倍のときは `clampBpm(検出値)` で、検出値は 70〜190 なので**素通し**になる。
 */
export function beatGridFromAnalysis(
  analysis: { bpm: number; offsetSeconds: number },
  clip: { startTime: number; speed?: number }
): { bpm: number; offsetSeconds: number } {
  const speed =
    Number.isFinite(clip.speed) && (clip.speed as number) > 0 ? (clip.speed as number) : 1
  const offset = Number.isFinite(analysis.offsetSeconds) ? analysis.offsetSeconds : 0
  const start = Number.isFinite(clip.startTime) ? clip.startTime : 0
  return {
    bpm: clampBpm(analysis.bpm * speed),
    offsetSeconds: start + offset / speed
  }
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

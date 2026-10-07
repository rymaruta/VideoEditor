/**
 * ピンマイクの音量で「いつ・誰が話しているか」を決める(計画書 §5.4)。
 *
 * ピンマイクは付けた本人の声がいちばん大きく入り、ほかの人の声は「かぶり」として小さく入る
 * (たいてい 15〜25dB 小さい)。そこで、各マイクの音量を「そのマイクで話しているときの普段の大きさ」で
 * 割りそろえ、いちばん大きいマイクの持ち主を話者とする。2本が近い大きさで鳴っていれば、
 * 掛け合いで声が重なっているとみなし、両方を残す(両者のテロップを出すため)。
 *
 * 入力の包絡線は共通の時間軸(同期の結果)に並べ直したもの(100Hz、無音や録っていない所は 0)。
 */

export const TURN_RATE = 100

export interface MicTrack {
  id: string
  /** 共通の時間軸の 10ms ごとの音の大きさ(RMS)。録っていない所は NaN */
  envelope: Float32Array
}

export interface SpeechTurn {
  micId: string
  /** 共通の時間軸の秒 */
  start: number
  end: number
  /** ほかのマイクの持ち主と声が重なっている */
  overlap: boolean
}

export interface TurnOptions {
  /** 持ち主とみなす差(dB)。これより近ければ重なり */
  marginDb?: number
  /** これより短い切れ目はつなぐ(秒) */
  joinGapSec?: number
  /** これより短い発話は捨てる(秒) */
  minTurnSec?: number
  /** 前後に足す余白(秒)。言い始め・言い終わりを切らないため */
  padSec?: number
  /** 1つの発話の上限(秒)。音声認識は30秒ずつしか見ないので、それより短く切る */
  maxTurnSec?: number
}

function percentile(values: Float32Array, p: number): number {
  const sorted = Float32Array.from(values).sort()
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/** 0.2 秒の移動平均(dB)。録っていない所は NaN のまま */
function smoothDb(envelope: Float32Array): Float32Array {
  const n = envelope.length
  const db = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = envelope[i]
    db[i] = Number.isNaN(v) ? NaN : 20 * Math.log10(v + 1e-6)
  }
  const half = 10
  const out = new Float32Array(n)
  let sum = 0
  let cnt = 0
  for (let i = 0; i < Math.min(n, half); i++) {
    if (!Number.isNaN(db[i])) {
      sum += db[i]
      cnt++
    }
  }
  for (let i = 0; i < n; i++) {
    const add = i + half
    if (add < n && !Number.isNaN(db[add])) {
      sum += db[add]
      cnt++
    }
    const drop = i - half - 1
    if (drop >= 0 && !Number.isNaN(db[drop])) {
      sum -= db[drop]
      cnt--
    }
    out[i] = Number.isNaN(db[i]) || cnt === 0 ? NaN : sum / cnt
  }
  return out
}

interface MicStats {
  id: string
  db: Float32Array
  /** 静かなときの大きさ */
  floor: number
  /** 話しているときの普段の大きさ */
  speech: number
  /** 声があると判断する大きさ */
  threshold: number
}

function statsOf(track: MicTrack): MicStats | null {
  const db = smoothDb(track.envelope)
  const valid = db.filter((v) => !Number.isNaN(v))
  if (valid.length < TURN_RATE) return null
  const floor = percentile(valid, 0.1)
  const loud = percentile(valid, 0.95)
  // 静かな所と大きな所の間の 4 割の高さを「声がある」とする(最低でも静かな所より 8dB 上)
  const threshold = floor + Math.max(8, (loud - floor) * 0.4)
  const speechFrames = valid.filter((v) => v >= threshold)
  const speech = speechFrames.length > 0 ? percentile(speechFrames, 0.5) : loud
  return { id: track.id, db, floor, speech, threshold }
}

/**
 * どれかのマイクで音が鳴っている所(声・笑い・リアクション)を 1、静かな所を 0 にする(100Hz)。
 * カットで間を詰めるときに使う。話者は問わない
 */
export function activityMask(tracks: readonly MicTrack[]): Uint8Array {
  const stats = tracks.map(statsOf).filter((s): s is MicStats => s !== null)
  const n = Math.max(0, ...stats.map((s) => s.db.length))
  const out = new Uint8Array(n)
  for (const st of stats) {
    for (let t = 0; t < st.db.length; t++) {
      const v = st.db[t]
      if (!Number.isNaN(v) && v >= st.threshold) out[t] = 1
    }
  }
  return out
}

/** 各時刻の持ち主(複数なら重なり)を決め、マイクごとの発話区間にする */
export function detectTurns(tracks: readonly MicTrack[], options: TurnOptions = {}): SpeechTurn[] {
  const margin = options.marginDb ?? 6
  const joinGap = Math.round((options.joinGapSec ?? 0.4) * TURN_RATE)
  const minTurn = Math.round((options.minTurnSec ?? 0.25) * TURN_RATE)
  const pad = Math.round((options.padSec ?? 0.15) * TURN_RATE)
  const maxTurn = Math.round((options.maxTurnSec ?? 25) * TURN_RATE)

  const stats = tracks.map(statsOf).filter((s): s is MicStats => s !== null)
  if (stats.length === 0) return []
  const n = Math.max(...stats.map((s) => s.db.length))

  // マイクごと・時刻ごとの「持ち主として話している / 重なりで話している」
  const owned = stats.map(() => new Uint8Array(n))
  const overlapped = stats.map(() => new Uint8Array(n))
  for (let t = 0; t < n; t++) {
    let best = -1
    let bestRel = -Infinity
    let secondRel = -Infinity
    let second = -1
    for (let m = 0; m < stats.length; m++) {
      const v = stats[m].db[t]
      if (v === undefined || Number.isNaN(v) || v < stats[m].threshold) continue
      const rel = v - stats[m].speech
      if (rel > bestRel) {
        secondRel = bestRel
        second = best
        bestRel = rel
        best = m
      } else if (rel > secondRel) {
        secondRel = rel
        second = m
      }
    }
    if (best < 0) continue
    owned[best][t] = 1
    // 2番目も「その人が話しているときの普段の大きさ」に近ければ、2人とも話している
    if (second >= 0 && bestRel - secondRel < margin && secondRel > -margin) {
      owned[second][t] = 1
      overlapped[best][t] = 1
      overlapped[second][t] = 1
    }
  }

  const turns: SpeechTurn[] = []
  for (let m = 0; m < stats.length; m++) {
    const on = owned[m]
    // 短い切れ目をつなぐ
    let lastOn = -Infinity
    for (let t = 0; t < n; t++) {
      if (on[t]) {
        if (t - lastOn > 1 && t - lastOn <= joinGap) for (let k = lastOn + 1; k < t; k++) on[k] = 1
        lastOn = t
      }
    }
    // 区間にする(長すぎるものは、いちばん静かな所で切る)
    let t = 0
    while (t < n) {
      if (!on[t]) {
        t++
        continue
      }
      let end = t
      while (end < n && on[end]) end++
      const pieces: [number, number][] = []
      let s = t
      while (end - s > maxTurn) {
        // 後ろ 4割の中で一番静かな位置
        let cut = s + maxTurn
        let quiet = Infinity
        for (let k = s + Math.floor(maxTurn * 0.6); k < s + maxTurn; k++) {
          const v = stats[m].db[k]
          if (!Number.isNaN(v) && v < quiet) {
            quiet = v
            cut = k
          }
        }
        pieces.push([s, cut])
        s = cut
      }
      pieces.push([s, end])
      for (const [a, b] of pieces) {
        if (b - a < minTurn) continue
        let ov = 0
        for (let k = a; k < b; k++) ov += overlapped[m][k]
        turns.push({
          micId: stats[m].id,
          start: Math.max(0, a - pad) / TURN_RATE,
          end: Math.min(n, b + pad) / TURN_RATE,
          overlap: ov >= minTurn
        })
      }
      t = end
    }
  }
  return turns.sort((x, y) => x.start - y.start || x.micId.localeCompare(y.micId))
}

/**
 * 素材の包絡線(素材の時計、100Hz)を、共通の時間軸の格子に並べ直す。
 * `start` は共通の時間軸での素材の頭、`rate` は共通の時間軸1秒あたりに素材の時計が進む秒。
 */
export function placeEnvelope(
  source: Float32Array,
  start: number,
  rate: number,
  length: number,
  into?: Float32Array
): Float32Array {
  const out = into ?? new Float32Array(length).fill(NaN)
  for (let i = 0; i < length; i++) {
    const fileHop = Math.round((i / TURN_RATE - start) * rate * TURN_RATE)
    if (fileHop >= 0 && fileHop < source.length) out[i] = source[fileHop]
  }
  return out
}

/**
 * 同じ人の声を拾っている2本のマイクか(声のある時刻がほとんど同じ)。
 * ゲーム実況で、OBS の「マイク」のトラックと Craig のその人のファイルの両方を使うと、同じ声が
 * 2本のマイクに入る。そのまま話者を決めると、発言がすべて2回(2人分)になる。
 * 声のある時刻(マイクごとの「声がある」高さ以上)の重なり具合(共通 ÷ どちらか)で見る
 */
export function sameVoice(a: MicTrack, b: MicTrack, minOverlap = 0.6): boolean {
  const sa = statsOf(a)
  const sb = statsOf(b)
  if (!sa || !sb) return false
  const n = Math.min(sa.db.length, sb.db.length)
  let both = 0
  let either = 0
  for (let t = 0; t < n; t++) {
    const va = sa.db[t]
    const vb = sb.db[t]
    if (Number.isNaN(va) || Number.isNaN(vb)) continue
    const on1 = va >= sa.threshold
    const on2 = vb >= sb.threshold
    if (on1 || on2) either++
    if (on1 && on2) both++
  }
  // 声のある時間が短すぎる(数秒)なら決めない
  return either >= 5 * TURN_RATE && both / either >= minOverlap
}

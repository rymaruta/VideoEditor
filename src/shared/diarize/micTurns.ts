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
  /**
   * NaN のうち「録っていない」ではなく「ほかの人が話している所を伏せた」時刻(1 = 伏せた。全部入りの残り)。
   * 伏せた時刻は、止まったマイクとして扱わない(録っていない時刻は今までどおり止まったマイク)
   */
  maskedFrames?: Uint8Array
}

export interface SpeechTurn {
  micId: string
  /** 共通の時間軸の秒 */
  start: number
  end: number
  /** ほかのマイクの持ち主と声が重なっている */
  overlap: boolean
  /**
   * 持ち主の声か分からない(ほかのマイクが録っていない時間に、持ち主の普段の声よりずっと小さく
   * 入っただけ)。止まったマイクの持ち主の声の回り込みかもしれないので、話者の名前を付けない
   */
  uncertain?: boolean
}

/**
 * ほかのマイクが録っていない時間に、持ち主の普段の声よりこれ以上小さい音は、持ち主の声と決めない。
 * かぶりは 15〜25dB 小さく入る。録っているマイク同士なら大きさを比べて見分けられるが、
 * 止まったマイクの持ち主の声は比べる相手が無く、残ったマイクの持ち主の発言になっていた
 */
const ABSENT_PEER_MIN_REL_DB = -12

/** かぶりの大きさを測る所: ほかのマイクの持ち主が、このマイクより普段の声に比べてこれ以上大きい時刻 */
const BLEED_LEAD_DB = 10
/** かぶりの大きさからこの範囲(dB)に入る小さな音だけを「持ち主の声か分からない」とする */
const BLEED_NEAR_DB = 6

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
  /** 持ち主の声の大きさ(声のある時刻の上のほう)。持ち主の声か分からない時刻を見分ける */
  ownLevel: number
  /** 声があると判断する大きさ */
  threshold: number
  maskedFrames?: Uint8Array
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
  // 「持ち主の声か分からない」(止まったマイクの人の声の回り込み)を見分けるときの、持ち主の声の大きさ。
  // 声のある時刻にはかぶりも混ざり、2人の会話では半分近くがかぶりなので、真ん中の値はかぶりの
  // 大きさに引きずられていた(本人の声 -12dB に対し -32dB と見て、止まったマイクの人の声を
  // 本人の声と取り違えた)。上のほう(4分の3の所)で見る。重なりの判定(`speech`)は真ん中のまま
  // (上のほうで見ると、短い掛け合いの重なりを見落としていた)
  const ownLevel = speechFrames.length > 0 ? percentile(speechFrames, 0.75) : loud
  return {
    id: track.id,
    db,
    floor,
    speech,
    ownLevel,
    threshold,
    maskedFrames: track.maskedFrames
  }
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

/**
 * マイクごと・ほかのマイクの持ち主ごとの、かぶりの大きさ(dB)。`[m][o]` は o の持ち主の声が
 * m のマイクに入る大きさ。録っているマイクがそろっていて、o の持ち主がはっきり話している時刻の、
 * m のマイクの音の真ん中の値。測れなければ NaN。
 *
 * 相手ごとに分けるのは、3人以上だと、よく話す人のかぶりの大きさで、止まったマイクの人(近くに
 * 座っている・声が大きい)のかぶりまで見ていたから。消音したマイク(`maskedFrames`)は録っている
 * 扱い(止まったマイクではない。止まったとみなすと、混ぜた音の残りを使う収録では測れなかった)
 */
function bleedLevels(stats: readonly MicStats[], n: number): number[][] {
  return stats.map((st, m) => {
    const vals: number[][] = stats.map(() => [])
    for (let t = 0; t < n; t++) {
      const v = st.db[t]
      if (v === undefined || Number.isNaN(v) || v < st.threshold) continue
      let stopped = false
      let lead = -1
      let leadRel = -Infinity
      for (let o = 0; o < stats.length; o++) {
        if (o === m || stats[o].maskedFrames?.[t]) continue
        const w = stats[o].db[t]
        if (w === undefined || Number.isNaN(w)) {
          stopped = true
          break
        }
        if (w >= stats[o].threshold && w - stats[o].speech > leadRel) {
          leadRel = w - stats[o].speech
          lead = o
        }
      }
      if (!stopped && lead >= 0 && leadRel > v - st.speech + BLEED_LEAD_DB) vals[lead].push(v)
    }
    return vals.map((list) => {
      if (list.length < TURN_RATE) return NaN
      list.sort((x, y) => x - y)
      return list[Math.floor(list.length / 2)]
    })
  })
}

/**
 * 時刻 t に止まっているマイクの持ち主の声が、マイク m に入る大きさ。止まっているマイクが無ければ
 * -Infinity、どれかの大きさが測れていなければ NaN(大きさでは絞らない)
 */
function absentPeerBleed(
  stats: readonly MicStats[],
  bleed: readonly number[][],
  m: number,
  t: number
): number {
  let level = -Infinity
  for (let o = 0; o < stats.length; o++) {
    if (o === m || stats[o].maskedFrames?.[t]) continue
    const w = stats[o].db[t]
    if (w !== undefined && !Number.isNaN(w)) continue
    // その人のかぶりを測れていなければ、測れたほかの人のかぶりで一番大きいもの(相手ごとに分ける前と
    // 同じ扱い。止まったマイクの人がほとんど話していないと測れず、持ち主の小声がまた「分からない」に
    // なっていた)。何も測れていなければ NaN(大きさでは絞らない)
    let b = bleed[m][o]
    if (Number.isNaN(b)) {
      b = Math.max(...bleed[m].filter((v, i) => i !== m && !Number.isNaN(v)))
      if (b === -Infinity) return NaN
    }
    level = Math.max(level, b)
  }
  return level
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
  const weak = stats.map(() => new Uint8Array(n))
  const bleed = bleedLevels(stats, n)
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
    if (stats[best].db[t] - stats[best].ownLevel < ABSENT_PEER_MIN_REL_DB) {
      const absent = absentPeerBleed(stats, bleed, best, t)
      // 止まったマイクがあるときだけ。かぶりの大きさが分かるなら、それに近い音だけ(短い発話の語の
      // 頭・終わりや小声の語は、持ち主の声の上のほうより 12dB 以上小さくなり、持ち主の短い発話まで
      // 「分からない」になっていた)
      if (
        absent !== -Infinity &&
        (Number.isNaN(absent) || stats[best].db[t] <= absent + BLEED_NEAR_DB)
      )
        weak[best][t] = 1
    }
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
    const heard = Uint8Array.from(on)
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
      const parts = splitByWeakness(pieces, heard, weak[m], minTurn)
      for (let pi = 0; pi < parts.length; pi++) {
        const [a, b] = parts[pi]
        if (b - a < minTurn) continue
        let ov = 0
        let wk = 0
        let hd = 0
        for (let k = a; k < b; k++) {
          ov += overlapped[m][k]
          wk += weak[m][k]
          hd += heard[k]
        }
        turns.push({
          micId: stats[m].id,
          // 分けた区間どうしは余白で重ねない(同じ音を2回文字起こしに送っていた)
          start: Math.max(0, pi > 0 ? a : a - pad) / TURN_RATE,
          end: Math.min(n, pi < parts.length - 1 ? b : b + pad) / TURN_RATE,
          overlap: ov >= minTurn,
          ...(wk * 2 > hd ? { uncertain: true } : {})
        })
      }
      t = end
    }
  }
  return turns.sort((x, y) => x.start - y.start || x.micId.localeCompare(y.micId))
}

/** 持ち主の声か分からない区間として分ける最短の長さ(フレーム)。これより短い小声は文の中の小声とみなす */
const MIN_UNCERTAIN_FRAMES = 50

/**
 * 区間を「持ち主の声か分からない」所と、持ち主の声の所で分ける(止まったマイクの人の声のすぐ後に
 * 持ち主が話すと、短い切れ目でつながって1つの発話になり、持ち主の発言まで話者の名前が付かなかった)。
 * 分けるのは分からない側が 0.5 秒以上あるときだけ(文の終わりの小声・文の中の小さな落ち込みでは
 * 分けない)。声が途切れずにつながる所では、持ち主の側も 0.5 秒以上あるときだけ分ける
 */
export function splitByWeakness(
  pieces: readonly [number, number][],
  heard: Uint8Array,
  weak: Uint8Array,
  /** これより短く分けた区間は隣へまとめる(短い区間は発話にしないので、持ち主の声ごと消えていた) */
  minTurn = 0
): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of pieces) {
    // 声の続く塊ごとに、分からない側が多いかを決める
    // `touch`: 前の塊と声が途切れずにつながっている
    const blocks: { a: number; b: number; weak: boolean; len: number; touch: boolean }[] = []
    let k = a
    while (k < b) {
      const gapFrom = k
      while (k < b && !heard[k]) k++
      if (k >= b) break
      const s = k
      const touch = blocks.length > 0 && s === gapFrom
      // 声が途切れなくても、分からない/持ち主の声が替わる所で分ける(止まったマイクの人の声のすぐ
      // 後に持ち主が話すと切れ目が無く、持ち主の発話に混ざっていた。短いちらつきは下でまとめる)
      const label = weak[k]
      while (k < b && heard[k] && weak[k] === label) k++
      blocks.push({ a: s, b: k, weak: label === 1, len: k - s, touch })
    }
    if (blocks.length <= 1) {
      out.push([a, b])
      continue
    }
    // 同じ種類の隣どうしをまとめる
    const runs: { a: number; b: number; weak: boolean; len: number; touch: boolean }[] = []
    for (const blk of blocks) {
      const last = runs[runs.length - 1]
      if (last && last.weak === blk.weak) {
        last.b = blk.b
        last.len += blk.len
      } else runs.push({ ...blk })
    }
    // 短い「分からない」区間は分けない(隣とまとめる。どちらにするかは呼び出し側の多数決)。
    // 先にこれを済ませ、持ち主の声の中のちらつきで持ち主の側が細切れにならないようにする
    type Run = { a: number; b: number; weak: boolean; len: number; touch: boolean }
    const steady: Run[] = []
    for (const r of runs) {
      const last = steady[steady.length - 1]
      const tooShort = r.weak && r.len < MIN_UNCERTAIN_FRAMES
      if (last && (tooShort || last.weak === r.weak)) {
        last.b = r.b
        last.len += r.len
      } else steady.push({ ...r, weak: r.weak && !tooShort })
    }
    // 途切れずに「分からない」声とつながる短い持ち主の声も分けない(止まったマイクの人の笑い・
    // 大きな声の一瞬が、持ち主の発話として切り出されていた)
    const kept: Run[] = []
    for (const r of steady) {
      const last = kept[kept.length - 1]
      if (last && r.touch && r.weak !== last.weak) {
        if (!r.weak && r.len < MIN_UNCERTAIN_FRAMES) {
          last.b = r.b
          last.len += r.len
          continue
        }
        if (r.weak && last.len < MIN_UNCERTAIN_FRAMES) {
          last.b = r.b
          last.len += r.len
          last.weak = true
          continue
        }
      }
      if (last && last.weak === r.weak) {
        last.b = r.b
        last.len += r.len
      } else kept.push({ ...r })
    }
    // 切れ目(声の無い所)は前の区間に含め、区間の頭・終わりは元の区間の頭・終わりにそろえる
    kept[0].a = a
    for (let i = 1; i < kept.length; i++) kept[i - 1].b = kept[i].a
    kept[kept.length - 1].b = b
    const merged: [number, number][] = []
    for (const r of kept) {
      const last = merged[merged.length - 1]
      if (last && (r.b - r.a < minTurn || last[1] - last[0] < minTurn)) last[1] = r.b
      else merged.push([r.a, r.b])
    }
    out.push(...merged)
  }
  return out
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

/**
 * `track` の声のある時刻の、どれだけが `others` のどれかの声のある時刻に重なるか(0〜1)。
 * 通話のトラック(一緒に遊ぶ人みんなの声)が、Craig の1人ずつのファイルの合わせたものと同じかを見る
 */
export function coveredBy(track: MicTrack, others: readonly MicTrack[]): number {
  const st = statsOf(track)
  const os = others.map(statsOf).filter((s): s is MicStats => s !== null)
  if (!st || os.length === 0) return 0
  let active = 0
  let covered = 0
  for (let t = 0; t < st.db.length; t++) {
    const v = st.db[t]
    if (Number.isNaN(v) || v < st.threshold) continue
    active++
    if (os.some((o) => t < o.db.length && !Number.isNaN(o.db[t]) && o.db[t] >= o.threshold))
      covered++
  }
  // 声のある時間が短すぎる(数秒)なら決めない
  return active >= 5 * TURN_RATE ? covered / active : 0
}

/**
 * 書き出しの音量の基準(ラウドネス)。
 *
 * - `web`: 配信向け。YouTube などの再生側の基準に合わせた −14 LUFS(既定)
 * - `broadcast`: 放送向け。ARIB TR-B32 の −24 LKFS(LKFS と LUFS は同じ尺度)
 *
 * 標準の書き出しと長尺向けの書き出しが**同じ loudnorm の指定**を使うよう、式はここ1つに置く。
 */
export type LoudnessTarget = 'web' | 'broadcast'

export const LOUDNESS_TARGETS: Record<
  LoudnessTarget,
  { integrated: number; truePeak: number; label: string }
> = {
  web: { integrated: -14, truePeak: -1.5, label: '配信 −14 LUFS' },
  // 放送はトゥルーピークの上限(−1 dBTP)に余裕を持たせる
  broadcast: { integrated: -24, truePeak: -2, label: '放送 −24 LKFS' }
}

export function normalizeLoudnessTarget(value: unknown): LoudnessTarget {
  return value === 'broadcast' ? 'broadcast' : 'web'
}

/** 2パスの1回目(測るだけ)の loudnorm */
export function loudnormMeasureFilter(target: LoudnessTarget = 'web'): string {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  return `loudnorm=I=${t.integrated}:TP=${t.truePeak}:LRA=11:print_format=json`
}

export interface LoudnessMeasurementValues {
  inputI: number
  inputTP: number
  inputLRA: number
  inputThresh: number
  targetOffset: number
}

/**
 * 2パスの2回目(本番)の loudnorm。測れていれば measured_* を渡して linear(一定のゲイン)で掛ける。
 *
 * LRA の指定は linear では「これを超えたら dynamic へ落とす」閾値でしかなく、増幅量には効かない。
 * 素材の LRA が 11 を超えていると黙って dynamic に戻ってしまう(実測: LRA 18.5 の素材で
 * 2パス目も -14.57/LRA 14.4 のまま)ので、測った LRA を下回らない値を渡して linear を守る
 * (上限 50 は loudnorm の定義域)。測れなかったときは従来の1パス(dynamic)へ落とす。
 */
export function loudnormApplyFilter(
  target: LoudnessTarget = 'web',
  measured: LoudnessMeasurementValues | null
): string {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const base = `loudnorm=I=${t.integrated}:TP=${t.truePeak}`
  if (!measured || !loudnormAccepts(measured)) return `${base}:LRA=11`
  const lra = Math.min(50, Math.max(11, Math.ceil(measured.inputLRA)))
  return (
    `${base}:LRA=${lra}:measured_I=${measured.inputI}:` +
    `measured_TP=${measured.inputTP}:measured_LRA=${measured.inputLRA}:` +
    `measured_thresh=${measured.inputThresh}:offset=${measured.targetOffset}:linear=true`
  )
}

/**
 * 測った値を loudnorm の measured_* に渡せるか(範囲の外の値を渡すと ffmpeg が引数の誤りで止まる)。
 * 0 LUFS を越える大きな音(例: 振幅 1.8 の正弦波で +1.5 LUFS)は measured_I の範囲(−99〜0)の外になる
 */
export function loudnormAccepts(m: LoudnessMeasurementValues): boolean {
  const within = (v: number, lo: number, hi: number): boolean =>
    Number.isFinite(v) && v >= lo && v <= hi
  return (
    within(m.inputI, -99, 0) &&
    within(m.inputTP, -99, 99) &&
    within(m.inputLRA, 0, 99) &&
    within(m.inputThresh, -99, 0) &&
    within(m.targetOffset, -99, 99)
  )
}

/**
 * リミッタで抑える高さの、測ったトゥルーピークの上限(`peakCeiling`)からの余裕(dB)の始めの値。
 * 4 倍の細かさで抑えると、測ったトゥルーピークはほぼ抑えた高さになる。上限より高く抑え始めると
 * 1回目の測りが必ず「越えた」になり、書き出しのたびに音を丸ごと測り直していた
 */
const TRUE_PEAK_MARGIN_DB = 0.1
/**
 * 書き出しの前(浮動小数)で測ったトゥルーピークに残す、AAC にしたときの持ち上がり分(dB)。
 * 実測: 書き出しの前で -0.9 dBTP の音が、AAC にすると -0.1 dBTP になった
 */
const AAC_TRUE_PEAK_HEADROOM_DB = 1
/** 一定のゲイン + リミッタで合わせるときに、これより近ければ合ったとする(LU) */
export const LIMITED_GAIN_TOLERANCE_LU = 0.3

/**
 * 一定のゲインで基準まで上げるとトゥルーピークの上限を越えるか(まばらに鋭い山がある素材)。
 * そういう素材では loudnorm が黙って dynamic に戻り、リミッタで全体が下がって基準に届かない
 * (実測: 配信で -15.2、放送で -26.2 LUFS)。この場合は自分で一定のゲインを掛けて越える山だけを抑え、
 * 抑えた後の大きさを測り直してゲインを直す(`fitEncodedLoudness`)
 */
export function needsLimitedGain(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues | null
): boolean {
  if (!measured) return false
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const gain = t.integrated - measured.inputI
  return (
    Number.isFinite(gain) &&
    Number.isFinite(measured.inputTP) &&
    measured.inputTP + gain > t.truePeak
  )
}

/**
 * 一定のゲイン(dB)を掛け、`ceilingDb` を越える山だけを抑える。リミッタは先読みの分だけ音を遅らせるので、
 * 遅れを戻す(`latency=1`。戻さないと映像より約 1ms 遅れた)
 */
export function limitedGainFilter(gainDb: number, ceilingDb: number): string {
  const limit = Math.min(1, Math.max(0.0625, Math.pow(10, ceilingDb / 20)))
  // 4 倍の細かさで抑える(サンプルの間の山 = トゥルーピークも抑えるため)。後で元の細かさに戻す
  return (
    `volume=${gainDb.toFixed(2)}dB,aresample=192000,` +
    `alimiter=limit=${limit.toFixed(4)}:level=disabled:attack=1:release=50:latency=1,aresample=48000`
  )
}

/** 一定のゲイン + リミッタの掛け方(`limitedGainFilter` の引数) */
export interface LimitedGainPlan {
  gainDb: number
  ceilingDb: number
}

/** 出力(AAC にした後)の大きさ。`ebur128=peak=true` の締めの集計から読む */
export interface EncodedLoudness {
  /** 積分ラウドネス(LUFS) */
  integrated: number
  /** トゥルーピーク(dBTP) */
  truePeak: number
}

/** 書き出しの音声の符号化(標準・区間ごとの書き出しと、AAC にした後の測りで同じものを使う) */
export const OUTPUT_AUDIO_CODEC_ARGS = ['-c:a', 'aac', '-b:a', '192k']

/** AAC にした後の大きさを測るフィルタ(締めの集計を `parseEbur128Summary` で読む) */
export const ENCODED_LOUDNESS_FILTER = 'ebur128=framelog=quiet:peak=true'

/** AAC にした後で測ったトゥルーピークに残す余裕(dB)。書き出しの本番と測りで丸めが僅かに揺れても越えないように */
export const ENCODED_TRUE_PEAK_MARGIN_DB = 0.2

/** `ebur128=framelog=quiet:peak=true` の締めの集計(Summary)を読む。読めなければ null */
export function parseEbur128Summary(stderr: string): EncodedLoudness | null {
  const at = stderr.lastIndexOf('Summary:')
  const tail = at >= 0 ? stderr.slice(at) : stderr
  const i = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf) LUFS/.exec(tail)
  const tp = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(tail)
  if (!i || !tp) return null
  const integrated = i[1] === '-inf' ? -Infinity : Number(i[1])
  const truePeak = tp[1] === '-inf' ? -Infinity : Number(tp[1])
  return Number.isNaN(integrated) || Number.isNaN(truePeak) ? null : { integrated, truePeak }
}

/**
 * 一定のゲイン + リミッタで、ゲインを 1 dB 上げたときに大きさ(LUFS)が何 LU 上がるか(傾き)の始めの見込み。
 * リミッタで削れた大きさ(一定のゲインだけなら届くはずの大きさとの差)1 LU あたり、傾きをこれだけ下げる。
 * 抑える山が少ない素材は削れが小さく傾きは 1 に近い。山が多く深く抑える素材ほど小さい
 * (実測: 3時間の記録映像 Apollo 11 の 20分で、12.2 dB 上げて 2.0 LU 削れ、そこからの傾きは 0.56)。
 * 1点からの見込みは 0.5 を下回らせない(1回に動かすのは外れの 2 倍まで。クリック音の多い素材では削れが
 * 大きく見込みが小さくなり、20 dB 跳んで山の向こう側へ行ってしまった)。2回目からは測った点から決める
 */
const SLOPE_PER_LIMITED_LU = 0.22
const MIN_FIRST_SLOPE = 0.5
/**
 * 大きさがこれより外れているうちは、ピークが越えていても抑える高さを変えず、ゲインだけを直す(LU)。
 * AAC にした後のピークはゲインで上にも下にも動く(実測: 記録映像の 20分で、12.2 dB 上げて +0.4 dBTP、
 * 15.6 dB 上げて −1.8 dBTP)ので、大きさが合う前に抑える高さを下げると、要らない分まで削ってしまう
 */
const GAIN_FIRST_LU = 1
/** これ以下の越え(dB)は、大きさが合う前でも抑える高さを下げて直す(`GAIN_FIRST_LU`) */
const SMALL_OVER_DB = 0.5
/** 速いやり方で音全体を通して測る回数の上限(1回は数時間の音で数分かかる。ふつうの素材は 1〜3 回で合う。
 * 前のやり方はリミッタの前で最大6回 + AAC にした後で最大5回) */
export const MAX_LOUDNESS_PASSES = 6
/** 書き出しの音量の基準からの外れの許し(LU)。これに入らなければ、前のやり方も試す */
export const ACCEPT_LU = 0.5

/**
 * 音量を基準(積分 ±0.3 LU)に合わせ、**AAC にした後の**トゥルーピークを上限に収める掛け方を決める。
 *
 * `encode(フィルタ)` は書き出しと同じ音にフィルタを掛け、書き出しと同じ AAC にして測った大きさを返す
 * (書き出した mp4 の音そのものなので、この測りで合えば出来上がりも合う)。
 *
 * 1. **速いやり方**(`MAX_LOUDNESS_PASSES` 回まで): リミッタの前の測りを挟まず、AAC にした後の測りだけで
 *    合わせる。リミッタは音の大きさに対して相似(ゲインと抑える高さを同じだけ上げれば、出る音も同じだけ
 *    大きい)なので、大きさは「抑える高さ + (ゲイン − 抑える高さ)の関数」と見られ、抑える高さを変えた測りも
 *    同じ曲線に載る。測った点から、次のゲインを内挿(挟めなければ外挿)で決める。
 *    前のやり方(リミッタの前で最大6回 + AAC にした後で最大5回、それぞれ音全体を読み直す)は 3時間で
 *    音の段だけ約 60 分かかり、しかも AAC にした後の1回目でピークが収まっていると、大きさが外れていても
 *    そのまま使っていた(実地テスト: 3時間で −15.1 LUFS)
 * 2. 速いやり方で合わなければ(クリック音ばかりの音など、上げると小さくなる区間がある素材)、**前のやり方**
 *    (`planLimitedGainValues` + `fitEncodedTruePeak`。`measurePre` が要る)も試し、その結果も AAC にして測る
 * 3. 測った中で、トゥルーピークが上限に収まり基準に最も近いものを返す。前のやり方の結果も測って候補に
 *    入れるので、前のやり方まで進んだときは**前のやり方より基準から遠くなることはない**(上限に収まる限り)。
 *    速いやり方で ±0.3 LU(回数が尽きたら `ACCEPT_LU`)に入って止めたときは、その範囲の中で前のやり方より
 *    わずかに遠いことがある。一度も上限に収まらなければ、
 *    抑える高さを下げて測り、収まることを確かめてから返す(測っていない掛け方は返さない)
 *
 * @param measured 何も掛けない音の測り(loudnorm の1回目)。測れていなければ null
 * @param measurePre フィルタを掛けた後の音を loudnorm で測る(AAC にする前。前のやり方で使う)
 */
export async function fitEncodedLoudness(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues | null,
  encode: (filter: string) => Promise<EncodedLoudness | null>,
  measurePre: ((filter: string) => Promise<LoudnessMeasurementValues | null>) | null = null,
  maxPasses = MAX_LOUDNESS_PASSES
): Promise<string> {
  const tgt = normalizeLoudnessTarget(target)
  const t = LOUDNESS_TARGETS[tgt]
  const limit = t.truePeak - ENCODED_TRUE_PEAK_MARGIN_DB
  /** 測った掛け方と結果(同じ掛け方は測り直さない) */
  const tried = new Map<string, EncodedLoudness | null>()
  const measure = async (filter: string): Promise<EncodedLoudness | null> => {
    if (tried.has(filter)) return tried.get(filter) ?? null
    const r = await encode(filter)
    const ok = r && Number.isFinite(r.truePeak) && Number.isFinite(r.integrated) ? r : null
    tried.set(filter, ok)
    return ok
  }
  /** 上限に収まった測定済みの掛け方のうち、基準に最も近いもの */
  const best = (): { filter: string; r: EncodedLoudness } | null => {
    let b: { filter: string; r: EncodedLoudness } | null = null
    for (const [filter, r] of tried) {
      if (!r || r.truePeak > limit) continue
      if (!b || Math.abs(t.integrated - r.integrated) < Math.abs(t.integrated - b.r.integrated))
        b = { filter, r }
    }
    return b
  }

  await fitFast(tgt, measured, measure, maxPasses)
  const fast = best()
  // 速いやり方は ±0.3 LU を狙う。回数が尽きても ±0.5 LU(書き出しの基準)に入っていれば、それを使う
  if (fast && Math.abs(t.integrated - fast.r.integrated) <= ACCEPT_LU) return fast.filter

  // 2. 前のやり方も試す(結果は測って候補に入れる)
  const plan =
    measured && measurePre && needsLimitedGain(tgt, measured)
      ? await planLimitedGainValues(tgt, measured, measurePre)
      : null
  const first = plan
    ? limitedGainFilter(plan.gainDb, plan.ceilingDb)
    : loudnormApplyFilter(tgt, measured)
  const legacy = await fitEncodedTruePeak(
    tgt,
    first,
    plan,
    measured ? t.integrated - measured.inputI : null,
    measure
  )
  await measure(legacy)
  const b = best()
  if (b) return b.filter

  // 3. 一度も上限に収まらなかった: 越えが一番小さいものから、抑える高さを下げて測り、収まるのを確かめる
  let lowest: { filter: string; r: EncodedLoudness } | null = null
  for (const [filter, r] of tried)
    if (r && (!lowest || r.truePeak < lowest.r.truePeak)) lowest = { filter, r }
  if (!lowest) return loudnormApplyFilter(tgt, measured)
  let base = lowest.filter
  let ceiling = limit - (lowest.r.truePeak - limit) - 1
  for (let i = 0; i < 3; i++) {
    const f = withPeakLimit(base, ceiling)
    const r = await measure(f)
    if (r && r.truePeak <= limit) return f
    if (!r) break
    ceiling -= r.truePeak - limit + 1
    base = lowest.filter
  }
  // それでも収まらなければ、測った中でピークが一番低いもの(測っていない掛け方は返さない)
  let lowestAll = lowest
  for (const [filter, r] of tried)
    if (r && r.truePeak < lowestAll.r.truePeak) lowestAll = { filter, r }
  return lowestAll.filter
}

/**
 * `filter` の後ろに、`ceilingDb` で抑えるリミッタを足す(一定のゲイン + リミッタの掛け方なら、抑える高さを
 * 置き換える)。loudnorm の1パス(測れなかったとき)でもトゥルーピークを下げられるように
 */
function withPeakLimit(filter: string, ceilingDb: number): string {
  const c = Math.max(-24, ceilingDb)
  const m = /^volume=(-?[\d.]+)dB,aresample=192000,alimiter=/.exec(filter)
  if (m) return limitedGainFilter(Number(m[1]), c)
  const limit = Math.min(1, Math.max(0.0625, Math.pow(10, c / 20)))
  return (
    `${filter},aresample=192000,` +
    `alimiter=limit=${limit.toFixed(4)}:level=disabled:attack=1:release=50:latency=1,aresample=48000`
  )
}

/** 速いやり方(`fitEncodedLoudness` の 1)。結果は `measure` が覚える */
async function fitFast(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues | null,
  measure: (filter: string) => Promise<EncodedLoudness | null>,
  maxPasses: number
): Promise<void> {
  const t = LOUDNESS_TARGETS[target]
  const limit = t.truePeak - ENCODED_TRUE_PEAK_MARGIN_DB
  const gain0 = measured ? t.integrated - measured.inputI : null
  // loudnorm に渡せない測り(0 LUFS を越える音)は、一定のゲイン + リミッタで合わせる
  let limited =
    needsLimitedGain(target, measured) ||
    (measured !== null && Number.isFinite(gain0) && !loudnormAccepts(measured))
  let gain = gain0 ?? 0
  // 4 倍の細かさで抑えると、測ったトゥルーピークはほぼ抑えた高さになる。AAC にしたときの持ち上がり分を残す
  let ceiling = t.truePeak - AAC_TRUE_PEAK_HEADROOM_DB - TRUE_PEAK_MARGIN_DB
  let filter = limited ? limitedGainFilter(gain, ceiling) : loudnormApplyFilter(target, measured)
  /** リミッタで測った点: 抑える高さからの余裕 h = ゲイン − 抑える高さ、y = 大きさ − 抑える高さ */
  const points: { h: number; y: number }[] = []
  /** 抑える高さを続けて下げた回数 */
  let overStreak = 0
  for (let pass = 0; pass < maxPasses; pass++) {
    const r = await measure(filter)
    if (!r) return
    const over = r.truePeak - limit
    const miss = t.integrated - r.integrated
    if (over <= 0 && Math.abs(miss) <= LIMITED_GAIN_TOLERANCE_LU) return
    if (gain0 === null || !Number.isFinite(gain0)) {
      // 測れなかった(loudnorm の1パス): 大きさは loudnorm に任せ、越えたピークだけ後ろのリミッタで抑える
      if (over <= 0) return
      ceiling -= over + 0.1
      filter = withPeakLimit(loudnormApplyFilter(target, null), ceiling)
      continue
    }
    if (!limited) {
      // loudnorm(linear)は gain0 を掛けている。外れたぶんだけ足して、リミッタへ切り替える
      limited = true
      gain = gain0 + miss
      filter = limitedGainFilter(gain, ceiling)
      continue
    }
    points.push({ h: gain - ceiling, y: r.integrated - ceiling })
    // 大きさが合ってから下げる。少しだけ越えている(`SMALL_OVER_DB` 以下)ときは、下げても削れる大きさは僅かなので
    // 一緒に直す(放送で、どの点も 0.1 dB だけ越えたまま回数が尽きていた)
    if (over > 0 && (Math.abs(miss) <= GAIN_FIRST_LU || over <= SMALL_OVER_DB)) {
      // 越えたぶんだけ抑える高さを下げる。続けて越えたら(深く抑えるほど AAC で山が持ち上がる)倍ずつ下げる。
      // リミッタの高さには下限がある(`limitedGainFilter`)
      ceiling = Math.max(-24, ceiling - (over + 0.1) * 2 ** overStreak)
      overStreak++
    } else overStreak = 0
    // リミッタで削れた大きさ(一定のゲインだけなら届くはずの大きさとの差)
    const limitedLu = measured!.inputI + gain - r.integrated
    gain = ceiling + nextHeadroom(points, t.integrated - ceiling, Math.max(0, limitedLu))
    filter = limitedGainFilter(gain, ceiling)
  }
}

/**
 * 測った点(余裕 h → 大きさ y)から、y が `want` になる h を決める。
 * - 挟む隣り合った2点があれば、その間で内挿する(上げると小さくなる区間があっても、挟んだ所は確か)
 * - 挟めず、目標が測ったどれより上(もっと大きくしたい): 一番上げた点(h が最大)から先へ。
 *   - その点が一番目標に近ければ、下側の点との傾き(1点なら見込み)で外挿する。傾きが小さいときに
 *     跳びすぎないよう、1回に動かすのは外れの 4 倍(少なくとも 8 dB)まで
 *   - その点より手前に目標に近い点がある(上げたら小さくなった = 単調でない)なら、その先にしか
 *     届く所は無いので、外れのぶん(少なくとも 3 dB)だけさらに上げる(前のやり方と同じ進み方)。
 *     クリック音ばかりの素材は、上げるとまずクリックが削れて小さくなり、話し声が勝つ所でまた大きくなる
 * - 目標が測ったどれより下: 上と逆向きに同じ
 */
function nextHeadroom(points: { h: number; y: number }[], want: number, limitedLu: number): number {
  const sorted = [...points].sort((a, b) => a.h - b.h)
  // 挟む隣り合った2点のうち、目標に近い点を含むもの
  let bracket: [number, number] | null = null
  let bracketD = Infinity
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if ((a.y - want) * (b.y - want) > 0 || a.y === b.y) continue
    const d = Math.min(Math.abs(a.y - want), Math.abs(b.y - want))
    if (d < bracketD) {
      bracket = [i, i + 1]
      bracketD = d
    }
  }
  if (bracket) {
    const a = sorted[bracket[0]]
    const b = sorted[bracket[1]]
    return a.h + ((want - a.y) / (b.y - a.y)) * (b.h - a.h)
  }
  const up = want > Math.max(...sorted.map((p) => p.y))
  const dir = up ? 1 : -1
  // 進む向きの端の点と、目標に一番近い点(同じくらいなら端のほう)
  const edge = up ? sorted[sorted.length - 1] : sorted[0]
  const closest = sorted.reduce(
    (b, p) => (Math.abs(p.y - want) < Math.abs(b.y - want) - 0.05 ? p : b),
    edge
  )
  const miss = want - edge.y
  if (closest !== edge) {
    // 端まで行ったら目標から遠ざかった(単調でない): 端の先へ、外れのぶん進む
    return edge.h + dir * Math.max(3, Math.abs(miss))
  }
  const behind = up ? sorted[sorted.length - 2] : sorted[1]
  let slope = Math.min(1, Math.max(MIN_FIRST_SLOPE, 1 - SLOPE_PER_LIMITED_LU * limitedLu))
  if (behind) {
    const s = (edge.y - behind.y) / (edge.h - behind.h)
    slope = Number.isFinite(s) ? Math.min(1, Math.max(0.15, s)) : MIN_FIRST_SLOPE
  }
  const step = miss / slope
  const maxStep = Math.max(8, 4 * Math.abs(miss))
  return edge.h + Math.max(-maxStep, Math.min(maxStep, step))
}

/**
 * 前のやり方(2026-10 の修正の前): AAC にする前の音を loudnorm で測りながら、一定のゲイン + リミッタの掛け方を
 * 決める。足りない分だけゲインを足し、ピークが越えれば抑える高さを下げる(6回まで)。
 * 速いやり方で合わない素材で試す(`fitEncodedLoudness` の 2)
 */
export async function planLimitedGainValues(
  target: LoudnessTarget,
  measured: LoudnessMeasurementValues,
  measure: (filter: string) => Promise<LoudnessMeasurementValues | null>
): Promise<LimitedGainPlan | null> {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const peakCeiling = t.truePeak - AAC_TRUE_PEAK_HEADROOM_DB
  let gain = t.integrated - measured.inputI
  let ceiling = peakCeiling - TRUE_PEAK_MARGIN_DB
  for (let i = 0; i < 6; i++) {
    const r = await measure(limitedGainFilter(gain, ceiling))
    if (!r || !Number.isFinite(r.inputI))
      return i === 0 ? null : { gainDb: gain, ceilingDb: ceiling }
    const miss = t.integrated - r.inputI
    const over = Number.isFinite(r.inputTP) ? r.inputTP - peakCeiling : 0
    if (Math.abs(miss) <= LIMITED_GAIN_TOLERANCE_LU && over <= 0)
      return { gainDb: gain, ceilingDb: ceiling }
    gain += miss
    if (over > 0) ceiling -= over + 0.1
  }
  return { gainDb: gain, ceilingDb: ceiling }
}

/**
 * 前のやり方の後半: AAC にした後のトゥルーピークを測り、越えていれば抑える高さを下げる(5回まで)。
 * 結果は `fitEncodedLoudness` が測り直して候補に入れる(ここが返す掛け方が測っていないものでも、そのまま使わない)
 */
export async function fitEncodedTruePeak(
  target: LoudnessTarget,
  filter: string,
  plan: LimitedGainPlan | null,
  fallbackGainDb: number | null,
  encode: (filter: string) => Promise<EncodedLoudness | null>
): Promise<string> {
  const t = LOUDNESS_TARGETS[normalizeLoudnessTarget(target)]
  const limit = t.truePeak - ENCODED_TRUE_PEAK_MARGIN_DB
  let current = filter
  let safe: string | null = null
  let gain = plan?.gainDb ?? fallbackGainDb
  let ceiling = plan?.ceilingDb ?? t.truePeak - AAC_TRUE_PEAK_HEADROOM_DB - TRUE_PEAK_MARGIN_DB
  for (let i = 0; i < 5; i++) {
    const r = await encode(current)
    if (!r || !Number.isFinite(r.truePeak) || !Number.isFinite(r.integrated)) return safe ?? current
    const over = r.truePeak - limit
    const miss = t.integrated - r.integrated
    if (over <= 0) safe = current
    if (over <= 0 && (i === 0 || Math.abs(miss) <= LIMITED_GAIN_TOLERANCE_LU * 2)) return current
    if (gain === null || !Number.isFinite(gain)) return safe ?? current
    if (over > 0) ceiling -= over + 0.1
    if (i > 0 || plan) gain += miss
    if (ceiling < -24) ceiling = -24
    current = limitedGainFilter(gain, ceiling)
  }
  return safe ?? current
}

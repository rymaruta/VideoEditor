import type { BgmMood } from '../finish/sound'
/**
 * 構成(計画書 §5.5)の土台: 文字起こしを「場面」(話のまとまり)に分け、場面ごとに点数を付け、
 * 仕上がりの長さに収まるよう残す場面を選ぶ。
 *
 * 時刻はすべて共通の時間軸(基準カメラの時計の秒)。
 * 点数は AI(Gemini)が付けるのが本筋。鍵が無いときのために、発話の密度・話者の入れ替わり・
 * 声の重なり・感嘆の多さから付ける簡易の点数も持つ(どちらで付けたかは画面に出す)。
 */

export interface TimedLine {
  id: string
  speaker?: string
  start: number
  end: number
  text: string
  overlap: boolean
  /** 声を拾った音源(マイク・カメラ)の ID。声の盛り上がりを、その音源の音で測る */
  source?: string
}

export type SceneKind = 'highlight' | 'normal' | 'unneeded'

export interface Scene {
  id: string
  start: number
  end: number
  lines: TimedLine[]
  /** 誰かが話している時間の合計(秒) */
  speech: number
  /** 笑い・歓声の回数(音声イベントを検出したときだけ) */
  laughs?: number
  cheers?: number
  /** 声の盛り上がり(叫び・大声)の回数(`structure/hype`。測ったときだけ) */
  hype?: number
}

export interface SceneJudgement {
  sceneId: string
  /** 0〜100。高いほど残したい */
  score: number
  kind: SceneKind
  /** 場面の短い見出し(AI のときだけ) */
  title?: string
  /** なぜその点数か(人が読んで直せるように) */
  reason: string
  /** 場面の雰囲気(BGM を選ぶのに使う。AI のときだけ) */
  mood?: BgmMood
}

export interface SceneOptions {
  /** これより短い切れ目は同じ場面とみなす(秒) */
  joinGapSec?: number
  /** 場面の長さの目安の上限(秒)。超えたら次の切れ目で分ける */
  maxSceneSec?: number
  /** これより長い無言は「会話の無い場面」として分ける(秒) */
  quietSec?: number
  /** 長さで分けた残りがこれより短ければ、前の場面に含める(秒) */
  minTailSec?: number
}

/**
 * 発話の文が、続きのある形で終わっているか(「…というのは」「…ですが」「…して」)。音声認識は声の間で発話を
 * 区切るので、1つの文が2つの発話に分かれる。そこで場面を分けると、残した場面が文の途中から始まった
 * (試し編集 第2回: 質問「思い切って10%価格を上げたというのは / ものすごい挑戦だったというふうに思うんです」の
 * 間で分かれ、前の場面を落とした仕上がりが「ものすごい挑戦だった…」から始まった)
 */
export function continuesSentence(text: string): boolean {
  const t = text.replace(/[\s\u3000]+$/u, '')
  if (/[。．.!?！？]$/u.test(t)) return false
  return /(?:[のにでとも]は|[をがてでにとし]|けど|けれど(?:も)?|から|ので|のに|ながら|たり|[、,，])$/u.test(
    t
  )
}

/** 長さで分けるとき、文の途中でも分けてよい間(秒)。これだけ黙っていれば話の切れ目とみなす */
const LONG_PAUSE_SEC = 3

export function buildScenes(
  lines: readonly TimedLine[],
  range: { start: number; end: number },
  options: SceneOptions = {}
): Scene[] {
  const joinGap = options.joinGapSec ?? 4
  const maxScene = options.maxSceneSec ?? 90
  const quiet = options.quietSec ?? 8
  const minTail = options.minTailSec ?? 20
  const sorted = [...lines].sort((a, b) => a.start - b.start)

  // 話のまとまり
  const groups: TimedLine[][] = []
  /** 長さだけで分けた(話は続いている)まとまりの頭 */
  const splitByLength = new Set<TimedLine[]>()
  // まとまりの終わりは足しながら持つ(1行ごとに全部をなめると、1万行で1秒かかっていた)
  const ends = new Map<TimedLine[], number>()
  for (const l of sorted) {
    const g = groups[groups.length - 1]
    if (g) {
      const gEnd = ends.get(g) ?? -Infinity
      const gap = l.start - gEnd
      const len = gEnd - g[0].start
      // 長さで分けるのは、文の切れ目(続きのある形で終わっていない)か、長めの間のある所だけ。
      // 長さの目安の倍を超えたら、文の途中でも分ける(場面が際限なく長くならないように)
      const last = g[g.length - 1]
      const long =
        len >= maxScene &&
        (len >= maxScene * 2 || gap >= LONG_PAUSE_SEC || !continuesSentence(last.text))
      if (gap < joinGap && !(long && gap >= 1)) {
        g.push(l)
        ends.set(g, Math.max(gEnd, l.end))
        continue
      }
      if (gap < joinGap) {
        const fresh = [l]
        groups.push(fresh)
        ends.set(fresh, l.end)
        splitByLength.add(fresh)
        continue
      }
    }
    const fresh = [l]
    groups.push(fresh)
    ends.set(fresh, l.end)
  }
  // 長さで分けた残りが短いもの(話の締めの十数秒)は、前のまとまりに戻す。
  // 独りの場面にすると点数が付かずに落ちやすく、話の途中で次の場面へ飛ぶ
  // (30分の回で 11〜17 秒の残りが3つでき、うち2つが落ちて会話の締めが消えていた)
  for (let i = groups.length - 1; i > 0; i--) {
    const g = groups[i]
    if (!splitByLength.has(g)) continue
    const gEnd = Math.max(...g.map((x) => x.end))
    const next = groups[i + 1]
    // 後ろも話が続いている(さらに長さで分けた)なら、残りではない
    if (next && splitByLength.has(next)) continue
    if (gEnd - g[0].start < minTail) {
      groups[i - 1].push(...g)
      groups.splice(i, 1)
    }
  }

  const scenes: Scene[] = []
  let cursor = range.start
  const push = (start: number, end: number, ls: TimedLine[]): void => {
    if (end - start <= 0.05) return
    scenes.push({
      id: `s${scenes.length + 1}`,
      start,
      end,
      lines: ls,
      speech: speechSeconds(ls)
    })
  }
  groups.forEach((g, i) => {
    const gStart = g[0].start
    const gEnd = Math.max(...g.map((x) => x.end))
    const next = groups[i + 1]
    // 前の場面との境目
    if (gStart - cursor >= quiet) {
      push(cursor, gStart - 0.5, [])
      cursor = gStart - 0.5
    }
    // 次の場面との境目: 長い無言なら話し終わりの少し後、短ければ切れ目の真ん中
    let end: number
    if (!next) end = range.end - gEnd >= quiet ? gEnd + 0.5 : range.end
    else if (next[0].start - gEnd >= quiet) end = gEnd + 0.5
    else end = (gEnd + next[0].start) / 2
    push(cursor, Math.min(end, range.end), g)
    cursor = Math.min(end, range.end)
  })
  if (range.end - cursor > 0.05) push(cursor, range.end, [])
  return scenes
}

/** 発話の時間の合計(重なった分は1回だけ数える) */
function speechSeconds(lines: readonly TimedLine[]): number {
  const iv = lines.map((l) => [l.start, l.end] as [number, number]).sort((a, b) => a[0] - b[0])
  let total = 0
  let curS = -Infinity
  let curE = -Infinity
  for (const [s, e] of iv) {
    if (s > curE) {
      if (curE > curS) total += curE - curS
      curS = s
      curE = e
    } else curE = Math.max(curE, e)
  }
  if (curE > curS) total += curE - curS
  return total
}

/** AI を使わない簡易の点数。`kind` で、番組の種類ごとの見方に替える */
export function heuristicJudgements(
  scenes: readonly Scene[],
  kind: 'location' | 'game' = 'location'
): SceneJudgement[] {
  if (kind === 'game') return scenes.map(gameJudgement)
  return scenes.map((s) => {
    const dur = Math.max(0.1, s.end - s.start)
    if (s.lines.length === 0) {
      return { sceneId: s.id, score: 5, kind: 'unneeded', reason: '会話の無い区間(移動・待機など)' }
    }
    const density = s.speech / dur
    let turns = 0
    for (let i = 1; i < s.lines.length; i++) {
      if (s.lines[i].speaker && s.lines[i].speaker !== s.lines[i - 1].speaker) turns++
    }
    const turnsPerMin = (turns / dur) * 60
    const overlaps = s.lines.filter((l) => l.overlap).length
    const exclaims = s.lines.reduce((n, l) => n + (l.text.match(/[!！?？]/g)?.length ?? 0), 0)
    // 笑い・歓声は、その場が沸いた確かな印なので重く見る(1分あたり2回で満点)
    const laughs = (s.laughs ?? 0) + (s.cheers ?? 0)
    const laughPerMin = (laughs / dur) * 60
    const score = Math.min(
      100,
      Math.round(
        30 +
          30 * Math.min(1, density / 0.7) +
          15 * Math.min(1, turnsPerMin / 8) +
          10 * Math.min(1, overlaps / 2) +
          15 * Math.min(1, exclaims / 4) +
          25 * Math.min(1, laughPerMin / 2)
      )
    )
    const kind: SceneKind =
      density < 0.15 && laughs === 0
        ? 'unneeded'
        : score >= 70 || laughs >= 2
          ? 'highlight'
          : 'normal'
    const parts = [`発話 ${Math.round(density * 100)}%`, `掛け合い ${turnsPerMin.toFixed(0)}回/分`]
    if (s.laughs) parts.push(`笑い ${s.laughs}`)
    if (s.cheers) parts.push(`歓声 ${s.cheers}`)
    if (overlaps) parts.push(`声の重なり ${overlaps}`)
    if (exclaims) parts.push(`感嘆・疑問 ${exclaims}`)
    return {
      sceneId: s.id,
      score: kind === 'unneeded' ? Math.min(score, 20) : score,
      kind,
      reason: (kind === 'unneeded' ? '会話がほとんど無い · ' : '') + parts.join(' · ')
    }
  })
}

/**
 * ゲーム実況の簡易の点数。面白い所の印は、声の盛り上がり(叫び・大声)と笑い。
 * ロケと違い、ずっと話していても(実況は話し続けるのが普通)盛り上がりが無ければ点は伸びない。
 * 黙々とプレイしている所(話す時間が 2 割未満で、盛り上がりも笑いも無い)は不要にする
 */
function gameJudgement(s: Scene): SceneJudgement {
  const dur = Math.max(0.1, s.end - s.start)
  if (s.lines.length === 0) {
    return {
      sceneId: s.id,
      score: 5,
      kind: 'unneeded',
      reason: '声の無いプレイ(黙々と進める所・ロード)'
    }
  }
  const density = s.speech / dur
  const hype = s.hype ?? 0
  const laughs = (s.laughs ?? 0) + (s.cheers ?? 0)
  const exclaims = s.lines.reduce((n, l) => n + (l.text.match(/[!！?？]/g)?.length ?? 0), 0)
  let turns = 0
  for (let i = 1; i < s.lines.length; i++) {
    if (s.lines[i].speaker && s.lines[i].speaker !== s.lines[i - 1].speaker) turns++
  }
  const perMin = (n: number): number => (n / dur) * 60
  const score = Math.min(
    100,
    Math.round(
      20 +
        15 * Math.min(1, density / 0.6) +
        35 * Math.min(1, perMin(hype) / 2) +
        20 * Math.min(1, perMin(laughs) / 2) +
        5 * Math.min(1, exclaims / 4) +
        5 * Math.min(1, perMin(turns) / 8)
    )
  )
  const kind: SceneKind =
    hype === 0 && laughs === 0 && density < 0.2
      ? 'unneeded'
      : hype >= 2 || laughs >= 2 || score >= 70
        ? 'highlight'
        : 'normal'
  const parts = [`発話 ${Math.round(density * 100)}%`]
  if (hype) parts.push(`叫び・大声 ${hype}`)
  if (s.laughs) parts.push(`笑い ${s.laughs}`)
  if (s.cheers) parts.push(`歓声 ${s.cheers}`)
  if (exclaims) parts.push(`感嘆・疑問 ${exclaims}`)
  return {
    sceneId: s.id,
    score: kind === 'unneeded' ? Math.min(score, 20) : score,
    kind,
    reason: (kind === 'unneeded' ? '盛り上がりの無いプレイ · ' : '') + parts.join(' · ')
  }
}

/**
 * 場面の中身の手掛かり(AI を使わない)。判定が場面に同じ点数を付けて区別できないとき、長さに合わせて
 * 落とす場面をこれで選ぶ(並び順で決めない)。
 * - density: 話している時間の割合
 * - speakers: 話者の数(マイク1本では分けられないので 1)
 * - numbers: 具体的な数字(「5%」「2024年」「10」)の数
 * - names: 固有名詞らしい言葉(カタカナ語・英字・「○○さん」「○○社長」)の数
 */
export interface SceneCues {
  density: number
  speakers: number
  numbers: number
  names: number
}

const NUMBER_RE = /[0-9０-９]+(?:[.,．，][0-9０-９]+)?/gu
const NAME_RE =
  /[ァ-ヴ][ァ-ヴー]{2,}|[A-Za-z][A-Za-z0-9]+|[一-鿿々]{1,6}(?:さん|社長|会長|部長|様|氏|先生|総理|大臣|株式会社|建機|商事|工業|製作所)/gu

export function sceneCues(s: Scene): SceneCues {
  const dur = Math.max(0.1, s.end - s.start)
  const text = s.lines.map((l) => l.text).join(' ')
  return {
    density: Math.min(1, s.speech / dur),
    speakers: new Set(s.lines.map((l) => l.speaker ?? '?')).size,
    numbers: text.match(NUMBER_RE)?.length ?? 0,
    names: text.match(NAME_RE)?.length ?? 0
  }
}

/**
 * 場面の中身の濃さ(0〜100。`sceneCues` から)。数字・固有名詞は1分あたりの数で見る(長い場面ほど
 * 多くなるのを除く)
 */
export function sceneSubstance(s: Scene): number {
  if (s.lines.length === 0) return 0
  const c = sceneCues(s)
  const min = Math.max(0.1, s.end - s.start) / 60
  return (
    40 * Math.min(1, c.density / 0.7) +
    15 * Math.min(1, (c.speakers - 1) / 3) +
    25 * Math.min(1, c.numbers / min / 3) +
    20 * Math.min(1, c.names / min / 3)
  )
}

/** 場面の中身の手掛かりの短い説明(画面の「落とした理由」に添える) */
export function describeCues(c: SceneCues): string {
  return `発話 ${Math.round(c.density * 100)}% · 話者 ${c.speakers} · 数字 ${c.numbers} · 固有名詞 ${c.names}`
}

/** 判定が区別できていないとみなす場面の数の下限 */
const MIN_SCENES_TO_DISTINGUISH = 3

/**
 * 判定が場面を区別できていないか(「不要」以外の全部の場面に同じ点数・同じ印を付けた)。区別できていなければ
 * その点数と印。小さいモデルは全部の場面に「見どころ・85 点」を付けることがある(試し編集 第2回: 9 場面すべて)。
 * そのまま長さに合わせると、落とす場面が並び順で決まっていた
 */
export function indistinctJudgements(
  judgements: readonly SceneJudgement[]
): { total: number; score: number; kind: SceneKind } | null {
  const usable = judgements.filter((j) => j.kind !== 'unneeded')
  if (usable.length < MIN_SCENES_TO_DISTINGUISH) return null
  const first = usable[0]
  return usable.every((j) => j.score === first.score && j.kind === first.kind)
    ? { total: usable.length, score: first.score, kind: first.kind }
    : null
}

export interface Selection {
  kept: string[]
  dropped: { sceneId: string; why: 'unneeded' | 'length' }[]
  /** 残した場面の、詰めた後の見込みの長さ(秒) */
  estimated: number
  /**
   * 点数の下限(`minScore`)を越える場面が1つも無く、点数の上位の場面を残した
   * (静かな回で「面白い所だけ」が空の仮編集にならないように)
   */
  relaxed?: boolean
  /**
   * 判定が全部の場面を「不要」にしたので、点数・発話の割合の上位の場面を仮に残した(要確認)。
   * 空の仮編集にすると、自動編集がカットで止まる(小さい AI が聞き取れない文字起こしで全部を不要にした)。
   * 人が手で全部を落としたときは、ここでは決めない(`planRoughCut` の `keep` で落ちる)
   */
  rescued?: { kept: number; total: number }
}

/** 点数の下限を越える場面が無いとき、残す上位の割合 */
const RELAXED_KEEP_RATIO = 0.25

/**
 * 全部の場面が「不要」のとき、仮に残す場面の発話の割合の下限(簡易の点数で「会話がほとんど無い」とする所と
 * 同じ 15%)。これを越える場面が無ければ、点数・発話の割合のいちばん上の 1 場面だけ残す
 */
const RESCUE_MIN_SPEECH_RATIO = 0.15

/**
 * 判定が全部の場面を「不要」にしたときに仮に残す場面(時刻順)。点数の高い順、同じなら発話の割合の高い順に
 * 並べ、発話が `RESCUE_MIN_SPEECH_RATIO` 以上の場面を残す(無ければ上位の 1 場面)
 */
export function rescueScenes(
  scenes: readonly Scene[],
  judgements: readonly SceneJudgement[]
): string[] {
  if (scenes.length === 0) return []
  const score = new Map(judgements.map((j) => [j.sceneId, j.score]))
  const ratio = (s: Scene): number => {
    const dur = s.end - s.start
    return dur > 0 ? Math.min(1, s.speech / dur) : 0
  }
  const events = (s: Scene): number => (s.laughs ?? 0) + (s.cheers ?? 0) + (s.hype ?? 0)
  const ranked = [...scenes].sort(
    (a, b) =>
      (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) ||
      events(b) - events(a) ||
      ratio(b) - ratio(a)
  )
  const talking = new Set(
    ranked.filter((s) => ratio(s) >= RESCUE_MIN_SPEECH_RATIO || events(s) > 0).map((s) => s.id)
  )
  const keep = talking.size > 0 ? talking : new Set([ranked[0].id])
  return scenes.filter((s) => keep.has(s.id)).map((s) => s.id)
}

/**
 * 仕上がりの長さに収まるよう、残す場面を選ぶ。
 * 「不要」は必ず落とす。残りが長ければ点数の低い順に落とす(並びは元の時刻順のまま)。
 * 点数が同じなら、番組の頭と終わりを残し、前後が落ちている場面から落とす。
 * `estimate` は場面を詰めた後の長さの見込み(カットで間を詰めると短くなるため)。
 */
export function selectScenes(
  scenes: readonly Scene[],
  judgements: readonly SceneJudgement[],
  targetSec: number,
  estimate: (s: Scene) => number = (s) => s.end - s.start,
  /** 点数がこれ未満の場面も「不要」と同じく落とす(見どころは残す)。「面白い所だけ」で使う */
  minScore = -Infinity,
  /** 「不要」の場面を落とす(「軽く整える」では落とさない) */
  dropUnneeded = true
): Selection {
  const judge = new Map(judgements.map((j) => [j.sceneId, j]))
  // 点数の下限を越える場面が1つも無い(声の山も笑いも無い静かな回)なら、下限を
  // 点数の上位(4分の1)の所まで下げる。空の仮編集を作ると、本編が丸ごと消えてしまう
  let relaxed = false
  if (Number.isFinite(minScore)) {
    const usable = scenes
      .map((s) => judge.get(s.id))
      .filter((j) => !(dropUnneeded && j?.kind === 'unneeded'))
    const passes = usable.some((j) => !j || j.kind === 'highlight' || j.score >= minScore)
    if (!passes && usable.length > 0) {
      const scores = usable.map((j) => j!.score).sort((a, b) => b - a)
      minScore = scores[Math.max(0, Math.ceil(scores.length * RELAXED_KEEP_RATIO) - 1)]
      relaxed = true
    }
  }
  const dropped: Selection['dropped'] = []
  // 全部の場面が「不要」(判定が見分けになっていない・聞き取れない文字起こし)なら、点数・発話の割合の
  // 上位を仮に残す(空の仮編集にしない。どれを残したかは `rescued` で知らせ、人に確かめてもらう)
  const rescue =
    dropUnneeded && scenes.length > 0 && scenes.every((s) => judge.get(s.id)?.kind === 'unneeded')
      ? new Set(rescueScenes(scenes, judgements))
      : null
  const candidates = scenes.filter((s) => {
    const j = judge.get(s.id)
    if (rescue) {
      if (rescue.has(s.id)) return true
      dropped.push({ sceneId: s.id, why: 'unneeded' })
      return false
    }
    if (
      (dropUnneeded && j?.kind === 'unneeded') ||
      (j && j.kind !== 'highlight' && j.score < minScore)
    ) {
      dropped.push({ sceneId: s.id, why: 'unneeded' })
      return false
    }
    return true
  })
  const keep = new Set(candidates.map((s) => s.id))
  let total = candidates.reduce((t, s) => t + estimate(s), 0)
  const score = (s: Scene): number => judge.get(s.id)?.score ?? 50
  const substanceOf = new Map(scenes.map((s) => [s.id, sceneSubstance(s)]))
  const indistinct = indistinctJudgements(judgements) !== null
  const substance = (s: Scene): number => substanceOf.get(s.id) ?? 0
  const index = new Map(scenes.map((s, i) => [s.id, i]))
  /** 前後の場面がすでに落ちている(落としても時間の飛ぶ所が増えない) */
  const besideDropped = (s: Scene): boolean => {
    const i = index.get(s.id)!
    return [scenes[i - 1], scenes[i + 1]].some((x) => x !== undefined && !keep.has(x.id))
  }
  while (total > targetSec && keep.size > 1) {
    const left = candidates.filter((s) => keep.has(s.id))
    const low = Math.min(...left.map(score))
    // 点数の同じ場面どうしでは、(1) 番組の頭と終わり(残っている最初と最後の場面)は残し、
    // (2) 前後がすでに落ちている場面を先に落とす(話の途中へ飛ぶ所を増やさない)。
    // 以前は時刻の早い順に落ちたため、点数がそろう簡易の判定では番組の頭(出演者・場所の紹介)から消えていた
    // (3) 中身の手掛かり(発話の密度・話者の数・数字や固有名詞の多さ)の少ない方から落とす。判定が場面を
    // 区別できていない(全部に同じ点数)ときは (2) より先に見る(AI が全部の場面に同じ点数を付けると、
    // 並び順だけで決まっていた)。区別できている判定では (2) の後(たまたま同点の場面どうしの決め手だけ)
    const edge = (s: Scene): number => (s === left[0] || s === left[left.length - 1] ? 1 : 0)
    const beside = (a: Scene, b: Scene): number =>
      Number(besideDropped(b)) - Number(besideDropped(a))
    const byCues = (a: Scene, b: Scene): number => substance(a) - substance(b)
    const s = left
      .filter((x) => score(x) === low)
      .sort((a, b) =>
        indistinct
          ? edge(a) - edge(b) || byCues(a, b) || beside(a, b)
          : edge(a) - edge(b) || beside(a, b) || byCues(a, b)
      )[0]
    keep.delete(s.id)
    total -= estimate(s)
    dropped.push({ sceneId: s.id, why: 'length' })
  }
  return {
    kept: scenes.filter((s) => keep.has(s.id)).map((s) => s.id),
    dropped,
    estimated: total,
    ...(relaxed ? { relaxed } : {}),
    ...(rescue ? { rescued: { kept: keep.size, total: scenes.length } } : {})
  }
}

/** 「見どころ」が見分けになっているかを確かめる、場面の数の下限と、見どころの割合の上限 */
const MIN_SCENES_TO_CHECK = 6
const MAX_HIGHLIGHT_RATIO = 0.5

/**
 * ほとんどの場面を「見どころ」にした判定は、見分けになっていない(小さなモデル・聞き取れない言葉の
 * 文字起こしで起きる)。点数の下限で残す場面を決める「面白い所だけ」でそのまま使うと全部が残るので、
 * 場面の印(見どころ・ふつう)と点数を `heuristic`(声の盛り上がり・笑い・発話の密度)に置き換える。
 * 題・理由・曲の雰囲気と、判定が「不要」にした印はそのまま使う。置き換えで「不要」にはしない
 * (発話の少ない回で全部が落ちないように)
 */
export function demoteIndiscriminateHighlights(
  judgements: readonly SceneJudgement[],
  heuristic: readonly SceneJudgement[]
): { judgements: SceneJudgement[]; demoted?: { highlights: number; total: number } } {
  const highlights = judgements.filter((j) => j.kind === 'highlight').length
  if (
    judgements.length < MIN_SCENES_TO_CHECK ||
    highlights <= judgements.length * MAX_HIGHLIGHT_RATIO
  )
    return { judgements: [...judgements] }
  const byId = new Map(heuristic.map((h) => [h.sceneId, h]))
  let changed = false
  const out = judgements.map((j) => {
    const h = byId.get(j.sceneId)
    if (!h || j.kind === 'unneeded') return j
    const kind = h.kind === 'unneeded' ? 'normal' : h.kind
    if (kind === j.kind && h.score === j.score) return j
    changed = true
    return { ...j, kind, score: h.score }
  })
  // 判定そのものが点数の判定(AI を使わない)なら、置き換えても変わらない
  return changed
    ? { judgements: out, demoted: { highlights, total: judgements.length } }
    : { judgements: out }
}

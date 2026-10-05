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
  for (const l of sorted) {
    const g = groups[groups.length - 1]
    if (g) {
      const gEnd = Math.max(...g.map((x) => x.end))
      const gap = l.start - gEnd
      const long = gEnd - g[0].start >= maxScene
      if (gap < joinGap && !(long && gap >= 1)) {
        g.push(l)
        continue
      }
      if (gap < joinGap) {
        groups.push([l])
        splitByLength.add(groups[groups.length - 1])
        continue
      }
    }
    groups.push([l])
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

/** AI を使わない簡易の点数 */
export function heuristicJudgements(scenes: readonly Scene[]): SceneJudgement[] {
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

export interface Selection {
  kept: string[]
  dropped: { sceneId: string; why: 'unneeded' | 'length' }[]
  /** 残した場面の、詰めた後の見込みの長さ(秒) */
  estimated: number
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
  estimate: (s: Scene) => number = (s) => s.end - s.start
): Selection {
  const judge = new Map(judgements.map((j) => [j.sceneId, j]))
  const dropped: Selection['dropped'] = []
  const candidates = scenes.filter((s) => {
    if (judge.get(s.id)?.kind === 'unneeded') {
      dropped.push({ sceneId: s.id, why: 'unneeded' })
      return false
    }
    return true
  })
  const keep = new Set(candidates.map((s) => s.id))
  let total = candidates.reduce((t, s) => t + estimate(s), 0)
  const score = (s: Scene): number => judge.get(s.id)?.score ?? 50
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
    const edge = (s: Scene): number => (s === left[0] || s === left[left.length - 1] ? 1 : 0)
    const s = left
      .filter((x) => score(x) === low)
      .sort((a, b) => edge(a) - edge(b) || Number(besideDropped(b)) - Number(besideDropped(a)))[0]
    keep.delete(s.id)
    total -= estimate(s)
    dropped.push({ sceneId: s.id, why: 'length' })
  }
  return {
    kept: scenes.filter((s) => keep.has(s.id)).map((s) => s.id),
    dropped,
    estimated: total
  }
}

/**
 * 笑い・歓声(音声イベント)の検出結果と、その数え方(計画書 §5.5)。
 *
 * 基準カメラの音(その場の全員の声・スタッフの笑いも入る)を 10 秒の窓で 5 秒ずつずらしながら、AudioSet で学習した
 * 分類モデル(AST)で調べ、窓ごとに「笑い」「歓声・拍手」らしさ(0〜1)を出す。時刻は共通の時間軸。
 * 場面の判定では、続いて超えた窓を1回と数える(同じ笑いを重ねて数えない)。
 */
export interface AudioEventWindow {
  start: number
  end: number
  laugh: number
  cheer: number
}

/** AudioSet の分類名のうち、笑い・歓声に数えるもの */
export const LAUGH_LABELS = /laugh|giggle|snicker|chuckle|chortle|belly/i
export const CHEER_LABELS = /cheer|applause|clapping|crowd/i

/**
 * これを超えた窓を「笑った」「沸いた」とみなす。確からしさは分類ごとに独立(シグモイド)で、
 * 笑いの分類の合計。話し声だけの窓は 0.00〜0.001、会話に笑いが混ざった窓は 0.05〜0.13、
 * 笑いだけなら 0.5 前後(実測: 会話の録音に笑い声を混ぜたもの)
 */
export const LAUGH_THRESHOLD = 0.04
export const CHEER_THRESHOLD = 0.05

export const EVENT_WINDOW_SEC = 10
export const EVENT_HOP_SEC = 5

/**
 * 分類の結果(分類名と、分類ごとに独立した確からしさ)から、笑い・歓声らしさを出す。
 * AudioSet は「話し声と笑い」のように同時に起きる音を学んだ多ラベルの分類なので、全分類で合計 1 にする
 * 正規化(ソフトマックス)を掛けると、話し声に重なった笑いが小さく出る。シグモイドで出した値を渡すこと
 */
export function eventScores(results: readonly { label: string; score: number }[]): {
  laugh: number
  cheer: number
} {
  let laugh = 0
  let cheer = 0
  for (const r of results) {
    if (LAUGH_LABELS.test(r.label)) laugh += r.score
    else if (CHEER_LABELS.test(r.label)) cheer += r.score
  }
  return { laugh: Math.min(1, laugh), cheer: Math.min(1, cheer) }
}

/** 区間(共通の時刻)の中の、笑い・歓声の回数(続いて超えた窓は1回) */
export function countEvents(
  events: readonly AudioEventWindow[],
  start: number,
  end: number
): { laughs: number; cheers: number } {
  const inside = events
    .filter(
      (e) =>
        e.start < end &&
        e.end > start &&
        (e.start + e.end) / 2 >= start &&
        (e.start + e.end) / 2 < end
    )
    .sort((a, b) => a.start - b.start)
  const count = (hit: (e: AudioEventWindow) => boolean): number => {
    let n = 0
    let prevEnd = -Infinity
    for (const e of inside) {
      if (!hit(e)) continue
      if (e.start > prevEnd) n++
      prevEnd = e.end
    }
    return n
  }
  return {
    laughs: count((e) => e.laugh >= LAUGH_THRESHOLD),
    cheers: count((e) => e.cheer >= CHEER_THRESHOLD)
  }
}

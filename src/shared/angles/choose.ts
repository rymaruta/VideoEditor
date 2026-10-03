import type { CutRange } from '../cut/tighten'

/**
 * アングルの自動切り替え(計画書 §5.7)。今は顔の検出を使わない、規則による選び方:
 *
 * 1. 話者が替わったら、その人を主に映すカメラ(`subject`)へ。決まっていなければ基準カメラ(全体)
 * 2. カットで時間を飛ばした所(つなぎ目)は、同じカメラのままだと画が跳ぶので、必ず別のカメラに替える
 * 3. 1ショットは `minShotSec` より短くしない。`maxShotSec` を超えたら、次の話し始めで別のカメラへ
 * 4. そのカメラが録っていない時間には使わない
 *
 * 顔の検出(誰が映っているか・顔の大きさ)は後から点数として足せるよう、選ぶ所を1か所にまとめてある。
 */

export interface AngleCamera {
  id: string
  /** 主に映している出演者 */
  subject?: string
  /** 録っている区間(共通の時間軸) */
  coverage: { start: number; end: number }[]
}

export interface AngleLine {
  speaker?: string
  start: number
  end: number
}

export interface Shot {
  start: number
  end: number
  cameraId: string
  /** なぜこのカメラか(画面の説明用) */
  reason: 'speaker' | 'jump' | 'long' | 'coverage' | 'default'
}

export interface AngleOptions {
  minShotSec?: number
  maxShotSec?: number
}

function covers(cam: AngleCamera, a: number, b: number): boolean {
  return cam.coverage.some((c) => c.start <= a + 1e-6 && c.end >= b - 1e-6)
}

export function chooseAngles(
  pieces: readonly CutRange[],
  cameras: readonly AngleCamera[],
  anchorId: string,
  lines: readonly AngleLine[],
  options: AngleOptions = {}
): Shot[] {
  const minShot = options.minShotSec ?? 2
  const maxShot = options.maxShotSec ?? 8
  if (cameras.length === 0) return []
  const anchor = cameras.find((c) => c.id === anchorId) ?? cameras[0]
  const sortedLines = [...lines].sort((a, b) => a.start - b.start)
  const subjectCam = (speaker: string | undefined): AngleCamera | undefined =>
    speaker ? cameras.find((c) => c.subject === speaker) : undefined

  /** その時刻から使えるカメラのうち、望むもの → 基準 → ほか の順で */
  const pick = (
    a: number,
    b: number,
    prefer: (AngleCamera | undefined)[],
    avoid?: string
  ): AngleCamera | undefined => {
    const order = [...prefer, anchor, ...cameras].filter((c): c is AngleCamera => !!c)
    return (
      order.find((c) => c.id !== avoid && covers(c, a, b)) ?? order.find((c) => covers(c, a, b))
    )
  }

  const shots: Shot[] = []
  let current: AngleCamera | undefined
  let shotStart = 0 // 今のショットの頭(タイムラインの秒)
  let timeline = 0
  let prevEnd = -Infinity

  for (const piece of pieces) {
    const jump = piece.start > prevEnd + 0.05 && shots.length > 0
    // 区間の中で切り替えてよい時刻: 話し始め(話者つき)
    const events = sortedLines.filter(
      (l) => l.start > piece.start + 0.05 && l.start < piece.end - 0.05
    )
    const firstSpeaker = sortedLines.find(
      (l) => l.end > piece.start && l.start < piece.end
    )?.speaker
    // 区間の頭
    const want = subjectCam(firstSpeaker)
    if (!current || jump || !covers(current, piece.start, piece.start + 0.05)) {
      const cam = pick(piece.start, piece.start + 0.05, [want], jump ? current?.id : undefined)
      if (cam) {
        current = cam
        shotStart = timeline
        shots.push({
          start: piece.start,
          end: piece.end,
          cameraId: cam.id,
          reason: jump ? 'jump' : want && cam.id === want.id ? 'speaker' : 'default'
        })
      }
    } else {
      shots.push({
        start: piece.start,
        end: piece.end,
        cameraId: current.id,
        reason: shots.at(-1)?.reason ?? 'default'
      })
    }
    // 区間の中の話し始めで切り替える
    for (const ev of events) {
      if (!current) break
      const at = timeline + (ev.start - piece.start)
      const held = at - shotStart
      if (held < minShot) continue
      const target = subjectCam(ev.speaker)
      let next: AngleCamera | undefined
      let reason: Shot['reason'] = 'speaker'
      if (target && target.id !== current.id) next = pick(ev.start, ev.start + 0.05, [target])
      else if (!target && current.subject && current.subject !== ev.speaker) {
        // 映している人以外が話し始めたら、全体へ戻す
        next = pick(ev.start, ev.start + 0.05, [anchor])
      } else if (held >= maxShot) {
        next = pick(ev.start, ev.start + 0.05, [target], current.id)
        reason = 'long'
      }
      if (!next || next.id === current.id) continue
      const last = shots[shots.length - 1]
      last.end = ev.start
      shots.push({ start: ev.start, end: piece.end, cameraId: next.id, reason })
      current = next
      shotStart = at
    }
    timeline += piece.end - piece.start
    prevEnd = piece.end
  }

  // 録っていない時間に掛かったショットは、録っているカメラで分ける
  const fixed: Shot[] = []
  for (const s of shots) {
    const cam = cameras.find((c) => c.id === s.cameraId)!
    if (covers(cam, s.start, s.end)) {
      fixed.push(s)
      continue
    }
    let t = s.start
    while (t < s.end - 1e-6) {
      const own = cam.coverage.find((c) => c.start <= t + 1e-6 && c.end > t)
      if (own) {
        const e = Math.min(s.end, own.end)
        fixed.push({ ...s, start: t, end: e })
        t = e
        continue
      }
      const other = cameras.find((c) => c.coverage.some((v) => v.start <= t + 1e-6 && v.end > t))
      const nextOwn = Math.min(
        s.end,
        ...cam.coverage.filter((c) => c.start > t).map((c) => c.start)
      )
      if (!other) {
        // どのカメラも録っていない時間は映せないので飛ばす
        t = nextOwn
        continue
      }
      const oc = other.coverage.find((v) => v.start <= t + 1e-6 && v.end > t)!
      const e = Math.min(nextOwn, oc.end)
      fixed.push({ start: t, end: e, cameraId: other.id, reason: 'coverage' })
      t = e
    }
  }
  return fixed.filter((s) => s.end - s.start > 1e-3)
}

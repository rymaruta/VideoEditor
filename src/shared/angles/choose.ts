import type { CutRange } from '../cut/tighten'
import { GAP_TOLERANCE } from '../sync/multicam'

/**
 * アングルの自動切り替え(計画書 §5.7)。今は顔の検出を使わない、規則による選び方:
 *
 * 1. 話者が替わったら、その人を主に映すカメラ(`subject`)へ。決まっていなければ基準カメラ(全体)
 * 2. カットで時間を飛ばした所(つなぎ目)は、同じカメラのままだと画が跳ぶので、必ず別のカメラに替える
 * 3. 1ショットは `minShotSec` より短くしない。`maxShotSec` を超えたら、次の話し始めで別のカメラへ
 * 4. そのカメラが録っていない時間には使わない
 * 5. 場面の頭(`CutRange.sceneId` が替わる所。番組の頭も)は基準カメラ(全体)から入る。
 *    どこで誰と何をしているかを先に見せてから寄る(状況を見せる画)。2秒は全体のまま(規則3)
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
  reason: 'speaker' | 'jump' | 'scene' | 'long' | 'coverage' | 'default' | 'manual'
}

export interface AngleOptions {
  minShotSec?: number
  maxShotSec?: number
}

function covers(cam: AngleCamera, a: number, b: number): boolean {
  return cam.coverage.some((c) => c.start <= a + 1e-6 && c.end >= b - 1e-6)
}

/**
 * 録っている区間を並べ、分割ファイルのつなぎ目のごく短い隙間(同期の丸めで 20ms ほど)はつなぐ。
 * つながないと、つなぎ目で別のカメラへ一瞬(1フレーム未満)切り替わってしまう
 */
function joinCoverage(cam: AngleCamera): AngleCamera {
  const sorted = [...cam.coverage].sort((a, b) => a.start - b.start)
  const out: AngleCamera['coverage'] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && c.start <= last.end + GAP_TOLERANCE) last.end = Math.max(last.end, c.end)
    else out.push({ start: c.start, end: c.end })
  }
  return { ...cam, coverage: out }
}

/** 1フレームに満たないショットは前(先頭なら後ろ)のショットに含める(画が一瞬だけ替わるのを防ぐ) */
function absorbSlivers(shots: Shot[]): Shot[] {
  const out: Shot[] = []
  for (const s of shots) {
    if (s.end - s.start <= 1e-3) continue
    const last = out[out.length - 1]
    const touching = last && Math.abs(last.end - s.start) < 1e-6
    if (touching && s.end - s.start < GAP_TOLERANCE) {
      last.end = s.end
      continue
    }
    if (touching && last.end - last.start < GAP_TOLERANCE) {
      // 前が細切れ(先頭にできたもの)なら、こちらへ含める
      out[out.length - 1] = { ...s, start: last.start }
      continue
    }
    out.push({ ...s })
  }
  return out
}

export function chooseAngles(
  pieces: readonly CutRange[],
  inputCameras: readonly AngleCamera[],
  anchorId: string,
  lines: readonly AngleLine[],
  options: AngleOptions = {}
): Shot[] {
  const minShot = options.minShotSec ?? 2
  const maxShot = options.maxShotSec ?? 8
  if (inputCameras.length === 0) return []
  const cameras = inputCameras.map(joinCoverage)
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
  let prevScene: string | undefined

  for (const [pieceIndex, piece] of pieces.entries()) {
    const jump = piece.start > prevEnd + 0.05 && shots.length > 0
    const sceneStart =
      piece.sceneId !== undefined &&
      piece.sceneId !== prevScene &&
      (shots.length === 0 || piece.start > prevEnd + 0.05)
    // 区間の中で切り替えてよい時刻: 話し始め(話者つき)
    const events = sortedLines.filter(
      (l) => l.start > piece.start + 0.05 && l.start < piece.end - 0.05
    )
    const firstSpeaker = sortedLines.find(
      (l) => l.end > piece.start && l.start < piece.end
    )?.speaker
    // 区間の頭(場面の頭は全体から)
    // (今が全体なら、同じカメラで時間を飛ばさないよう話者のカメラへ)
    const speakerCam = subjectCam(firstSpeaker)
    const want = sceneStart ? anchor : speakerCam
    // この区間のショットの始まり(区間の中の切り替えで、前の区間のショットを伸ばさないため)
    const firstShotOfPiece = shots.length
    if (!current || jump || !covers(current, piece.start, piece.start + 0.05)) {
      // 区間の頭をどのカメラも録っていない(ピンマイクだけが回っていた間に始まる)なら、
      // 区間の中で最初にカメラが録り始める所のカメラにする(録っていない所は後で飛ばす)
      const firstCovered = Math.min(
        ...cameras.flatMap((c) =>
          c.coverage
            .filter((v) => v.end > piece.start + 1e-6 && v.start < piece.end - 0.05)
            .map((v) => Math.max(v.start, piece.start))
        )
      )
      const at = Number.isFinite(firstCovered) ? firstCovered : piece.start
      const cam = pick(
        at,
        at + 0.05,
        sceneStart ? [anchor, speakerCam] : [speakerCam],
        jump ? current?.id : undefined
      )
      // どのカメラも録っていない区間は映せない(前の区間のカメラを持ち越さない)
      if (!cam) current = undefined
      if (cam) {
        current = cam
        shotStart = timeline
        shots.push({
          start: piece.start,
          end: piece.end,
          cameraId: cam.id,
          reason:
            sceneStart && cam.id === anchor.id
              ? 'scene'
              : jump
                ? 'jump'
                : want && cam.id === want.id
                  ? 'speaker'
                  : 'default'
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
    // 次の区間が時間を飛ばす(またはこれが最後の区間)なら、ショットはこの区間の終わりで切れる
    const following = pieces[pieceIndex + 1]
    const endsHere = !following || following.start > piece.end + 0.05
    // 区間の中の話し始めで切り替える
    for (const ev of events) {
      if (!current) break
      const at = timeline + (ev.start - piece.start)
      const held = at - shotStart
      if (held < minShot) continue
      // 切り替えた先のショットが短すぎる(区間の終わりのすぐ手前の話し始め)なら切り替えない
      if (endsHere && piece.end - ev.start < minShot) continue
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
      // この区間のショットが無ければ、前の区間のショットは伸ばさない(カットで落とした所が戻る)
      if (shots.length <= firstShotOfPiece) continue
      const last = shots[shots.length - 1]
      last.end = ev.start
      shots.push({ start: ev.start, end: piece.end, cameraId: next.id, reason })
      current = next
      shotStart = at
    }
    timeline += piece.end - piece.start
    prevEnd = piece.end
    prevScene = piece.sceneId
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
  return absorbSlivers(fixed)
}

import type { AsrJob } from '../transcript'
import type { Placement } from '../sync/solve'
import type { SpeechTurn } from './micTurns'

/**
 * 発話区間(共通の時間軸)を、音声認識にかける仕事(どの素材の何秒から何秒か)にする。
 * 発話はマイク(機材)ごとに決まっているので、その機材のうち発話の頭を録っている素材を探す。
 * 素材の切れ目をまたぐ発話は、その素材の終わりまでにする(続きは次の素材の発話として拾われる)。
 */

export interface TurnFile {
  id: string
  path: string
  sourceId: string
  duration: number
}

export interface TurnJob {
  job: AsrJob
  turn: SpeechTurn
  fileId: string
}

export function turnsToJobs(
  turns: readonly SpeechTurn[],
  files: readonly TurnFile[],
  placements: readonly Placement[]
): TurnJob[] {
  const place = new Map(placements.map((p) => [p.id, p]))
  const out: TurnJob[] = []
  turns.forEach((turn, i) => {
    for (const f of files) {
      if (f.sourceId !== turn.micId) continue
      const p = place.get(f.id)
      if (!p || p.method === 'none') continue
      const rate = p.rate || 1
      const fileStart = (turn.start - p.start) * rate
      if (fileStart < -0.2 || fileStart >= f.duration) continue
      const fileEnd = Math.min(f.duration, (turn.end - p.start) * rate)
      if (fileEnd - Math.max(0, fileStart) < 0.2) continue
      out.push({
        job: { id: `turn-${i}`, path: f.path, start: Math.max(0, fileStart), end: fileEnd },
        turn,
        fileId: f.id
      })
      return
    }
  })
  return out
}

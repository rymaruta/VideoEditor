import { fileAt, toSource, type MulticamFile, type MulticamInfo } from '../sync/multicam'

/**
 * 色合わせに使う時刻: そのカメラと基準カメラが**両方とも録っている**時間から、等間隔に `n` か所。
 * 同じ時刻なら光の条件が同じなので、カメラの違いだけが差として残る。
 */
export interface PairedSample {
  time: number
  file: MulticamFile
  sourceTime: number
  anchorFile: MulticamFile
  anchorTime: number
}

export function pairedSamples(info: MulticamInfo, sourceId: string, n = 8): PairedSample[] {
  const spans: { start: number; end: number }[] = []
  for (const f of info.files) {
    if (f.sourceId !== sourceId) continue
    const fEnd = f.start + f.duration / f.rate
    for (const a of info.files) {
      if (a.sourceId !== info.anchorSourceId) continue
      const start = Math.max(f.start, a.start)
      const end = Math.min(fEnd, a.start + a.duration / a.rate)
      if (end - start > 1) spans.push({ start, end })
    }
  }
  const total = spans.reduce((t, s) => t + (s.end - s.start), 0)
  if (total <= 0) return []
  const out: PairedSample[] = []
  for (let k = 0; k < n; k++) {
    let at = ((k + 0.5) / n) * total
    for (const s of spans) {
      const len = s.end - s.start
      if (at > len) {
        at -= len
        continue
      }
      const time = s.start + at
      const file = fileAt(info, sourceId, time)
      const anchorFile = fileAt(info, info.anchorSourceId, time)
      if (file && anchorFile)
        out.push({
          time,
          file,
          sourceTime: toSource(file, time),
          anchorFile,
          anchorTime: toSource(anchorFile, time)
        })
      break
    }
  }
  return out
}

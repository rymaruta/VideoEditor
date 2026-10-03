import { spawn, type ChildProcess } from 'child_process'
import { ffmpegPath, probeMedia } from './ffmpegService'
import { QcLogParser, qcFilter, type QcMeasurement } from '@shared/qc/media'

/**
 * 書き出した動画を1回通して、黒味・フリーズ・無音・ラウドネスを測る(計画書 §5.12)。
 * 判定は `@shared/qc/media` の `mediaIssues`(画面側)。ここは測るだけ。
 */
let running: ChildProcess | null = null

export async function measureExport(
  filePath: string,
  onProgress: (percent: number) => void
): Promise<QcMeasurement> {
  if (running) throw new Error('自動確認はすでに実行中です')
  const info = await probeMedia(filePath)
  const filter = qcFilter(info.hasVideo, info.hasAudio)
  const maps = [info.hasVideo ? ['-map', '[qv]'] : [], info.hasAudio ? ['-map', '[qa]'] : []].flat()
  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      filePath,
      '-filter_complex',
      filter,
      ...maps,
      '-f',
      'null',
      '-'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
  )
  running = child
  const parser = new QcLogParser()
  // ffmpeg の進み具合は改行ではなく \r で上書きされるので、両方で区切る(行を貯めない)
  let rest = ''
  let lastPercent = -1
  child.stderr!.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString()).split(/\r\n|\r|\n/)
    rest = parts.pop() ?? ''
    for (const line of parts) {
      parser.push(line)
      const m = /\btime=(\d+):(\d+):([\d.]+)/.exec(line)
      if (m && info.duration > 0) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        const p = Math.min(100, Math.floor((t / info.duration) * 100))
        if (p !== lastPercent) onProgress((lastPercent = p))
      }
    }
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  }).finally(() => {
    running = null
  })
  if (rest) parser.push(rest)
  if (code !== 0) throw new Error(code === null ? 'QC_CANCELED' : `自動確認に失敗しました(${code})`)
  return parser.result(info.duration)
}

export function cancelMeasureExport(): void {
  running?.kill()
}

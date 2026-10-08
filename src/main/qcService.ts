import { spawn, type ChildProcess } from 'child_process'
import { ffmpegPath, probeMedia } from './ffmpegService'
import { trackProcess } from './liveProcesses'
import { QcLogParser, qcFilter, type QcMeasurement } from '@shared/qc/media'

/**
 * 書き出した動画を1回通して、黒味・フリーズ・無音・ラウドネスを測る(計画書 §5.12)。
 * 判定は `@shared/qc/media` の `mediaIssues`(画面側)。ここは測るだけ。
 */
let running: ChildProcess | null = null
/**
 * 実行中か(ファイルを調べている間も含む)と、その間に押された中止。
 * ffmpeg を立ち上げる前(ファイルを調べている間)は `running` がまだ無いので、印が無いと
 * その間の中止は効かず、2回目の実行も通っていた
 */
let busy = false
let cancelRequested = false

export async function measureExport(
  filePath: string,
  onProgress: (percent: number) => void
): Promise<QcMeasurement> {
  if (busy) throw new Error('自動確認はすでに実行中です')
  busy = true
  cancelRequested = false
  try {
    return await measure(filePath, onProgress)
  } finally {
    busy = false
    cancelRequested = false
  }
}

async function measure(
  filePath: string,
  onProgress: (percent: number) => void
): Promise<QcMeasurement> {
  const info = await probeMedia(filePath)
  if (cancelRequested) throw new Error('QC_CANCELED')
  const filter = qcFilter(info.hasVideo, info.hasAudio, info.duration)
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
  const untrack = trackProcess(child)
  child.on('close', untrack)
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
  if (busy) cancelRequested = true
  running?.kill()
}

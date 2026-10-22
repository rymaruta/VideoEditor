import { readPcm, PCM_ALIGN_FILTER } from './audioPcm'
import { ffSeconds } from './ffArgs'
import {
  WAVE_PEAKS_MAX_COLUMNS,
  WavePeakAccumulator,
  peakSampleRate,
  type WavePeaks
} from '@shared/waveformPeaks'

/**
 * タイムラインの細かい波形の値(列ごとの符号付きの最大・最小と RMS、L/R 別)を作る。
 *
 * ffmpeg に生の音(f32le・2ch)を流させ、届いた分から列へ集計していく。配列に溜めないので、
 * 3 時間の素材でもメモリは列の数ぶん(列 × 2ch × 3 値)で一定。
 * 区間の扱いは画像の波形(`generateWaveformDataUrl`)と同じ: 音声の頭を時刻 0 にそろえ、
 * 区間の長さまで無音で埋める(音声が遅れて始まる素材・途中で終わる素材で横にずれない)。
 * モノラルの素材は L/R に同じ音が入る。
 */
export async function generateWaveformPeaks(
  ffmpegPath: string,
  filePath: string,
  start: number,
  end: number,
  columns: number
): Promise<WavePeaks> {
  const duration = Math.max(0.05, end - start)
  const cols = Math.max(1, Math.min(WAVE_PEAKS_MAX_COLUMNS, Math.round(columns)))
  const rate = peakSampleRate(cols, duration)
  const acc = new WavePeakAccumulator(cols, 2, duration * rate)
  await readPcm(
    ffmpegPath,
    [
      '-ss',
      ffSeconds(start),
      '-t',
      ffSeconds(duration),
      '-i',
      filePath,
      '-vn',
      '-af',
      `${PCM_ALIGN_FILTER},apad=whole_dur=${ffSeconds(duration)}`,
      '-ac',
      '2',
      '-ar',
      String(rate),
      '-f',
      'f32le',
      'pipe:1'
    ],
    (s) => acc.push(s)
  )
  return acc.finish()
}

import { trackUntilDone } from './liveProcesses'
import { spawn } from 'child_process'
import { ffmpegPath } from './ffmpegService'
import { ffSeconds } from './ffArgs'
import { describeFfmpegExit } from './ffmpegError'
import type {
  HighlightCandidate,
  HighlightSensitivity,
  ReferenceStyleAnalysis
} from '@shared/types'
import { DEFAULT_HIGHLIGHT_SENSITIVITY, highlightThreshold, loudnessStats } from '@shared/highlight'

function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = trackUntilDone(spawn(ffmpegPath, args))
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    proc.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      // Swallowing a non-zero exit here used to surface as "no highlights found"
      // for e.g. corrupt files or videos without an audio stream — report the real
      // failure instead of sending users hunting through fine footage.
      //
      // 文面は**自前で組まない**。組んでいたころは標準エラー出力の最終行をそのまま
      // 尾に付けており、「ファイルが見つかりません」のような見慣れた原因も英語のまま
      // 出ていた(実測 83文字。同じ原因で `probeMedia` は 31文字の日本語)。
      reject(describeFfmpegExit(code, stderr))
    })
  })
}

export async function detectSceneChanges(filePath: string): Promise<number[]> {
  const { stderr } = await runFfmpeg([
    '-i',
    filePath,
    '-vf',
    "select='gt(scene,0.3)',showinfo",
    '-f',
    'null',
    '-'
  ])
  const times: number[] = []
  const regex = /pts_time:([\d.]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(stderr))) {
    times.push(Number(match[1]))
  }
  return times
}

interface AudioLevel {
  time: number
  rmsDb: number
}

export async function detectAudioLevels(filePath: string): Promise<AudioLevel[]> {
  const { stdout } = await runFfmpeg([
    '-i',
    filePath,
    // **映像をデコードさせない。** 見るのは音量だけなのに、指定が無いと ffmpeg は
    // 映像も既定で拾って**全フレームをデコードして再エンコードし直す**(`-f null` は
    // 捨てるだけで、そこへ辿り着く手前の仕事は全部やっている)。
    // 実測(1920x1080・120秒): **4.94秒 → 0.23秒**。出力は1バイトも変わらない。
    // 長尺スキャンはこの関数1本で素材全体を舐めるので、そのまま尺に比例して効く
    // (2時間の録画なら 約5分 → 約14秒)。
    // **`-vn` は使わない。** 映像しか無いファイル(音声なしの録画)で出力ストリームが
    // 0本になり、**いままで「0件」で済んでいたものが `Error opening output files:
    // Invalid argument` という生の英語の失敗に変わる**(実測: 終了コード 234)。
    // `-c:v copy` ならデコードだけをやめられて、ストリームの選ばれ方も終了コードも
    // 従来どおり(実測: 音声なしの素材は現状と同じ rc=0・0件)。
    '-c:v',
    'copy',
    '-af',
    'asetnsamples=n=44100,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'null',
    '-'
  ])
  const levels: AudioLevel[] = []
  const lines = stdout.split('\n')
  let pendingTime: number | null = null
  for (const line of lines) {
    const timeMatch = /pts_time:([\d.]+)/.exec(line)
    if (timeMatch) {
      pendingTime = Number(timeMatch[1])
      continue
    }
    const rmsMatch = /RMS_level=(-?[\d.]+)/.exec(line)
    if (rmsMatch && pendingTime !== null) {
      const rms = Number(rmsMatch[1])
      if (Number.isFinite(rms)) levels.push({ time: pendingTime, rmsDb: rms })
      pendingTime = null
    }
  }
  return levels
}

const CANDIDATE_LEAD_IN = 1
const CANDIDATE_TAIL = 3
const ADJACENT_PEAK_GAP = 1.5
const SCENE_MATCH_WINDOW = 2
const MIN_HIGHLIGHT_CANDIDATES = 12
const MAX_HIGHLIGHT_CANDIDATES = 40
const CANDIDATES_PER_SECOND_DIVISOR = 8

// Longer source footage tends to contain more distinct highlight moments; a fixed
// cap discards genuinely good candidates once a video runs past a couple of
// minutes. Scale the cap with duration instead, while keeping short-clip behavior
// unchanged.
function highlightCandidateLimit(assetDuration: number): number {
  return Math.min(
    MAX_HIGHLIGHT_CANDIDATES,
    Math.max(MIN_HIGHLIGHT_CANDIDATES, Math.round(assetDuration / CANDIDATES_PER_SECOND_DIVISOR))
  )
}

export async function detectHighlights(
  filePath: string,
  assetDuration: number,
  sensitivity: HighlightSensitivity = DEFAULT_HIGHLIGHT_SENSITIVITY
): Promise<HighlightCandidate[]> {
  const [sceneTimes, audioLevels] = await Promise.all([
    detectSceneChanges(filePath),
    detectAudioLevels(filePath)
  ])

  const { mean, stddev } = loudnessStats(audioLevels.map((l) => l.rmsDb))
  const threshold = highlightThreshold(mean, stddev, sensitivity)

  // Highlights are driven by loud/energetic audio moments; scene changes only
  // boost the score of a window they happen to fall within (cuts alone are too
  // frequent in ordinary footage to be a standalone "highlight" signal).
  const peakFrames = audioLevels.filter((l) => l.rmsDb > threshold)

  interface PeakGroup {
    start: number
    end: number
    intensity: number
  }
  const peakGroups: PeakGroup[] = []
  for (const frame of peakFrames) {
    const last = peakGroups[peakGroups.length - 1]
    const intensity = (frame.rmsDb - mean) / (stddev || 1)
    if (last && frame.time <= last.end + ADJACENT_PEAK_GAP) {
      last.end = frame.time
      last.intensity += intensity
    } else {
      peakGroups.push({ start: frame.time, end: frame.time, intensity })
    }
  }

  const candidates: HighlightCandidate[] = peakGroups.map((group) => {
    const start = Math.max(0, group.start - CANDIDATE_LEAD_IN)
    const end = Math.min(assetDuration, group.end + CANDIDATE_TAIL)
    const hasSceneChange = sceneTimes.some(
      (t) => t >= group.start - SCENE_MATCH_WINDOW && t <= group.end + SCENE_MATCH_WINDOW
    )
    return {
      start,
      end,
      score: group.intensity + (hasSceneChange ? 2 : 0),
      hasSceneChange,
      hasAudioPeak: true
    }
  })

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, highlightCandidateLimit(assetDuration))
}

/**
 * 候補区間の「画がどれだけ動いたか」を測る。
 *
 * **区間の全フレームはデコードしない。** `-skip_frame nokey` でキーフレームだけを取り出し、
 * 64x36 に縮めて `signalstats` の YDIF(前フレームとの平均差分)を読む。シーンの切り替わりも
 * 動きの大きさも、同じ1つの値として拾える。
 *
 * 測れなかった区間(キーフレームが1枚以下)は `null` を返す。0 を返すと「動きが無い区間」と
 * 区別できず、キーフレームが疎なだけの区間を不当に落としてしまう。
 */
export async function measureVisualActivity(
  filePath: string,
  ranges: { start: number; end: number }[]
): Promise<(number | null)[]> {
  const results: (number | null)[] = []
  for (const range of ranges) {
    const duration = range.end - range.start
    if (!Number.isFinite(duration) || duration <= 0) {
      results.push(null)
      continue
    }
    const { stdout } = await runFfmpeg([
      '-skip_frame',
      'nokey',
      '-ss',
      ffSeconds(range.start),
      '-t',
      ffSeconds(duration),
      '-i',
      filePath,
      '-an',
      '-vf',
      'scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YDIF:file=-',
      '-fps_mode',
      'passthrough',
      '-f',
      'null',
      '-'
    ])
    const values: number[] = []
    const regex = /lavfi\.signalstats\.YDIF=([\d.]+)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(stdout))) {
      const value = Number(match[1])
      if (Number.isFinite(value)) values.push(value)
    }
    // 1枚目は比較相手がおらず必ず 0 になるので、差分として意味があるのは2枚目以降。
    results.push(
      values.length < 2 ? null : values.slice(1).reduce((s, v) => s + v, 0) / (values.length - 1)
    )
  }
  return results
}

export async function analyzeReferenceStyle(filePath: string): Promise<ReferenceStyleAnalysis> {
  const cutTimes = await detectSceneChanges(filePath)
  return { cutTimes }
}

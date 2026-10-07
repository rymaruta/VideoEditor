import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, join } from 'path'
import { cachedEnvelope } from './audioPcm'
import { guessTrackRole, quietRatio, type ExtractedTrack } from '@shared/ingest/tracks'
import type { ProbedFile } from '@shared/ingest/classify'

/**
 * OBS の複数音声トラックの録画から、トラックごとに音声ファイルを取り出す(`docs/GAME_AUTO_EDIT_PLAN.md` G2)。
 *
 * 取り出したファイルは、ふつうのマイクの録音と同じように同期・文字起こし・書き出しに使える
 * (動画の2本目以降のトラックを直接読む仕組みを、全部の読み手に足すより確実)。
 * 素材そのものはコピーしない約束なので、置き場所は解析のキャッシュと同じ所(userData)。
 * 同じ録画は2回目から取り出さない(元の大きさ・更新時刻が同じなら使い回す)。
 * AAC はそのまま写す(速い・音が変わらない)。それ以外は AAC に直す。
 */

export interface AudioStreamInfo {
  /** 音声トラックの番号(0 から) */
  index: number
  codec?: string
  title?: string
}

function run(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(
      ffmpegPath,
      args,
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, _o, stderr) =>
        err ? reject(new Error(String(stderr).trim().split('\n').pop() || err.message)) : resolve()
    )
  )
}

/** 取り出したトラックの置き場所(元の録画のパス・大きさ・更新時刻ごとに決まる) */
export function trackPath(
  outDir: string,
  video: string,
  size: number,
  mtimeMs: number,
  index: number
): string {
  const key = createHash('sha1').update(`${video}|${size}|${mtimeMs}`).digest('hex').slice(0, 16)
  const stem = basename(video).replace(/\.[^.]+$/, '')
  return join(outDir, `${stem}_${key}_track${index + 1}.m4a`)
}

async function extractOne(
  ffmpegPath: string,
  video: string,
  stream: AudioStreamInfo,
  out: string
): Promise<void> {
  if (existsSync(out)) return
  mkdirSync(join(out, '..'), { recursive: true })
  // 途中で止まったときに壊れたファイルを使わないよう、別名に書いてから名前を替える
  const partial = `${out}.partial.m4a`
  const codec = stream.codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k']
  try {
    await run(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-i',
      video,
      '-map',
      `0:a:${stream.index}`,
      '-vn',
      ...codec,
      partial
    ])
    renameSync(partial, out)
  } finally {
    rmSync(partial, { force: true })
  }
}

/**
 * 録画の音声トラックを全部取り出し、取り出したファイルを素材として返す(役割を推し量って付ける)。
 * 1本しかなければ何もしない(空)
 */
export async function extractAudioTracks(
  ffmpegPath: string,
  outDir: string,
  cacheDir: string,
  video: ProbedFile & { mtimeMs: number },
  streams: readonly AudioStreamInfo[]
): Promise<(ProbedFile & { mtimeMs: number })[]> {
  if (streams.length < 2) return []
  const out: (ProbedFile & { mtimeMs: number })[] = []
  for (const s of streams) {
    const path = trackPath(outDir, video.path, video.size, video.mtimeMs, s.index)
    await extractOne(ffmpegPath, video.path, s, path)
    const st = statSync(path)
    const env = await cachedEnvelope(ffmpegPath, cacheDir, {
      path,
      size: st.size,
      mtimeMs: st.mtimeMs
    })
    const track: ExtractedTrack = {
      parentPath: video.path,
      parentRelativePath: video.relativePath,
      index: s.index,
      ...(s.title ? { title: s.title } : {}),
      role: guessTrackRole(s.index, s.title, quietRatio(env))
    }
    out.push({
      path,
      relativePath: `${video.relativePath} · トラック${s.index + 1}`,
      duration: video.duration,
      hasVideo: false,
      hasAudio: true,
      recordedAt: video.recordedAt,
      device: video.device,
      size: st.size,
      mtimeMs: st.mtimeMs,
      track
    })
  }
  return out
}

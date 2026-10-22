import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import { cachedEnvelope } from './audioPcm'
import { trackUntilDone } from './liveProcesses'
import { contentFingerprint } from './fileFingerprint'
import {
  guessTrackRole,
  isSilentEnvelope,
  quietRatio,
  type ExtractedTrack
} from '@shared/ingest/tracks'
import type { ProbedFile } from '@shared/ingest/classify'
import { NO_SOURCE_METADATA_ARGS } from '@shared/sourceVideo'

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
  return new Promise((resolve, reject) => {
    trackUntilDone(
      execFile(
        ffmpegPath,
        args,
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, _o, stderr) =>
          err
            ? reject(new Error(String(stderr).trim().split('\n').pop() || err.message))
            : resolve()
      )
    )
  })
}

/** 取り出したトラックの置き場所(元の録画のパス・大きさ・更新時刻ごとに決まる) */
export function trackPath(
  outDir: string,
  video: string,
  size: number,
  mtimeMs: number,
  index: number
): string {
  const key = createHash('sha1')
    .update(`${video}|${size}|${mtimeMs}|${contentFingerprint(video)}`)
    .digest('hex')
    .slice(0, 16)
  const stem = basename(video).replace(/\.[^.]+$/, '')
  return join(outDir, `${stem}_${key}_track${index + 1}.m4a`)
}

/**
 * 作っている途中のトラック。同じ出力を同時に頼まれたら1回にまとめる
 * (`ensurePreviewProxy` の `inFlight`・ノイズ除去の `runOne` と同じ考え方)。
 *
 * 収録フォルダの読み取りは、ダイアログを Esc で閉じて「新しい回」から同じフォルダを選び直すと
 * **main 側で2本が重なって走る**(1本目は止まらない)。まとめずにいると2本の ffmpeg が
 * 同じ一時ファイルへ書き、片方の後始末がもう片方の書きかけを消していた
 * (実測: 2本目が `ENOENT: … rename '…_track1.m4a.partial.m4a'` で失敗し、
 *  読み取りは「1本目だけを使う」側へ落ちた。名前を替える瞬間がずれれば、
 *  **書きかけのファイルが完成品の名前に入り**、次からは `existsSync` だけで使い回される)。
 */
const inFlight = new Map<string, Promise<void>>()
/** 一時ファイルの名前を実行ごとに変えるための連番(同じミリ秒に2本始まっても重ならない) */
let partialSequence = 0

function extractOne(
  ffmpegPath: string,
  video: string,
  stream: AudioStreamInfo,
  out: string
): Promise<void> {
  if (existsSync(out)) return Promise.resolve()
  const shared = inFlight.get(out)
  if (shared) return shared
  const task = extractOneUnshared(ffmpegPath, video, stream, out).finally(() => {
    if (inFlight.get(out) === task) inFlight.delete(out)
  })
  inFlight.set(out, task)
  return task
}

async function extractOneUnshared(
  ffmpegPath: string,
  video: string,
  stream: AudioStreamInfo,
  out: string
): Promise<void> {
  mkdirSync(join(out, '..'), { recursive: true })
  // 途中で止まったときに壊れたファイルを使わないよう、別名に書いてから名前を替える。
  // 別名は**実行ごとに別**にする(ノイズ除去と同じ)。固定の名前だと、まとめ損ねた別の実行
  // (別のプロセスなど)の書きかけを、こちらが完成品の名前へ替えたり消したりしてしまう。
  // 完成品の名前の後ろへは足さず、同じフォルダに**長さの決まった**名前で置く
  // (録画の名前が長いと、一時ファイルだけが1要素 255バイトの上限を先に超えるため。
  //  企画の保存 `saveProjectFile` と同じ直し方)
  const partial = join(
    dirname(out),
    `.track-${process.pid}-${Date.now()}-${partialSequence++}.partial.m4a`
  )
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
      // 録画のメタデータ・チャプターを取り出した音声へ写さない(BGM と同じく、書き出しへ持ち込まれる)
      ...NO_SOURCE_METADATA_ARGS,
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
      role: guessTrackRole(s.index, s.title, quietRatio(env), isSilentEnvelope(env))
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

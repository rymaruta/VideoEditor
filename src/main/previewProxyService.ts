import ffmpeg from 'fluent-ffmpeg'
import { app } from 'electron'
import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, join } from 'path'
import { describeFfmpegError } from './ffmpegError'
import { isShuttingDown, trackUntilDone } from './liveProcesses'
import { detectVideoEncoder } from './segmentRenderer'
import { contentFingerprint } from './fileFingerprint'
import { probeSourceVideo, sourceVideoFilterFor } from './ffmpegService'
import { NO_SOURCE_METADATA_ARGS, SDR_COLOR_TAG_ARGS, isHdrTransfer } from '@shared/sourceVideo'
import {
  isMonoChannelCount,
  isMultiChannelCount,
  normalizeChannelLayout,
  monoUpmixFilter,
  multiChannelDownmixFilter
} from '@shared/audioUpmix'

/**
 * Codecs Chromium's <video> can decode. Everything else has to be transcoded before
 * it can be previewed. This is an allow-list on purpose: an unknown codec failing to
 * play silently is much worse than transcoding something that would have played.
 *
 * H.265/HEVC is the notable absence — Chromium ships without a decoder for licensing
 * reasons, and it is what most game-capture tools (ShadowPlay, iPhone, capture cards)
 * record in.
 */
const PREVIEWABLE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const PREVIEWABLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le'])

export function needsPreviewProxy(
  videoCodec: string,
  audioCodec: string,
  hasVideo: boolean,
  hasAudio: boolean,
  audioChannels?: number,
  audioLayout?: string
): boolean {
  if (hasVideo && !PREVIEWABLE_VIDEO_CODECS.has(videoCodec)) return true
  if (hasAudio && !PREVIEWABLE_AUDIO_CODECS.has(audioCodec)) return true
  if (hasAudio && isFourPointZero(audioChannels, audioLayout)) return true
  return false
}

/**
 * 4.0(L・R・センター・後ろ中央)の音声。Chromium はどの 4ch も quad として畳む(センターが左だけに
 * なる)ので、書き出しと同じ畳み方をした試聴用の素材で聞かせる
 */
export function isFourPointZero(channels: number | undefined, layout: string | undefined): boolean {
  return channels === 4 && layout === '4.0'
}

interface ProxyStreamInfo {
  audioCodec: string
  hasAudio: boolean
  /** 映像が透過(アルファ)を持つ(版面CG の ProRes 4444・QuickTime Animation など) */
  hasAlpha: boolean
  /** 0 は「分からなかった」。等倍のモノラル展開を掛けてよいのは 1 のときだけ。 */
  audioChannels: number
  /** 音声の並び(4.0・quad など)。4ch の畳み方を書き出しとそろえる */
  audioLayout?: string
}

function probeStreams(filePath: string): Promise<ProxyStreamInfo> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      // 調べられなかったのに「音なし」で作ると、無音の試聴用素材がずっと使われ続ける
      if (err || !data)
        return reject(
          new Error(
            // ffprobe の失敗は版数・ビルド設定の羅列を含むので、短い日本語にする
            `素材を調べられませんでした: ${err ? describeFfmpegError(err).message : filePath}`
          )
        )
      const audio = data.streams.find((s) => s.codec_type === 'audio')
      const video = data.streams.find((s) => s.codec_type === 'video')
      resolve({
        hasAlpha: hasAlphaPixelFormat(String(video?.pix_fmt ?? '')),
        audioCodec: audio?.codec_name ?? '',
        hasAudio: Boolean(audio),
        audioChannels: audio?.channels ?? 0,
        audioLayout: normalizeChannelLayout(audio?.channel_layout)
      })
    })
  })
}

function proxyDir(): string {
  const dir = join(app.getPath('userData'), 'preview-proxies')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Keyed by path + size + mtime rather than by asset id, so re-importing the same file
 * (or opening a saved project) reuses the existing proxy instead of transcoding again,
 * while a file that was edited in place still gets a fresh one.
 */
function proxyPathFor(
  filePath: string,
  ext: 'mp4' | 'webm',
  identity: ProxySourceIdentity | null
): string {
  // 同じ大きさ・同じ更新時刻のファイルへ差し替えても前の変換を使わないよう、中身の目印も足す
  const stamp = identity ? `${identity.size}:${identity.mtimeMs}:${identity.fingerprint}` : ''
  const key = createHash('sha1').update(`${filePath}|${stamp}`).digest('hex').slice(0, 16)
  return join(proxyDir(), `${key}.${ext}`)
}

/**
 * プロキシを作ったときの元ファイルの身元(大きさ・更新時刻・中身の目印)。
 * プロキシの隣に `<プロキシ>.source.json` として残し、開いたときに今の元ファイルと比べる
 * (`checkPreviewProxy`)
 */
export interface ProxySourceIdentity {
  size: number
  mtimeMs: number
  fingerprint: string
}

/** 元ファイルの今の身元。読めなければ null */
export function sourceIdentity(filePath: string): ProxySourceIdentity | null {
  try {
    const st = statSync(filePath)
    return { size: st.size, mtimeMs: st.mtimeMs, fingerprint: contentFingerprint(filePath) }
  } catch {
    return null
  }
}

function identityRecordPath(proxyPath: string): string {
  return `${proxyPath}.source.json`
}

function writeIdentityRecord(proxyPath: string, identity: ProxySourceIdentity | null): void {
  if (!identity) return
  try {
    writeFileSync(identityRecordPath(proxyPath), JSON.stringify(identity))
  } catch {
    // 記録できなくてもプロキシは使える。開いたときは名前での照合(下)に戻る
  }
}

function readIdentityRecord(proxyPath: string): ProxySourceIdentity | null {
  try {
    const raw = JSON.parse(readFileSync(identityRecordPath(proxyPath), 'utf-8'))
    if (
      typeof raw?.size === 'number' &&
      typeof raw?.mtimeMs === 'number' &&
      typeof raw?.fingerprint === 'string'
    )
      return { size: raw.size, mtimeMs: raw.mtimeMs, fingerprint: raw.fingerprint }
  } catch {
    // 記録が無い(前の版で作ったプロキシ)・壊れている
  }
  return null
}

/**
 * 保存されていたプロキシが、**今の**元ファイルから作ったものか。
 *
 * - `current`: 今の元ファイルと身元が一致する(そのまま使ってよい)
 * - `stale`: 元ファイルが差し替わっている(大きさ・更新時刻・中身の目印のどれかが違う)
 * - `unverified`: 身元の記録が無く、名前からも確かめられない(前の版で作ったプロキシ)
 * - `sourceMissing`: 元ファイルが読めない(移動・削除。比べようが無いのでプロキシは外さない。
 *   書き出しは別に「素材が見つからない」で止まる)
 *
 * 以前は `proxyPath` が再生できれば無条件に使っていたので、元ファイルを同じ名前で差し替えると
 * **プレビューは古いプロキシ(前の撮影)のまま、書き出しは新しいファイル**を読み、
 * 見えているものと違う動画が書き出されていた(実測: 2秒のテイクから作ったプロキシは、元を同じ名前の
 * 4秒の別テイクに差し替えたあとも再生できるので、開き直してもプレビューは 2秒の前のテイクのまま、
 * 書き出しは 4秒の新しいテイクを読んだ)。
 *
 * 記録の無い前の版のプロキシは、**名前で確かめる**: プロキシの名前は「パス・大きさ・更新時刻・
 * 中身の目印」のハッシュなので、今の元ファイルから計算した名前と同じなら同じ元から作ったと言える
 * (64KB×2 を読むだけで安い)。違えば、古い鍵の版で作ったか差し替わったかを見分けられないので
 * `unverified` とし、画面側は差し替わったときと同じく作り直す(古い絵を見せ続けるより、
 * 一度変換し直すほうを選ぶ)
 */
export function checkPreviewProxy(
  filePath: string,
  proxyPath: string
): 'current' | 'stale' | 'unverified' | 'sourceMissing' {
  const now = sourceIdentity(filePath)
  if (!now) return 'sourceMissing'
  const recorded = readIdentityRecord(proxyPath)
  if (recorded)
    return recorded.size === now.size &&
      recorded.mtimeMs === now.mtimeMs &&
      recorded.fingerprint === now.fingerprint
      ? 'current'
      : 'stale'
  const name = basename(proxyPath)
  const expected = [proxyPathFor(filePath, 'mp4', now), proxyPathFor(filePath, 'webm', now)]
  return expected.some((p) => basename(p) === name) ? 'current' : 'unverified'
}

/** 透過(アルファ)を持つ画素の形式か(yuva420p・rgba・argb・gbrap・ya8 など) */
export function hasAlphaPixelFormat(pixFmt: string): boolean {
  return /^(yuva|gbra|ya\d)|^(rgba|bgra|argb|abgr)|^rgba64|^bgra64/.test(pixFmt)
}

// Concurrent imports of the same file would otherwise race on the same output path and
// produce a truncated proxy; the second caller waits on the first one's promise instead.
//
// **進捗の宛先は1人ではなく全員。** 同じファイルを2回読み込むと素材は2件になり、
// メディア一覧の行も2つ出る。変換は1回で済ませるのが正しいが、進捗を**最初の1人に
// しか流さない**と、2つ目の行は**変換が終わるまで 0% のまま固まって見える**
// (実測: 60秒のHEVCで 1人目は10回進捗を受け取り、2人目・3人目は**0回**)。
// 待っている人が増えたら、その人の受け口も足す。
interface ProxyJob {
  promise: Promise<string>
  listeners: Set<(percent: number) => void>
}
const inFlight = new Map<string, ProxyJob>()

export function ensurePreviewProxy(
  filePath: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  // 変換に使う元ファイルの身元は、変換を始める前に1回だけ測る(名前の鍵とプロキシの隣の記録に同じ値を使う。
  // 変換中に差し替えられたら、記録は前の身元のままなので、次に開いたとき `stale` になって作り直される)
  const identity = sourceIdentity(filePath)
  const outPath = proxyPathFor(filePath, 'mp4', identity)
  if (existsSync(outPath)) return Promise.resolve(outPath)
  // 透過を持つ素材(版面CG)は、透過を保てる VP9(WebM)で作る。H.264 にすると背景が黒く塗られる
  const alphaPath = proxyPathFor(filePath, 'webm', identity)
  if (existsSync(alphaPath)) return Promise.resolve(alphaPath)
  const running = inFlight.get(outPath)
  if (running) {
    if (onProgress) running.listeners.add(onProgress)
    return running.promise
  }
  const listeners = new Set<(percent: number) => void>()
  if (onProgress) listeners.add(onProgress)
  // 1人の受け口が投げても、他の人への通知と変換そのものを巻き込まない。
  const notifyProgress = (percent: number): void => {
    for (const listener of listeners) {
      try {
        listener(percent)
      } catch {
        // 進捗を受け取れない相手が居ても、変換は続ける。
      }
    }
  }

  // Written to a temporary name and renamed only on success, so an interrupted run
  // can never leave a half-written file that would later be treated as a valid cache.
  const task = Promise.all([
    probeStreams(filePath),
    detectVideoEncoder(),
    sourceVideoFilterFor(filePath),
    probeSourceVideo(filePath)
  ])
    .then(
      ([
        { audioCodec, hasAudio, hasAlpha, audioChannels, audioLayout },
        encoder,
        sourceFilter,
        sourceInfo
      ]) =>
        new Promise<string>((resolve, reject) => {
          const finalPath = hasAlpha ? alphaPath : outPath
          const tmpPath = hasAlpha ? `${alphaPath}.partial.webm` : `${outPath}.partial.mp4`
          if (hasAlpha) {
            // VP9 のアルファ付き。WebM には AAC を入れられないので音は Opus にする
            const command = ffmpeg(filePath)
              .videoCodec('libvpx-vp9')
              .outputOptions(NO_SOURCE_METADATA_ARGS)
              .outputOptions([
                `-vf ${sourceFilter}scale=-2:min(540\\,trunc(ih/2)*2)`,
                '-pix_fmt yuva420p',
                '-b:v 0',
                '-crf 34',
                '-deadline realtime',
                '-cpu-used 8',
                '-row-mt 1',
                '-auto-alt-ref 0'
              ])
            if (hasAudio) {
              command.audioCodec('libopus').outputOptions(['-ac 2'])
              // 透過の素材も、書き出しと同じ大きさで聞かせる(下の H.264 の経路と同じ理由。
              // モノラルの素材の試聴だけが 3dB 小さく、3ch 以上は畳み方が書き出しと違っていた)
              if (isMonoChannelCount(audioChannels)) command.audioFilters(monoUpmixFilter())
              else if (isMultiChannelCount(audioChannels))
                command.audioFilters(
                  multiChannelDownmixFilter(undefined, audioChannels, audioLayout)
                )
            } else command.noAudio()
            command
              .on('progress', (p) => {
                if (typeof p.percent === 'number')
                  notifyProgress(Math.max(0, Math.min(100, Math.round(p.percent))))
              })
              .on('error', (err, _stdout, stderr) => {
                rmSync(tmpPath, { force: true })
                reject(describeFfmpegError(err, stderr))
              })
              .on('end', () => {
                try {
                  renameSync(tmpPath, finalPath)
                  writeIdentityRecord(finalPath, identity)
                  resolve(finalPath)
                } catch (e) {
                  rmSync(tmpPath, { force: true })
                  reject(e)
                }
              })
            // 起こす前の kill は効かないので、起きた時点で閉じている最中なら止める(trackUntilDone)
            trackUntilDone(command, ['end', 'error'])
            command.save(tmpPath)
            return
          }
          const encode = (gpu: boolean): void => {
            const command = ffmpeg(filePath)
            if (gpu) {
              // GPU(NVIDIA)で読んで GPU で書く。4K・HEVC の多カメラの素材は CPU だと
              // 何時間もかかる。読み(NVDEC)は使えない形式なら ffmpeg が自動で CPU に戻す
              command
                .inputOptions(['-hwaccel cuda'])
                .videoCodec('h264_nvenc')
                .outputOptions(['-preset p4', '-rc vbr', '-cq 30', '-b:v 0'])
            } else command.videoCodec('libx264').outputOptions(['-preset veryfast', '-crf 28'])
            command.outputOptions([
              // 540p is plenty for a preview and roughly halves both the encode time and
              // the file size versus 720p. Export is unaffected — it reads the original.
              // インターレースの解除・HDR のトーンマッピングは書き出しと同じものを先に掛ける
              // (8bit の H.264 に PQ・HLG の符号値とタグを残したまま作り、プレビューと書き出しで
              //  見え方が違っていた)
              `-vf ${sourceFilter}scale=-2:min(540\\,trunc(ih/2)*2)`,
              '-pix_fmt yuv420p',
              '-movflags +faststart'
            ])
            command.outputOptions(NO_SOURCE_METADATA_ARGS)
            // HDR を BT.709 へ寄せたので、タグもそう書く(素材の PQ・HLG のタグを写さない)
            if (isHdrTransfer(sourceInfo?.colorTransfer)) command.outputOptions(SDR_COLOR_TAG_ARGS)
            // Re-encoding audio that the preview can already play is wasted time; only the
            // video stream is actually the problem in the common HEVC case.
            if (!hasAudio) command.noAudio()
            else if (
              PREVIEWABLE_AUDIO_CODECS.has(audioCodec) &&
              !isFourPointZero(audioChannels, audioLayout)
            )
              command.audioCodec('copy')
            else {
              command.audioCodec('aac').outputOptions(['-ac 2'])
              // `-ac 2` の裏の swresample は**モノラルを左右へ 1/√2 で配る**ので、
              // 変換した素材だけ試聴が 3dB 小さくなる。同じモノラルでも H.264 の素材は
              // そのまま再生されて等倍なので、**素材の符号化方式で音量が変わる**——
              // しかも書き出しは等倍で出る(理由は `@shared/audioUpmix`)。
              // 実測: mono の 200Hz を `-ac 2` だけで変換すると max -24.1 → -26.6 dB、
              // この一段を足すと -23.7 dB(AAC の誤差ぶんを含めて等倍)。
              if (isMonoChannelCount(audioChannels)) {
                command.audioFilters(monoUpmixFilter())
              } else if (isMultiChannelCount(audioChannels)) {
                // 3ch 以上を畳むときは、`-ac 2` の裏の swresample が**浮動小数の出力では
                // 行列の正規化を外す**ので、試聴だけが持ち上がって割れる。書き出しと
                // 同じく明示して戻す(理由は `@shared/audioUpmix`)。
                // 実測(無相関な5.1): `-ac 2` だけだと mean -10.9 dB・ピーク 0.0 dB で
                // **430サンプルが 0dBFS に張り付く**。この一段を足すと -18.6 dB・-5.6 dB。
                // ここを通るのは AC-3 / DTS のように**そのまま再生できない音声**で、
                // それはまさに 5.1 を運んでいる形式でもある。
                command.audioFilters(
                  multiChannelDownmixFilter(undefined, audioChannels, audioLayout)
                )
              }
            }
            command
              .on('progress', (p) => {
                if (typeof p.percent === 'number') {
                  notifyProgress(Math.max(0, Math.min(100, Math.round(p.percent))))
                }
              })
              .on('error', (err, _stdout, stderr) => {
                rmSync(tmpPath, { force: true })
                // GPU で失敗したら(同時に開ける数の上限・ドライバ)、CPU で作り直す。
                // アプリを閉じるために止めたのなら作り直さない
                if (gpu && !isShuttingDown()) {
                  notifyProgress(0)
                  encode(false)
                } else reject(describeFfmpegError(err, stderr))
              })
              .on('end', () => {
                try {
                  renameSync(tmpPath, outPath)
                  writeIdentityRecord(outPath, identity)
                  resolve(outPath)
                } catch (e) {
                  rmSync(tmpPath, { force: true })
                  reject(e)
                }
              })
            // 起こす前の kill は効かないので、起きた時点で閉じている最中なら止める(trackUntilDone)
            trackUntilDone(command, ['end', 'error'])
            command.save(tmpPath)
          }
          encode(encoder === 'h264_nvenc')
        })
    )
    .finally(() => {
      inFlight.delete(outPath)
      listeners.clear()
    })

  inFlight.set(outPath, { promise: task, listeners })
  return task
}

import { spawn } from 'child_process'
import os from 'os'
import {
  HW_ENCODERS,
  lastErrorLine,
  parseEncoderList,
  SPEED_TEST_FPS,
  SPEED_TEST_SECONDS,
  SPEED_TEST_SIZE,
  gpuDevicesFromInfo,
  type EncoderCheck,
  type EnvCheckProgress,
  type EnvCheckResult,
  type HwEncoder,
  type LocalAiCheck,
  type SpeedResult,
  type WhisperCheck
} from '@shared/envCheck'
import { sanitizeLogText } from './crashLog'

/**
 * 環境チェック(ヘルプ > 環境チェック…)の本体。Electron に頼る所(GPU の情報・ローカル AI の判定を
 * 別プロセスで動かす)は呼び出し側(envCheckService)から渡す。ffmpeg は差し替えられる(試験は偽の
 * ffmpeg で、エンコーダの判定・速さの測り方を確かめる)。
 */

export interface FfmpegRun {
  code: number | null
  stdout: string
  stderr: string
  /** かかった時間(ミリ秒) */
  ms: number
}

export type FfmpegRunner = (args: string[], signal?: AbortSignal) => Promise<FfmpegRun>

/** ffmpeg を動かして、終わるまで待つ(止められたら終了コード null) */
export function spawnFfmpeg(ffmpegPath: string, timeoutMs = 180_000): FfmpegRunner {
  return (args, signal) =>
    new Promise((resolve) => {
      const started = Date.now()
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (code: number | null, extra = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ code, stdout, stderr: stderr + extra, ms: Date.now() - started })
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(ffmpegPath, args, { windowsHide: true })
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: String(e), ms: 0 })
        return
      }
      const onAbort = (): void => {
        child.kill('SIGKILL')
        finish(null, '\n止めました')
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(null, `\n${Math.round(timeoutMs / 1000)} 秒で終わらなかったので止めました`)
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort)
      child.stdout?.on('data', (c: Buffer) => {
        if (stdout.length < 256 * 1024) stdout += c.toString()
      })
      child.stderr?.on('data', (c: Buffer) => {
        stderr = (stderr + c.toString()).slice(-16 * 1024)
      })
      child.on('error', (e) => finish(null, `\n${e.message}`))
      child.on('close', (code) => finish(code))
    })
}

/** エンコーダの試し書き出し(小さな絵を少しだけ)の引数 */
export function trialArgs(encoder: string): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=256x144:r=30:d=0.2',
    '-c:v',
    encoder,
    '-f',
    'null',
    '-'
  ]
}

/** 書き出しの速さを測る引数。CPU は書き出しと同じ x264 veryfast、ハードウェアは目安の画質 */
export function speedArgs(encoder: string): string[] {
  const input = [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=${SPEED_TEST_SIZE}:r=${SPEED_TEST_FPS}:d=${SPEED_TEST_SECONDS}`
  ]
  const codec =
    encoder === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']
      : encoder.endsWith('_nvenc')
        ? ['-c:v', encoder, '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-b:v', '0']
        : ['-c:v', encoder, '-b:v', '8M']
  return [...input, ...codec, '-f', 'null', '-']
}

/** ffmpeg の版(1 行目)と、ハードウェアのエンコーダが使えるか */
export async function checkEncoders(
  run: FfmpegRunner,
  signal?: AbortSignal,
  onEach?: (encoder: HwEncoder) => void
): Promise<{ version: string; encoders: EncoderCheck[] }> {
  const ver = await run(['-hide_banner', '-version'], signal)
  const version = (ver.stdout.split(/\r?\n/)[0] ?? '').replace(/\s*Copyright.*$/, '').trim()
  const list = await run(['-hide_banner', '-encoders'], signal)
  const listed = parseEncoderList(list.stdout)
  const encoders: EncoderCheck[] = []
  for (const encoder of HW_ENCODERS) {
    if (signal?.aborted) break
    onEach?.(encoder)
    if (!listed.has(encoder)) {
      encoders.push({ encoder, listed: false, usable: false })
      continue
    }
    const r = await run(trialArgs(encoder), signal)
    encoders.push(
      r.code === 0
        ? { encoder, listed: true, usable: true }
        : {
            encoder,
            listed: true,
            usable: false,
            error: lastErrorLine(r.stderr) || `終了コード ${r.code}`
          }
    )
  }
  return { version, encoders }
}

/** 1 つのエンコーダで、試し映像を書く速さ */
export async function measureSpeed(
  run: FfmpegRunner,
  encoder: string,
  signal?: AbortSignal
): Promise<SpeedResult> {
  const r = await run(speedArgs(encoder), signal)
  if (r.code !== 0)
    return {
      encoder,
      seconds: null,
      speed: null,
      error: lastErrorLine(r.stderr) || `終了コード ${r.code}`
    }
  const seconds = Math.max(0.001, r.ms / 1000)
  return { encoder, seconds, speed: SPEED_TEST_SECONDS / seconds }
}

/** 結果の中の文字を全部伏せる(API キー・パスの中の利用者名)。形はそのまま */
export function redactResult<T>(value: T, home?: string): T {
  if (typeof value === 'string')
    return sanitizeLogText(value, home, { maxChars: Number.POSITIVE_INFINITY }) as T
  if (Array.isArray(value)) return value.map((v) => redactResult(v, home)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = redactResult(v, home)
    return out as T
  }
  return value
}

export interface EnvCheckDeps {
  run: FfmpegRunner
  app: EnvCheckResult['app']
  gpuInfo: () => Promise<unknown>
  gpuFeatures: () => Record<string, string>
  localAi: (signal?: AbortSignal) => Promise<LocalAiCheck>
  whisper: () => Promise<WhisperCheck>
  home?: string
  now?: () => Date
  onProgress?: (p: EnvCheckProgress) => void
  signal?: AbortSignal
  /** PC の情報(試験で差し替える) */
  system?: () => { os: string; cpu: string; cores: number; memoryGb: number; freeMemoryGb: number }
}

function systemInfo(): ReturnType<NonNullable<EnvCheckDeps['system']>> {
  const cpus = os.cpus()
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: cpus[0]?.model?.trim() ?? '不明',
    cores: cpus.length,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    freeMemoryGb: os.freemem() / 1024 ** 3
  }
}

/** 全部を調べる。失敗した所は結果の中に理由を書いて続ける(1 つの失敗で全体を止めない) */
export async function runEnvCheck(deps: EnvCheckDeps): Promise<EnvCheckResult> {
  const now = deps.now ?? (() => new Date())
  const started = now()
  const signal = deps.signal
  const total = 4 + HW_ENCODERS.length
  let done = 0
  const step = (label: string): void => {
    deps.onProgress?.({ step: label, done, total })
    done++
  }

  step('PC と GPU を調べています')
  const sys = (deps.system ?? systemInfo)()
  let gpuInfo: unknown = null
  try {
    gpuInfo = await deps.gpuInfo()
  } catch {
    gpuInfo = null
  }
  let gpuFeatures: Record<string, string> = {}
  try {
    gpuFeatures = deps.gpuFeatures()
  } catch {
    gpuFeatures = {}
  }

  const ffmpeg = await checkEncoders(deps.run, signal, (e) =>
    step(`エンコーダを試しています(${e})`)
  )

  step('書き出しの速さを測っています')
  const speed: SpeedResult[] = []
  for (const encoder of [
    'libx264',
    ...ffmpeg.encoders.filter((e) => e.usable).map((e) => e.encoder)
  ]) {
    if (signal?.aborted) break
    deps.onProgress?.({ step: `書き出しの速さを測っています(${encoder})`, done, total })
    speed.push(await measureSpeed(deps.run, encoder, signal))
  }

  step('ローカル AI の構成を調べています')
  let localAi: LocalAiCheck
  try {
    localAi = signal?.aborted ? { ok: false, error: '止めました' } : await deps.localAi(signal)
  } catch (e) {
    localAi = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  step('文字起こしの実行方法を調べています')
  let whisper: WhisperCheck
  try {
    whisper = await deps.whisper()
  } catch (e) {
    whisper = { order: [], backends: [], model: '', downloaded: false, error: String(e) }
  }
  deps.onProgress?.({ step: '終わりました', done: total, total })

  const result: EnvCheckResult = {
    createdAt: started.toISOString(),
    app: deps.app,
    ...sys,
    gpus: gpuDevicesFromInfo(gpuInfo),
    gpuFeatures,
    ffmpeg,
    speed,
    localAi,
    whisper,
    durationMs: now().getTime() - started.getTime()
  }
  return redactResult(result, deps.home)
}

import { spawn } from 'child_process'
import type { Writable } from 'stream'
import { trackProcess } from './liveProcesses'
import {
  ENCODED_LOUDNESS_FILTER,
  OUTPUT_AUDIO_CODEC_ARGS,
  parseEbur128Summary,
  type EncodedLoudness
} from '@shared/loudness'

/**
 * ffmpeg の AAC 符号化器が頭に足すサンプル数(`initial_padding`)。mp4 は入れ物の編集リストで削って読むが、
 * ADTS は削らない。削った後は、mp4 から読んだ音とサンプル単位で同じになる(試験 `loudnessEncodedTarget`)
 */
export const AAC_PRIMING_SAMPLES = 1024

/**
 * 書き出しと同じ AAC にした音を**ファイルに書かずに**測る(`fitEncodedLoudness` の1回ぶん)。
 *
 * 前は AAC を一時ファイル(3時間で約 260MB)に書いてから、もう一度読み直して測っていた。
 * ここでは符号化する ffmpeg の出力(ADTS)をそのまま測る ffmpeg へ流し込み、2つを同時に走らせる
 * (音全体を読むのは1回、待ち時間は遅いほうの1本ぶん)。
 *
 * ADTS(と、パイプで流せる断片化した mp4)は、mp4 と違って頭の 1024 サンプル(AAC の符号化の遅れ)を
 * 削らずに出す。積分はほぼ変わらないが、トゥルーピークは**サンプルの位置で値が変わる**(4 倍に補間して
 * 測るので、位置がずれると山の測れ方が変わる)。削らずに測ると出来上がりの mp4 より最大 0.3 dB 低く出て、
 * 合格とした掛け方の mp4 が上限を越えていた(実測: 測りで −1.7、mp4 で −1.4 dBTP)。
 * 測る側で頭の 1024 サンプルを削り、mp4 から読んだ音とサンプル単位で同じにして測る(`AAC_PRIMING_SAMPLES`)
 *
 * `feed(sink, stop)` は AAC(ADTS)を `sink` へ書き出す処理を始め、終わったら成否を返す。
 * `stop` が止められたら(測る側が失敗して先に終わった)、書き出す処理を止めること。
 * 測れなければ null(止めた・失敗した)
 */
export function meterEncodedAudio(
  ffmpegPath: string,
  feed: (sink: Writable, stop: AbortSignal) => Promise<boolean>,
  signal?: AbortSignal
): Promise<EncodedLoudness | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    const meter = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'info',
        '-f',
        'aac',
        '-i',
        'pipe:0',
        '-af',
        `atrim=start_sample=${AAC_PRIMING_SAMPLES},${ENCODED_LOUDNESS_FILTER}`,
        '-f',
        'null',
        '-'
      ],
      { windowsHide: true }
    )
    const untrack = trackProcess(meter)
    const onAbort = (): void => {
      meter.kill('SIGKILL')
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // 測る側が先に終わったとき(失敗)の書き込みの失敗は、成否で拾う
    meter.stdin.on('error', () => {})
    const tail: string[] = []
    let pending = ''
    meter.stderr.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf-8')
      const lines = pending.split(/\r?\n|\r/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        tail.push(line)
        if (tail.length > 80) tail.shift()
      }
    })
    let fed: boolean | null = null
    let meterCode: number | null | undefined
    /** 測る側が失敗して先に終わったら、流し込む側を止める(読む相手がいないまま書き込みで止まり、戻らなくなる) */
    const stopFeed = new AbortController()
    const finish = (): void => {
      if (fed === null || meterCode === undefined) return
      untrack()
      signal?.removeEventListener('abort', onAbort)
      if (pending) tail.push(pending)
      if (!fed || meterCode !== 0 || signal?.aborted) return resolve(null)
      resolve(parseEbur128Summary(tail.join('\n')))
    }
    meter.on('error', () => {
      meterCode = -1
      if (fed === null) {
        fed = false
        stopFeed.abort()
      }
      finish()
    })
    meter.on('close', (code) => {
      meterCode = code
      // 正しく終わった(終わりまで読んだ)なら、流し込む側も書き終えていて自分で終わる。止めると測りを捨ててしまう
      if (fed === null && code !== 0) stopFeed.abort()
      finish()
    })
    feed(meter.stdin, stopFeed.signal).then(
      (ok) => {
        fed = ok
        if (!ok) meter.kill('SIGKILL')
        finish()
      },
      () => {
        fed = false
        meter.kill('SIGKILL')
        finish()
      }
    )
  })
}

/**
 * `inputArgs`(入力と、出力する音を1本に決める引数)の音に `filter` を掛けて AAC にし、測る。
 * 区間ごとの書き出しで使う(標準の書き出しは fluent-ffmpeg のグラフを `meterEncodedAudio` へ渡す)
 */
export function measureEncodedLoudness(
  ffmpegPath: string,
  inputArgs: string[],
  filter: string,
  signal?: AbortSignal
): Promise<EncodedLoudness | null> {
  return meterEncodedAudio(
    ffmpegPath,
    (sink, stop) =>
      new Promise<boolean>((resolve) => {
        const enc = spawn(
          ffmpegPath,
          [
            '-hide_banner',
            '-nostdin',
            '-v',
            'error',
            ...inputArgs,
            '-vn',
            '-af',
            filter,
            ...OUTPUT_AUDIO_CODEC_ARGS,
            '-f',
            'adts',
            'pipe:1'
          ],
          { windowsHide: true }
        )
        const untrack = trackProcess(enc)
        const onAbort = (): void => {
          enc.kill('SIGKILL')
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        stop.addEventListener('abort', onAbort, { once: true })
        enc.stdout.pipe(sink)
        enc.stderr.resume()
        enc.on('error', () => {
          untrack()
          signal?.removeEventListener('abort', onAbort)
          stop.removeEventListener('abort', onAbort)
          resolve(false)
        })
        enc.on('close', (code) => {
          untrack()
          signal?.removeEventListener('abort', onAbort)
          stop.removeEventListener('abort', onAbort)
          resolve(code === 0 && !signal?.aborted)
        })
      }),
    signal
  )
}

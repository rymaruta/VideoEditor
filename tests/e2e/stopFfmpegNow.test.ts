import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))
vi.mock('../../resources/models/rnnoise_voice_lq.rnnn?asset', () => ({
  default: `${process.cwd()}/resources/models/rnnoise_voice_lq.rnnn`
}))

import { ffmpegPath } from '@main/ffmpegService'
import { cancelMeasureExport, measureExport } from '@main/qcService'
import { cancelDenoise, denoiseFiles } from '@main/audioCleanService'

/**
 * 試し編集 第4回 N1: 前の自動確認を「止めた」のに止まっていなかった。kill()(SIGTERM)を受けた ffmpeg 7 は
 * ファイルの終わりまで処理してから終わる(実測 20 秒)ので、次の書き出しが「準備中 0%」で待たされた。
 * 本物の ffmpeg で、止めてから 1 秒以内に終わることを確かめる(ノイズ除去も同じ止め方)
 */
const work = mkdtempSync(join(tmpdir(), 've-stopnow-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const run = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

/** 測り終えるまで数秒かかる長さの動画(短く作って、つなぎ直すだけ。作るのは 1 秒ほど) */
const longVideo = (): string => {
  const short = join(work, 'short.mp4')
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=20',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=20:sample_rate=48000',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    short
  ])
  const out = join(work, 'long.mp4')
  run(['-stream_loop', '39', '-i', short, '-c', 'copy', out])
  return out
}

/** 止めてから、約束が終わるまでの時間 */
async function msToSettle(p: Promise<unknown>, stop: () => void): Promise<number> {
  const t = performance.now()
  stop()
  await p.catch(() => {})
  return performance.now() - t
}

describe.skipIf(!existsSync(ffmpegPath))('ffmpeg を止めたら、すぐ終わる', () => {
  it('自動確認: 測っている途中で止めると、1 秒以内に「止めた」で終わる', async () => {
    const file = longVideo()
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    let percent = 0
    const p = measureExport(file, (x) => {
      percent = x
      started()
    })
    await running
    const atStop = percent
    const ms = await msToSettle(p, cancelMeasureExport)
    await expect(p).rejects.toThrow('QC_CANCELED')
    // 止めたのは測り始め(残りが数秒ある)。止めた後に進み具合が進んでいない
    expect(atStop).toBeLessThan(50)
    expect(percent).toBeLessThan(atStop + 5)
    expect(ms).toBeLessThan(1000)
  }, 120_000)

  it('ノイズ除去: 処理の途中で止めると、1 秒以内に「止めた」で終わる', async () => {
    const mic = join(work, 'mic.flac')
    run(['-f', 'lavfi', '-i', 'sine=f=440:d=1200:sample_rate=48000', '-c:a', 'flac', mic])
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    let percent = 0
    const p = denoiseFiles([mic], (_d, _t, x) => {
      percent = x
      if (x > 0) started()
    })
    await running
    const atStop = percent
    const ms = await msToSettle(p, cancelDenoise)
    await expect(p).rejects.toThrow('DENOISE_CANCELED')
    expect(atStop).toBeLessThan(50)
    expect(percent).toBeLessThan(atStop + 5)
    expect(ms).toBeLessThan(1000)
  }, 120_000)
})

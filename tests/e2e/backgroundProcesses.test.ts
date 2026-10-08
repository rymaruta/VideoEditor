import { execFileSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'fs'
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
import { cachedEnvelope } from '@main/audioPcm'
import { cleanupStaleSegmentDirs } from '@main/segmentRenderer'
import { killLiveProcesses, trackUntilDone } from '@main/liveProcesses'
import { spawn } from 'child_process'

/** 裏側の処理(自動確認・ノイズ除去・音の大きさのキャッシュ・一時フォルダ・閉じるときの後始末) */
const work = mkdtempSync(join(tmpdir(), 've-bg-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const tone = (name: string, sec: number, silent = false): string => {
  const out = join(work, name)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    silent ? `anullsrc=r=48000:cl=mono:d=${sec}` : `sine=f=440:d=${sec}:sample_rate=48000`,
    ...(silent ? ['-t', String(sec)] : []),
    '-c:a',
    'pcm_s16le',
    out
  ])
  return out
}

describe.skipIf(!existsSync(ffmpegPath))('裏側の処理', () => {
  it('自動確認: 始めた直後の中止が効き、同時に2回は始めない', async () => {
    const f = tone('qc.wav', 20)
    const a = measureExport(f, () => {})
    cancelMeasureExport()
    await expect(a).rejects.toThrow('QC_CANCELED')
    const b = measureExport(f, () => {})
    await expect(measureExport(f, () => {})).rejects.toThrow('すでに実行中')
    await b
  }, 60_000)

  it('ノイズ除去: 中止した直後に別の実行を始めても、中止した実行は止まる', async () => {
    const files = [0, 1, 2].map((i) => tone(`mic${i}.wav`, 120))
    const a = denoiseFiles(files, () => {})
    await new Promise((r) => setTimeout(r, 400))
    cancelDenoise()
    const b = denoiseFiles([files[2]], () => {})
    await expect(a).rejects.toThrow('DENOISE_CANCELED')
    const r = await b
    expect(r[0].cleaned).toBeTruthy()
  }, 180_000)

  it('音の大きさのキャッシュ: 壊れたキャッシュは作り直し、同じ大きさ・更新時刻の別のファイルに古い結果を返さない', async () => {
    const cache = join(work, 'envcache')
    const f = tone('env.wav', 5)
    const ref = (): { path: string; size: number; mtimeMs: number } => {
      const st = statSync(f)
      return { path: f, size: st.size, mtimeMs: st.mtimeMs }
    }
    const loud = await cachedEnvelope(ffmpegPath, cache, ref())
    expect(Math.max(...loud)).toBeGreaterThan(0.05)
    // 壊れたキャッシュ(4 バイトの倍数でない)
    for (const name of readdirSync(cache)) writeFileSync(join(cache, name), Buffer.alloc(4001))
    expect((await cachedEnvelope(ffmpegPath, cache, ref())).length).toBe(loud.length)
    // 同じ大きさ・同じ更新時刻の無音に差し替える
    const mtime = statSync(f).mtime
    const silent = tone('silent-src.wav', 5, true)
    execFileSync('cp', [silent, f])
    utimesSync(f, mtime, mtime)
    const after = await cachedEnvelope(ffmpegPath, cache, ref())
    expect(Math.max(...after)).toBeLessThan(0.01)
  }, 60_000)

  it('前回の残りの一時フォルダ(文字起こし・切り出し・書体の測り)も消す', () => {
    const base = join(work, 'tmpbase')
    mkdirSync(base, { recursive: true })
    const dirs = ['ve-whisper-x', 've-crop-x', 've-fontprobe-x', 've-wave-x'].map((n) =>
      join(base, n)
    )
    const old = new Date(Date.now() - 24 * 3600 * 1000)
    for (const d of dirs) {
      mkdirSync(d)
      utimesSync(d, old, old)
    }
    cleanupStaleSegmentDirs(Date.now(), base)
    for (const d of dirs) expect(existsSync(d), d).toBe(false)
  })

  it('閉じるときは、包んだ ffmpeg を止め、閉じている最中に始まったものもすぐ止める', async () => {
    const child = trackUntilDone(
      spawn(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=600', '-f', 'null', '-'])
    )
    const closed = new Promise((r) => child.once('close', r))
    killLiveProcesses()
    await closed
    expect(child.killed || child.exitCode !== 0).toBe(true)
    const late = trackUntilDone(
      spawn(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=600', '-f', 'null', '-'])
    )
    await new Promise((r) => late.once('close', r))
    expect(late.signalCode).toBe('SIGKILL')
  }, 60_000)
})

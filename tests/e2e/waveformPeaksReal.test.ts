/**
 * 細かい波形の値(`generateWaveformPeaks`)を、本物の ffmpeg で確かめる。
 * 左だけ正弦波・右は無音の音を作り、L/R が別々に・振幅どおりに・区間の長さまで埋めて返るか。
 * ffmpeg(node_modules/ffmpeg-static)が無ければ飛ばす。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import { readdirSync } from 'fs'
import { createWaveformPeaksService, generateWaveformPeaks } from '@main/waveformPeaks'

const ffmpeg = ffmpegStatic as unknown as string
const has = typeof ffmpeg === 'string' && existsSync(ffmpeg)
const dir = mkdtempSync(join(tmpdir(), 've-peaks-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe.skipIf(!has)('細かい波形の値(本物の ffmpeg)', () => {
  it('左だけの正弦波: L は ±0.5・RMS 0.35、R は無音。音の無い後ろは 0 で埋まる', async () => {
    const wav = join(dir, 'left.wav')
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=220:d=2:sample_rate=48000',
      '-filter_complex',
      '[0]volume=4[l];anullsrc=r=48000:cl=mono,atrim=0:2[r];[l][r]join=inputs=2:channel_layout=stereo',
      '-c:a',
      'pcm_f32le',
      wav
    ])
    // ffmpeg の sine は振幅 1/8 なので 4 倍して 0.5。2 秒の音を 3 秒の区間として頼む(後ろ 1 秒は無音)
    const p = await generateWaveformPeaks(ffmpeg, wav, 0, 3, 300)
    expect(p.columns).toBe(300)
    expect(p.channels).toHaveLength(2)
    const L = p.channels[0]
    const R = p.channels[1]
    for (let k = 10; k < 190; k++) {
      expect(L.max[k]).toBeGreaterThan(0.45)
      expect(L.min[k]).toBeLessThan(-0.45)
      expect(L.rms[k]).toBeGreaterThan(0.3)
      expect(L.rms[k]).toBeLessThan(0.4)
      expect(Math.abs(R.max[k])).toBeLessThan(0.01)
    }
    for (let k = 210; k < 300; k++) expect(L.rms[k]).toBeLessThan(0.01)
  }, 60_000)

  it('素の値を 1 回だけ作ってディスクに覚え、次からは ffmpeg を起こさずに集計する', async () => {
    const wav = join(dir, 'stereo.wav')
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:d=4:sample_rate=48000',
      '-f',
      'lavfi',
      '-i',
      'sine=f=700:d=4:sample_rate=48000',
      '-filter_complex',
      '[0]volume=4[l];[1]volume=2[r];[l][r]join=inputs=2:channel_layout=stereo',
      '-c:a',
      'pcm_f32le',
      wav
    ])
    const cacheDir = join(dir, 'cache')
    const svc = createWaveformPeaksService({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobeStatic.path,
      cacheDir,
      directMaxSec: 0
    })
    const p = await svc.get(wav, 0, 4, 200)
    expect(p.channels).toHaveLength(2)
    expect(p.channels[0].max[50]).toBeGreaterThan(0.45)
    expect(p.channels[1].max[50]).toBeGreaterThan(0.2)
    expect(p.channels[1].max[50]).toBeLessThan(0.3)
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.wpk'))).toHaveLength(1)
    // ffmpeg が無い(起こせない)別の入れ物でも、ディスクの素の値から返せる
    const fromDisk = createWaveformPeaksService({
      ffmpegPath: join(dir, 'no-ffmpeg'),
      ffprobePath: join(dir, 'no-ffprobe'),
      cacheDir,
      directMaxSec: 0
    })
    const again = await fromDisk.get(wav, 1, 3, 100)
    expect(again.columns).toBe(100)
    expect(again.channels[0].max[10]).toBeGreaterThan(0.45)
    expect(fromDisk.memoryBytes).toBeGreaterThan(0)
  }, 60_000)

  it('素の値より細かい頼みは、その範囲だけ読み直す。止めれば止まる', async () => {
    const wav = join(dir, 'stereo.wav')
    const svc = createWaveformPeaksService({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobeStatic.path,
      cacheDir: join(dir, 'cache'),
      directMaxSec: 0
    })
    // 1 秒に 400 列(素の値の 4 倍)
    const fine = await svc.get(wav, 1, 2, 400)
    expect(fine.columns).toBe(400)
    expect(fine.channels[0].max[200]).toBeGreaterThan(0.45)
    const ac = new AbortController()
    ac.abort()
    await expect(svc.get(wav, 0, 4, 4000, ac.signal)).rejects.toThrow('PCM_ABORTED')
  }, 60_000)

  it('モノラルの素材は 1 段(-ac 1 で読む。-3dB にしない)', async () => {
    const wav = join(dir, 'mono.wav')
    execFileSync(ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=f=250:d=2:sample_rate=48000',
      '-af',
      'volume=4',
      '-ac',
      '1',
      wav
    ])
    const svc = createWaveformPeaksService({
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobeStatic.path,
      cacheDir: join(dir, 'cache')
    })
    const p = await svc.get(wav, 0, 2, 50)
    expect(p.channels).toHaveLength(1)
    expect(p.channels[0].max[20]).toBeGreaterThan(0.45)
  }, 60_000)
})

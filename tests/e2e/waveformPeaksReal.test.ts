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
import { generateWaveformPeaks } from '@main/waveformPeaks'

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
})

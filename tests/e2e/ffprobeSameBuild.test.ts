import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * 同梱の ffprobe は ffmpeg と同じビルド(@derhuerst/ffprobe-static。ffmpeg-static と同じリリース)。
 *
 * 前の ffprobe-static 3.x は ffmpeg(Linux 7.0.2)と別のビルドの 4.0.2 で、実測で次が起きていた:
 * - PCM を入れた MP4(ISO の ipcm。ffmpeg 6 以降が `-c:a pcm_s24le` の MP4 に書く形)の音声を `codec_name=unknown` と読む
 *   (アプリは音声の形を知らないまま扱い、プレビュー用の変換の判断を誤る)
 * - AVIF(AV1 の静止画)の入れ物を開けない(`moov atom not found`)
 * - `-show_entries stream_side_data=rotation` が「No match for section」で失敗する(版で節の名前が違う)
 * - 7.1.4 の並びの音声の channel_layout を `12 channels (FL+FR+…)` と読む
 * - 断片化した MP4 の映像の長さを、音声の長さ(2.0667 秒)で返す(映像は 2.000 秒)
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { ffmpegPath, ffprobePath, probeMedia } from '@main/ffmpegService'
import { isSameBuild, parseVersionOutput } from '../../scripts/gpl-sources.mjs'

const work = mkdtempSync(join(tmpdir(), 've-ffprobe-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => void execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
const probe = (args: string[]): string =>
  execFileSync(ffprobePath, ['-v', 'error', ...args], { encoding: 'utf-8' })
const VIDEO = ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=2']
const TONE = ['-f', 'lavfi', '-i', 'sine=d=2']

describe.skipIf(!existsSync(ffmpegPath) || !existsSync(ffprobePath))(
  '同梱の ffprobe は ffmpeg と同じビルド',
  () => {
    it('版と configure が ffmpeg と同じ(GPL のソースも 1 組で足りる)', () => {
      const ffmpeg = parseVersionOutput(
        execFileSync(ffmpegPath, ['-version'], { encoding: 'utf-8' })
      )
      const ffprobe = parseVersionOutput(
        execFileSync(ffprobePath, ['-version'], { encoding: 'utf-8' })
      )
      expect(ffprobe.version).toBe(ffmpeg.version)
      expect(isSameBuild(ffmpeg, ffprobe)).toBe(true)
      // 前の、全 OS 分の 4.0.2 を持つ包みは使わない
      expect(ffprobePath).not.toMatch(/[\\/]ffprobe-static[\\/]bin[\\/]/)
    })

    it('PCM を入れた MP4 の音声の形を読む(4.0.2 は unknown と読んだ)', async () => {
      const file = join(work, 'ipcm.mp4')
      ff([...VIDEO, ...TONE, '-c:v', 'libx264', '-c:a', 'pcm_s24le', file])
      const info = await probeMedia(file)
      expect(info.audioCodec).toBe('pcm_s24le')
      expect(info.hasAudio).toBe(true)
      expect(info.duration).toBeCloseTo(2, 1)
    })

    it('AVIF の入れ物を開ける(4.0.2 は moov atom not found)', () => {
      const file = join(work, 'still.avif')
      ff([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=64x64:d=1',
        '-frames:v',
        '1',
        '-c:v',
        'libaom-av1',
        '-still-picture',
        '1',
        file
      ])
      expect(readFileSync(file).length).toBeGreaterThan(0)
      expect(probe(['-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).trim()).toBe(
        'av1'
      )
    })

    it('新しい -show_entries の節(stream_side_data)と回転を読む', () => {
      const plain = join(work, 'plain.mp4')
      const rotated = join(work, 'rotated.mkv')
      ff([...VIDEO, '-c:v', 'libx264', plain])
      ff(['-display_rotation', '90', '-i', plain, '-c', 'copy', rotated])
      const out = probe([
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream_side_data=rotation',
        '-of',
        'csv=p=0',
        rotated
      ])
      expect(Math.abs(Number(out.trim()))).toBe(90)
    })

    it('7.1.4 の並びを名前で読む(4.0.2 は「12 channels (…)」)', () => {
      const file = join(work, 'c714.wav')
      ff([...TONE, '-af', 'aformat=channel_layouts=7.1.4', '-c:a', 'pcm_s16le', file])
      const out = probe(['-show_entries', 'stream=channel_layout', '-of', 'csv=p=0', file])
      expect(out.trim()).toBe('7.1.4')
    })

    it('断片化した MP4 の映像の長さを映像の分で読む(4.0.2 は音声の長さを返した)', () => {
      const file = join(work, 'frag.mp4')
      ff([
        ...VIDEO,
        ...TONE,
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+frag_keyframe+empty_moov',
        file
      ])
      const out = probe([
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=duration',
        '-of',
        'csv=p=0',
        file
      ])
      expect(Number(out.trim())).toBeCloseTo(2, 2)
    })
  }
)

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * fluent-ffmpeg は `.run()` の後で遅れて ffmpeg を起こし、起こす前の kill は何もしない。
 * 始めた直後の中止・アプリの終了が効くこと
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import { cancelExport, exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { ensurePreviewProxy } from '@main/previewProxyService'
import { killLiveProcesses } from '@main/liveProcesses'
import type { Project } from '@shared/types'

const work = mkdtempSync(join(tmpdir(), 've-startcancel-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const clip = (name: string, seconds: number, codec: string[]): string => {
  const out = join(work, name)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=640x360:r=30:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=f=440:d=${seconds}:sample_rate=48000`,
    '-shortest',
    ...codec,
    out
  ])
  return out
}

describe.skipIf(!existsSync(ffmpegPath))('始めた直後の中止・終了', () => {
  it('書き出しを始めた直後の中止で、書き出しが止まる(最後まで進んで「完了」にならない)', async () => {
    const src = clip('a.mp4', 20, ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'])
    const p = await probeMedia(src)
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [
        {
          id: 'a',
          filePath: src,
          fileName: 'a.mp4',
          duration: p.duration,
          width: p.width,
          height: p.height,
          fps: p.fps,
          hasAudio: true,
          hasVideo: true
        }
      ],
      clips: [{ id: 'c1', assetId: 'a', inPoint: 0, outPoint: 20, speed: 1 }],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const out = join(work, 'out.mp4')
    const run = exportProject({
      project,
      aspectRatio: '16:9',
      resolutionHeight: 720,
      quality: 'standard',
      outputPath: out,
      telopLayer: null,
      onProgress: () => {}
    })
    cancelExport()
    await expect(run).rejects.toThrow('EXPORT_CANCELED')
  }, 120_000)

  it('プレビュー用の素材を作り始めた直後にアプリを閉じたら、変換も止まる', async () => {
    const src = clip('b.avi', 30, ['-c:v', 'mpeg4', '-c:a', 'mp3'])
    const run = ensurePreviewProxy(src)
    killLiveProcesses()
    await expect(run).rejects.toBeTruthy()
  }, 120_000)
})

import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 区間ごとの書き出しで、速さを変えたクリップの途中に区間の境目があっても、音がつながる
 * (atempo は読み始めの位置で出力が変わるので、区間ごとに違う所から読むと境目で「プツッ」と鳴っていた)
 */
const work = mkdtempSync(join(tmpdir(), 've-seam-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

/** 音の波形の 2 階差分の大きな段差の数(純音なら 0) */
function clicks(path: string): number {
  const raw = execFileSync(
    ffmpegPath,
    ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 }
  )
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
  let n = 0
  // 頭と終わりの 0.5 秒(フェード・切れ目)は見ない
  for (let i = 24000; i < x.length - 24000; i++)
    if (Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]) > 0.05) n++
  return n
}

describe('区間ごとの書き出しの、速さを変えた音の境目', () => {
  it('1.25 倍のクリップの途中に区間の境目があっても、段差が出ない', async () => {
    const src = join(work, 'tone.mp4')
    execFileSync(ffmpegPath, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=30',
      '-f',
      'lavfi',
      '-i',
      'sine=f=440:d=30:sample_rate=48000',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      src
    ])
    const p = await probeMedia(src)
    const asset: MediaAsset = {
      id: 'A',
      filePath: src,
      fileName: 'tone',
      duration: p.duration,
      width: p.width,
      height: p.height,
      fps: p.fps,
      hasAudio: true,
      hasVideo: true
    }
    const project = {
      id: 'p',
      name: 'p',
      aspectRatio: '16:9',
      assets: [asset],
      clips: [{ id: 'c', assetId: 'A', inPoint: 0, outPoint: 25, speed: 1.25 }],
      audioTracks: [],
      videoOverlayTracks: [],
      textOverlays: []
    } as unknown as Project
    const out = join(work, 'seg.mp4')
    await exportSequenceSegmented({
      project: projectV1ToV2(project, { resolution: 720 }),
      outputPath: out,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null,
      // 6 秒ごとに区間を切る(クリップの途中に境目がいくつも入る)
      segmentOptions: { targetFrames: 180, minFrames: 90, maxFrames: 240 }
    })
    expect(clicks(out)).toBe(0)
  }, 180_000)
})

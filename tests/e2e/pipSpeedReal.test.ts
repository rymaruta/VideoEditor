import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 速くしたワイプ(本編を速くした所の顔カメラ)を、標準・区間分割のどちらの書き出しでも同じ速さで流す。
 * ワイプの素材は前半4秒が赤・後半4秒が青。素材 0〜8 秒を2倍で置くと、タイムラインの 2 秒より後ろは青
 * (等倍で読むと、本編の終わり(4秒)まで赤のまま)
 */

const work = mkdtempSync(join(tmpdir(), 've-pipspeed-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): void => {
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args])
}

async function assetOf(id: string, path: string): Promise<MediaAsset> {
  const p = await probeMedia(path)
  return {
    id,
    filePath: path,
    fileName: id,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: p.hasAudio,
    hasVideo: p.hasVideo
  }
}

/** その時刻の、点 (x, y) の色(RGB) */
function rgbAt(path: string, sec: number, x: number, y: number): number[] {
  const raw = execFileSync(ffmpegPath, [
    '-v',
    'error',
    '-ss',
    String(sec),
    '-i',
    path,
    '-vf',
    `crop=2:2:${x}:${y},scale=1:1`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ])
  return [raw[0], raw[1], raw[2]]
}

/** 区間 [from, from+dur) の音の大きさの最大(dB) */
function peakDb(path: string, from: number, dur: number): number {
  const r = spawnSync(
    ffmpegPath,
    [
      '-ss',
      String(from),
      '-t',
      String(dur),
      '-i',
      path,
      '-af',
      'volumedetect',
      '-vn',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN
}

describe('速くしたワイプの書き出し', () => {
  it('標準・区間分割のどちらでも、ワイプは置いた速さで流れ、音も本編の終わりまで鳴る', async () => {
    const mainPath = join(work, 'main.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=640x360:r=30:d=4',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono:d=4',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mainPath
    ])
    const facePath = join(work, 'face.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x180:r=30:d=4',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:r=30:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=f=1000:d=8:sample_rate=48000',
      '-filter_complex',
      '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      facePath
    ])
    const main = await assetOf('main', mainPath)
    const face = await assetOf('face', facePath)
    // 頭から(手前を読まない)と、素材の途中から(手前を少し読む: 素材の秒と書き出しの秒の換算が要る)
    const make = (inPoint: number): Project =>
      ({
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [main, face],
        clips: [{ id: 'c', assetId: 'main', inPoint: 0, outPoint: 4, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [
          {
            id: 'face',
            name: '顔',
            hidden: false,
            position: 'full',
            scale: 1,
            clips: [{ id: 'fc', assetId: 'face', startTime: 0, inPoint, outPoint: 8, speed: 2 }]
          }
        ],
        textOverlays: []
      }) as unknown as Project
    for (const inPoint of [0, 1]) {
      const project = make(inPoint)
      const std = join(work, `std-${inPoint}.mp4`)
      await exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 480,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        onProgress: () => {}
      })
      const seg = join(work, `seg-${inPoint}.mp4`)
      await exportSequenceSegmented({
        project: projectV1ToV2(project, { resolution: 480 }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      // 赤は素材 4 秒まで = タイムライン (4 - 入点) / 2 秒まで
      const switchAt = (4 - inPoint) / 2
      for (const out of [std, seg]) {
        const early = rgbAt(out, switchAt - 0.5, 426, 240)
        expect(early[0], `${out} ${early}`).toBeGreaterThan(200)
        expect(early[2], `${out} ${early}`).toBeLessThan(60)
        const late = rgbAt(out, switchAt + 0.5, 426, 240)
        expect(late[2], `${out} ${late}`).toBeGreaterThan(200)
        expect(late[0], `${out} ${late}`).toBeLessThan(60)
        // 尺は本編のまま(4秒)。ワイプの音はワイプの終わり((8 - 入点) / 2 秒)の手前まで鳴る
        const p = await probeMedia(out)
        expect(p.duration).toBeGreaterThan(3.9)
        expect(p.duration).toBeLessThan(4.1)
        expect(peakDb(out, (8 - inPoint) / 2 - 0.7, 0.5)).toBeGreaterThan(-20)
      }
    }
  }, 120_000)
})

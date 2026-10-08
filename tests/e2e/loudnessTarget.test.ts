import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { exportProject, ffmpegPath, probeMedia } from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { LOUDNESS_TARGETS, type LoudnessTarget } from '@shared/loudness'
import type { MediaAsset, Project } from '@shared/types'

/**
 * 書き出しの音量(ラウドネス)を、まばらに鋭い山がある素材でも基準の ±1 LU に入れ、トゥルーピークの上限も越えない。
 * 一定のゲインで上げると山が上限を越える素材では、loudnorm が黙って dynamic に戻り、基準に届かなかった
 */
const work = mkdtempSync(join(tmpdir(), 've-loud-'))
afterAll(() => rmSync(work, { recursive: true, force: true }))

function loudness(path: string): { i: number; tp: number } {
  const r = spawnSync(
    ffmpegPath,
    [
      '-hide_banner',
      '-i',
      path,
      '-vn',
      '-af',
      'ebur128=framelog=quiet:peak=true',
      '-f',
      'null',
      '-'
    ],
    { encoding: 'utf8' }
  )
  const i = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(r.stderr)
  const tp = /True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf) dBFS/.exec(r.stderr)
  return { i: i ? Number(i[1]) : NaN, tp: tp ? Number(tp[1]) : NaN }
}

async function source(name: string, audio: string): Promise<MediaAsset> {
  const path = join(work, `${name}.mp4`)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x180:r=30:d=20',
    '-f',
    'lavfi',
    '-i',
    audio,
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    path.replace('.mp4', '.mov')
  ])
  const p = await probeMedia(path.replace('.mp4', '.mov'))
  return {
    id: name,
    filePath: path.replace('.mp4', '.mov'),
    fileName: name,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: true,
    hasVideo: true
  }
}

describe.skipIf(!existsSync(ffmpegPath))('書き出しのラウドネス', () => {
  it('まばらに鋭い山がある素材・話し声らしい素材とも、配信・放送の基準に ±1 LU で入る', async () => {
    const sources = [
      // 静かな音 + 1 秒ごとの鋭いクリック
      await source(
        'peaky',
        "aevalsrc='0.03*sin(2*PI*440*t)+if(lt(mod(t,1),0.003),0.9,0)':d=20:s=48000"
      ),
      // 話し声らしい(0.3 秒ごとに大きさが変わる雑音)
      await source(
        'speechy',
        "aevalsrc='0.2*sin(2*PI*3*t)*sin(2*PI*300*t)*(random(0)*0.5+0.5)':d=20:s=48000"
      )
    ]
    for (const a of sources) {
      for (const target of ['web', 'broadcast'] as LoudnessTarget[]) {
        const project = {
          id: 'p',
          name: 'p',
          aspectRatio: '16:9',
          assets: [a],
          clips: [{ id: 'c', assetId: a.id, inPoint: 0, outPoint: 20, speed: 1 }],
          audioTracks: [],
          videoOverlayTracks: [],
          textOverlays: []
        } as unknown as Project
        const std = join(work, `${a.id}-${target}-std.mp4`)
        await exportProject({
          project,
          aspectRatio: '16:9',
          resolutionHeight: 480,
          quality: 'standard',
          outputPath: std,
          telopLayer: null,
          loudnessNormalization: true,
          loudnessTarget: target,
          onProgress: () => {}
        })
        const seg = join(work, `${a.id}-${target}-seg.mp4`)
        await exportSequenceSegmented({
          project: projectV1ToV2(project, { resolution: 480 }),
          outputPath: seg,
          quality: 'standard',
          encoder: 'libx264',
          telopLayer: null,
          loudnessNormalization: true,
          loudnessTarget: target
        })
        for (const out of [std, seg]) {
          const { i, tp } = loudness(out)
          const label = `${a.id} ${target} ${out} I=${i} TP=${tp}`
          expect(Math.abs(i - LOUDNESS_TARGETS[target].integrated), label).toBeLessThanOrEqual(1)
          // トゥルーピークの上限も越えない(AAC にした後で)
          expect(tp, label).toBeLessThanOrEqual(LOUDNESS_TARGETS[target].truePeak + 0.2)
        }
      }
    }
  }, 300_000)
})

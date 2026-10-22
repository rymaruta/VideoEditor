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
 * 【レグレッション 2026-10】音量の正規化 ON でも、**AAC にした後の**トゥルーピークが上限を越えていた。
 *
 * リミッタで抑えた後(AAC にする前)は −2.6 dBFS なのに、AAC 192k にすると山が +3 dB ほど持ち上がる
 * (実地テスト: Tears of Steel 720p 12分で、標準 +0.5 dBTP・区間ごと +2.7 dBTP。上限は −1.5 dBTP)。
 * 余裕を「1 dB」と決め打ちにしていて、AAC にした後を一度も測っていなかった。
 *
 * 音の割れやすい素材(大きな効果音・角の立った音楽)を両方の書き出しで出し、出来た mp4 を
 * ebur128 で測る: トゥルーピークは上限以下、積分は基準 ±1 LU。
 */
const work = mkdtempSync(join(tmpdir(), 've-tpaac-'))
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

const DUR = 8

async function source(name: string, audio: string): Promise<MediaAsset> {
  const path = join(work, `${name}.mov`)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=160x90:r=30:d=${DUR}`,
    '-f',
    'lavfi',
    '-i',
    audio,
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    path
  ])
  const p = await probeMedia(path)
  return {
    id: name,
    filePath: path,
    fileName: name,
    duration: p.duration,
    width: p.width,
    height: p.height,
    fps: p.fps,
    hasAudio: true,
    hasVideo: true
  }
}

describe.skipIf(!existsSync(ffmpegPath))('AAC にした後のトゥルーピーク', () => {
  it('大きな効果音・角の立った音楽で、標準・区間ごとの両方が上限以下・基準 ±1 LU', async () => {
    const sources = [
      // 静かな下地 + 2秒ごとの爆発音(全振幅の雑音が鋭く立ち上がって減衰する)
      await source(
        'sfx',
        `aevalsrc='0.02*sin(2*PI*220*t)+0.98*(2*random(0)-1)*exp(-12*mod(t,2))|` +
          `0.02*sin(2*PI*220*t)+0.98*(2*random(1)-1)*exp(-12*mod(t,2))':d=${DUR}:s=48000`
      ),
      // 角の立った音楽(小さめの鋸歯状波・矩形波の和音に、0.5秒ごとのドラムの鋭い打撃。高い倍音が多く、
      // AAC で山が持ち上がりやすい)
      await source(
        'music',
        `aevalsrc='0.08*(2*mod(110*t,1)-1)+0.08*sgn(sin(2*PI*277*t))+` +
          `0.95*sgn(sin(2*PI*1500*t))*exp(-60*mod(t,0.5))|` +
          `0.08*(2*mod(165*t,1)-1)+0.08*sgn(sin(2*PI*330*t))+` +
          `0.95*(2*random(0)-1)*exp(-60*mod(t,0.5))':d=${DUR}:s=48000`
      )
    ]
    const target: LoudnessTarget = 'web'
    const t = LOUDNESS_TARGETS[target]
    const results: string[] = []
    let fail = false
    for (const a of sources) {
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [a],
        clips: [{ id: 'c', assetId: a.id, inPoint: 0, outPoint: DUR, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      } as unknown as Project
      const std = join(work, `${a.id}-std.mp4`)
      await exportProject({
        project,
        aspectRatio: '16:9',
        resolutionHeight: 360 as never,
        quality: 'standard',
        outputPath: std,
        telopLayer: null,
        loudnessNormalization: true,
        loudnessTarget: target,
        onProgress: () => {}
      })
      const seg = join(work, `${a.id}-seg.mp4`)
      await exportSequenceSegmented({
        project: projectV1ToV2(project, { resolution: 360 as never }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null,
        loudnessNormalization: true,
        loudnessTarget: target
      })
      for (const [label, out] of [
        ['標準', std],
        ['区間ごと', seg]
      ]) {
        const { i, tp } = loudness(out)
        results.push(`${a.id} ${label}: I=${i} LUFS TP=${tp} dBTP`)
        if (!(tp <= t.truePeak) || !(Math.abs(i - t.integrated) <= 1)) fail = true
      }
    }
    // 修正前(実測): sfx は標準・区間ごととも I −14.7 LUFS・TP +0.7 dBTP、music は I −14.3・TP −0.4 dBTP。
    // 修正後: sfx I −14.6・TP −3.5、music I −14.4・TP −2.3(上限 −1.5 dBTP)
    expect(fail, results.join('\n')).toBe(false)
  }, 300_000)
})

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
 * 【レグレッション 2026-10】音量の正規化 ON で、出来た mp4 の大きさが基準から 1 LU 外れていた
 * (実地テスト: 3時間の記録映像で −15.1 LUFS・−2.8 dBTP。アプリ自身の QC が指摘)。
 *
 * AAC にした後の確認の1回目でトゥルーピークが上限に収まっていると、大きさが外れていても
 * そのまま使っていた。高い音(雑音)の多い音は、AAC にすると高い所が削られて大きさが下がる
 * (この素材では loudnorm で −14.0 に合わせた音が、AAC にすると −14.9)。
 *
 * 両方の書き出しで出し、出来た mp4 を ebur128 で測る: 積分は基準 ±0.5 LU、トゥルーピークは上限以下
 */
const work = mkdtempSync(join(tmpdir(), 've-loudenc-'))
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

const DUR = 12

async function source(name: string, audio: string, dur = DUR): Promise<MediaAsset> {
  const path = join(work, `${name}.mov`)
  execFileSync(ffmpegPath, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=gray:s=160x90:r=30:d=${dur}`,
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
    // 0 dBFS を越える音もそのまま持つ(16bit だと切れる)
    'pcm_f32le',
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

describe.skipIf(!existsSync(ffmpegPath))('AAC にした後の大きさ', () => {
  it('AAC で大きさの下がる音(雑音の多い話し声)でも、標準・区間ごとの両方が基準 ±0.5 LU', async () => {
    const ch = (r: number): string =>
      `0.03*sin(2*PI*3*t)*sin(2*PI*300*t)*(random(${r})*0.5+0.5)+` +
      `if(lt(mod(t,5),1.5),0.6*pow(sin(2*PI*4*t),8)*(2*random(${r + 1})-1),0)`
    const a = await source('hiss', `aevalsrc='${ch(0)}|${ch(2)}':d=${DUR}:s=48000`)
    const target: LoudnessTarget = 'web'
    const t = LOUDNESS_TARGETS[target]
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
    const std = join(work, 'std.mp4')
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
    const seg = join(work, 'seg.mp4')
    await exportSequenceSegmented({
      project: projectV1ToV2(project, { resolution: 360 as never }),
      outputPath: seg,
      quality: 'standard',
      encoder: 'libx264',
      telopLayer: null,
      loudnessNormalization: true,
      loudnessTarget: target
    })
    const results: string[] = []
    let fail = false
    for (const [label, out] of [
      ['標準', std],
      ['区間ごと', seg]
    ]) {
      const { i, tp } = loudness(out)
      results.push(`${label}: I=${i} LUFS TP=${tp} dBTP`)
      if (!(tp <= t.truePeak) || !(Math.abs(i - t.integrated) <= 0.5)) fail = true
    }
    // 修正前(実測): 標準・区間ごととも I −14.9 LUFS・TP −2.8 dBTP
    expect(fail, results.join('\n')).toBe(false)
  }, 300_000)

  /**
   * 【監査 2026-10】書き出しの修正の途中版で見つかった3つ:
   * - クリック音の多い素材: 最初の見込みのゲインがクリックに引っぱられ、話し声を基準まで上げる前に
   *   「+9 dB まで」で打ち切っていた(配信で −24.4 LUFS。10/09 版・HEAD は −14.0)
   * - AAC を ADTS のまま測ると頭の 1024 サンプルの分だけ位置がずれ、トゥルーピークが mp4 より最大 0.3 dB
   *   低く出ていた(測りで −1.7、mp4 で −1.4 dBTP。上限 −1.5)
   * - 0 LUFS を越える音で loudnorm の measured_I が範囲の外になり、書き出しが止まっていた(以前から)
   */
  type Case = [string, string, LoudnessTarget, ('std' | 'seg')[]]
  /** 素材ごとに書き出し、mp4 が基準 ±0.5 LU・上限以下か。外れたものを文面で返す */
  async function exportCases(
    cases: Case[],
    dur = DUR
  ): Promise<{ fail: boolean; results: string[] }> {
    const results: string[] = []
    let fail = false
    for (const [name, expr, target, engines] of cases) {
      // `|` が無ければ左右で同じ音(左右で違う音にすると、0 LUFS を越えにくい)
      const both = expr.includes('|') ? expr : `${expr}|${expr}`
      const a = await source(name, `aevalsrc='${both}':d=${dur}:s=48000`, dur)
      const t = LOUDNESS_TARGETS[target]
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [a],
        clips: [{ id: 'c', assetId: a.id, inPoint: 0, outPoint: dur, speed: 1 }],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      } as unknown as Project
      for (const engine of engines) {
        const out = join(work, `${name}-${engine}.mp4`)
        try {
          if (engine === 'std')
            await exportProject({
              project,
              aspectRatio: '16:9',
              resolutionHeight: 360 as never,
              quality: 'standard',
              outputPath: out,
              telopLayer: null,
              loudnessNormalization: true,
              loudnessTarget: target,
              onProgress: () => {}
            })
          else
            await exportSequenceSegmented({
              project: projectV1ToV2(project, { resolution: 360 as never }),
              outputPath: out,
              quality: 'standard',
              encoder: 'libx264',
              telopLayer: null,
              loudnessNormalization: true,
              loudnessTarget: target
            })
        } catch (e) {
          results.push(`${name} ${engine}: 失敗 ${(e as Error).message}`)
          fail = true
          continue
        }
        const { i, tp } = loudness(out)
        results.push(`${name} ${engine} ${target}: I=${i} LUFS TP=${tp} dBTP`)
        if (!(tp <= t.truePeak) || !(Math.abs(i - t.integrated) <= 0.5)) fail = true
      }
    }
    return { fail, results }
  }

  it('クリック音の多い音・鋭い山のある音・0 LUFS を越える音で、mp4 が基準 ±0.5 LU・上限以下', async () => {
    const { fail, results } = await exportCases([
      ['clicks', 'if(lt(mod(t,0.5),0.002),0.9,0)+0.005*sin(2*PI*300*t)', 'web', ['seg']],
      ['clicksB', 'if(lt(mod(t,0.5),0.002),0.9,0)+0.005*sin(2*PI*300*t)', 'broadcast', ['seg']],
      [
        'v5',
        '0.04*sin(2*PI*335*t)*(0.7+0.3*sin(2*PI*1.3*t))+if(lt(mod(t,2.45),0.00175),0.97,0)',
        'web',
        ['std', 'seg']
      ],
      ['hot', '1.8*sin(2*PI*200*t)*(0.5+0.5*sin(2*PI*0.3*t))', 'web', ['seg']]
    ])
    expect(fail, results.join('\n')).toBe(false)
  }, 600_000)

  // 再監査: 上げると小さくなる区間がある素材(c4 は途中版で −20.8 LUFS。HEAD・10/09 版は −14.2)。
  // 前のやり方より基準から遠くならない(ここでは基準 ±0.5 LU に入る)。12 秒では c4 の外れが出ないので 20 秒
  it('上げると小さくなる区間があるクリック音の素材(監査 c3・c4・c5)でも、mp4 が基準 ±0.5 LU・上限以下', async () => {
    const { fail, results } = await exportCases(
      [
        [
          'c3',
          'if(lt(mod(t,0.25),0.001),0.99,0)+0.003*sin(2*PI*250*t)|if(lt(mod(t,0.25),0.001),0.99,0)+0.003*sin(2*PI*260*t)',
          'broadcast',
          ['seg']
        ],
        [
          'c4',
          'if(lt(mod(t,1),0.003),0.8*sin(2*PI*3000*t),0)+0.002*sin(2*PI*(200+40*sin(2*PI*3*t))*t)*(0.6+0.4*sin(2*PI*2*t))|if(lt(mod(t,1),0.003),0.8*sin(2*PI*3000*t),0)+0.002*sin(2*PI*(210+40*sin(2*PI*3*t))*t)',
          'web',
          ['std', 'seg']
        ],
        [
          'c5',
          'if(lt(mod(t,0.5),0.002),0.9*(2*random(0)-1),0)+0.004*(2*random(1)-1)*sin(2*PI*3*t)|if(lt(mod(t,0.5),0.002),0.9*(2*random(2)-1),0)+0.004*(2*random(3)-1)*sin(2*PI*3*t)',
          'web',
          ['seg']
        ]
      ],
      20
    )
    expect(fail, results.join('\n')).toBe(false)
  }, 600_000)
})

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * HDR の素材のトーンマッピングは、出力(プロキシ)の大きさまで縮めてから掛ける。
 * 素材の大きさのまま浮動小数で計算すると重かった(実測 4K30 10bit HLG 1 秒・2 スレッド: 縮小だけ 0.74 秒、
 * zscale の経路 4.9 秒 → 縮めてから 1.5 秒、表引きの経路 3.0 秒 → 1.6 秒)。
 * - 出力より大きい HDR の素材: 縮めてから寄せても、色は SDR の基準に寄る(標準・区間ごと・プロキシ)
 * - 縮める大きさ: 出力の枠を覆う大きさ(切り抜き・ぼかし背景でも細かさを失わない)・大きくはしない
 * - SDR の素材には何も足さない
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import {
  exportProject,
  ffmpegFilterNames,
  ffmpegPath,
  probeMedia,
  sourceVideoFilterFor
} from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { ensurePreviewProxy } from '@main/previewProxyService'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { sourceVideoFilter } from '@shared/sourceVideo'
import type { MediaAsset, Project } from '@shared/types'

const work = mkdtempSync(join(tmpdir(), 've-hdrfit-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): Buffer =>
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args], { maxBuffer: 1 << 26 })
const PATCH = '0x9F6743'

/** 1枚の真ん中の 1/4 を1画素に縮めた色(RGB) */
function meanRgb(path: string, at: number): number[] {
  return [
    ...ff([
      '-ss',
      String(at),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      'crop=iw/2:ih/2,scale=1:1:flags=area,format=rgb24',
      '-f',
      'rawvideo',
      '-'
    ])
  ]
}
const colorDiff = (a: number[], b: number[]): number =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])))

describe('HDR の素材を出力の大きさまで縮めてからトーンマッピングする', () => {
  it('縮める大きさは出力の枠を覆う大きさ。SDR・インターレースだけの素材には足さない', () => {
    const hlg = { colorTransfer: 'arib-std-b67', fieldOrder: 'tt' }
    for (const zscale of [true, false]) {
      const f = sourceVideoFilter(hlg, { zscale, fit: { w: 1920, h: 1080 } })
      const scale = f.indexOf(
        'scale=w=min(iw\\,1920):h=min(ih\\,1080):force_original_aspect_ratio=increase'
      )
      // インターレースの解除 → 縮める → 色を寄せる の順
      expect(f.indexOf('bwdif')).toBe(0)
      expect(scale).toBeGreaterThan(0)
      expect(scale).toBeLessThan(f.indexOf(zscale ? 'zscale' : 'lutrgb'))
    }
    for (const info of [{ colorTransfer: 'bt709' }, { fieldOrder: 'tt' }, {}])
      expect(sourceVideoFilter(info, { zscale: true, fit: { w: 1920, h: 1080 } })).toBe(
        sourceVideoFilter(info, { zscale: true })
      )
  })

  it.skipIf(!existsSync(ffmpegPath))(
    '出力より大きい HLG の素材も SDR の色に寄せる(標準・区間ごと・プロキシ)',
    async (ctx) => {
      if (!(await ffmpegFilterNames()).has('zscale')) ctx.skip()
      const sdr = join(work, 'sdr.mp4')
      ff([
        '-f',
        'lavfi',
        '-i',
        `color=c=${PATCH}:s=160x90:r=25:d=1`,
        '-vf',
        'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
        '-c:v',
        'libx264',
        sdr
      ])
      // 1280x720 の HLG(10bit)。出力 640x360・プロキシ 540 より大きい
      const hlg = join(work, 'hlg.mp4')
      ff([
        '-f',
        'lavfi',
        '-i',
        `color=c=${PATCH}:s=1280x720:r=25:d=1`,
        '-vf',
        'format=gbrpf32le,setparams=color_trc=bt709:color_primaries=bt709:colorspace=gbr,' +
          'zscale=t=linear:npl=203,zscale=p=bt2020,' +
          'zscale=t=arib-std-b67:npl=203:m=bt2020nc:r=tv,format=yuv420p10le',
        '-color_trc',
        'arib-std-b67',
        '-color_primaries',
        'bt2020',
        '-colorspace',
        'bt2020nc',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        hlg
      ])
      // アプリの経路が実際に縮めるフィルタを付けること
      expect(await sourceVideoFilterFor(hlg, { w: 640, h: 360 })).toContain(
        'scale=w=min(iw\\,640):h=min(ih\\,360)'
      )
      const p = await probeMedia(hlg)
      const asset: MediaAsset = {
        id: 'hlg',
        filePath: hlg,
        fileName: 'hlg',
        duration: p.duration,
        width: p.width,
        height: p.height,
        fps: p.fps,
        hasAudio: false,
        hasVideo: true
      }
      const project = {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [asset],
        clips: [{ id: 'c', assetId: 'hlg', inPoint: 0, outPoint: 1, speed: 1 }],
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
        onProgress: () => {}
      })
      const seg = join(work, 'seg.mp4')
      await exportSequenceSegmented({
        project: projectV1ToV2(project, { resolution: 360 as never }),
        outputPath: seg,
        quality: 'standard',
        encoder: 'libx264',
        telopLayer: null
      })
      const proxy = await ensurePreviewProxy(hlg)
      const ref = meanRgb(sdr, 0.5)
      const got: Record<string, number[]> = {
        std: meanRgb(std, 0.5),
        seg: meanRgb(seg, 0.5),
        proxy: meanRgb(proxy, 0.5)
      }
      const off = Object.entries(got)
        .filter(([, v]) => colorDiff(v, ref) > 10)
        .map(([k, v]) => `${k}=(${v.join(',')})`)
      expect(off, `基準 (${ref.join(',')})`).toEqual([])
      // 書き出しの大きさは今までどおり
      expect((await probeMedia(std)).height).toBe(360)
      expect((await probeMedia(proxy)).height).toBe(540)
    },
    120_000
  )
})

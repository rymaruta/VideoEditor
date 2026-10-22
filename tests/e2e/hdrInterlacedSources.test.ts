import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 【レグレッション 2026-10】HDR(PQ・HLG)とインターレースの素材を、そのまま書き出していた。
 *
 * - HDR: トーンマッピングせずに 8bit の BT.709 として書き出し、暗く色が薄くなった
 *   (実地テスト: PQ (84,72,57)、HLG (95,75,51)、期待 ≈ (159,103,67))。出力に色のタグも付かず、
 *   プロキシは 8bit H.264 に PQ/HLG のタグを付けたまま作られ、プレビューと書き出しで見え方が違った。
 *   iPhone の既定の HLG 撮影が当たる
 * - インターレース: 解除せずに書き出し、動く輪郭が櫛状になった(src/ に yadif・bwdif が無かった)
 *
 * SDR の色の板を PQ・HLG(HEVC 10bit)に変えた素材と、速く動く縦の棒をインターレース(25i)にした素材で、
 * 標準・区間ごと・プロキシ・サムネイル・色合わせ用のフレームを確かめる。
 */
const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData, isPackaged: false, getAppPath: () => process.cwd() }
}))

import {
  exportProject,
  ffmpegFilterNames,
  ffmpegPath,
  ffprobePath,
  generateThumbnailDataUrl,
  probeMedia
} from '@main/ffmpegService'
import { exportSequenceSegmented } from '@main/segmentRenderer'
import { ensurePreviewProxy } from '@main/previewProxyService'
import { readFramesRgb } from '@main/frameService'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { hdrToSdrLutFilter } from '@shared/sourceVideo'
import type { MediaAsset, Project } from '@shared/types'

const work = mkdtempSync(join(tmpdir(), 've-hdril-'))
state.userData = join(work, 'userdata')
mkdirSync(state.userData, { recursive: true })
afterAll(() => rmSync(work, { recursive: true, force: true }))

const ff = (args: string[]): Buffer =>
  execFileSync(ffmpegPath, ['-y', '-v', 'error', ...args], { maxBuffer: 1 << 26 })

/** SDR の色の板(BT.709)。HDR の素材はこの色を PQ・HLG にしたもの */
const PATCH = '0x9F6743'
const HAVE_FFMPEG = existsSync(ffmpegPath)
let haveZscale = false

/** 1枚を1画素に縮めた色(RGB) */
function meanRgb(path: string, at: number, prefix = ''): number[] {
  return [
    ...ff([
      '-ss',
      String(at),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      `${prefix}scale=1:1:flags=area,format=rgb24`,
      '-f',
      'rawvideo',
      '-'
    ])
  ]
}

function dataUrlRgb(dataUrl: string): number[] {
  const p = join(work, `px-${Math.random().toString(36).slice(2)}.jpg`)
  writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64'))
  return meanRgb(p, 0)
}

/** 色の差の最大(各色の差の絶対値の最大) */
const colorDiff = (a: number[], b: number[]): number =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])))

/** 映像の色のタグ(同梱の ffprobe で読む) */
function colorTags(path: string): string {
  return execFileSync(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=color_transfer,color_primaries,color_space',
    '-of',
    'csv=p=0',
    path
  ])
    .toString()
    .trim()
}

/**
 * 櫛状の強さ: 各画素と上下の平均の差の平均(灰色 640x360 の1枚)。
 * 速く動く棒をインターレースのまま縮めずに出すと約 4.8、解除すると約 0
 */
function combing(path: string, at: number): number {
  const d = ff([
    '-ss',
    String(at),
    '-i',
    path,
    '-frames:v',
    '1',
    '-vf',
    'scale=640:360,format=gray',
    '-f',
    'rawvideo',
    '-'
  ])
  const W = 640
  const H = 360
  let s = 0
  for (let y = 1; y < H - 1; y++)
    for (let x = 0; x < W; x++)
      s += Math.abs(d[y * W + x] - (d[(y - 1) * W + x] + d[(y + 1) * W + x]) / 2)
  return s / (W * (H - 2))
}

async function asset(id: string, path: string): Promise<MediaAsset> {
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

function project(assets: MediaAsset[]): Project {
  return {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets,
    clips: assets.map((a, i) => ({
      id: `c${i}`,
      assetId: a.id,
      inPoint: 0,
      outPoint: 1,
      speed: 1
    })),
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: []
  } as unknown as Project
}

/** 標準と区間ごとの両方で書き出す */
async function exportBoth(p: Project, name: string): Promise<{ std: string; seg: string }> {
  const std = join(work, `${name}-std.mp4`)
  await exportProject({
    project: p,
    aspectRatio: '16:9',
    resolutionHeight: 360 as never,
    quality: 'standard',
    outputPath: std,
    telopLayer: null,
    onProgress: () => {}
  })
  const seg = join(work, `${name}-seg.mp4`)
  await exportSequenceSegmented({
    project: projectV1ToV2(p, { resolution: 360 as never }),
    outputPath: seg,
    quality: 'standard',
    encoder: 'libx264',
    telopLayer: null
  })
  return { std, seg }
}

describe.skipIf(!HAVE_FFMPEG)('HDR・インターレースの素材', () => {
  beforeAll(async () => {
    haveZscale = (await ffmpegFilterNames()).has('zscale')
  })

  it('HDR(PQ・HLG)は SDR の色に寄せ、BT.709 のタグを付ける(標準・区間ごと・プロキシ・サムネイル・色合わせ)', async (ctx) => {
    // 素材を作るのに zscale が要る(アプリの側は無くても表引きの近似で動く)
    if (!haveZscale) ctx.skip()
    const sdr = join(work, 'sdr.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=c=${PATCH}:s=160x90:r=25:d=1`,
      '-vf',
      'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-c:v',
      'libx264',
      sdr
    ])
    const hdr = (trc: string, out: string): void => {
      ff([
        '-f',
        'lavfi',
        '-i',
        `color=c=${PATCH}:s=160x90:r=25:d=1`,
        '-vf',
        'format=gbrpf32le,setparams=color_trc=bt709:color_primaries=bt709:colorspace=gbr,' +
          'zscale=t=linear:npl=203,zscale=p=bt2020,' +
          `zscale=t=${trc}:npl=203:m=bt2020nc:r=tv,format=yuv420p10le`,
        '-color_trc',
        trc,
        '-color_primaries',
        'bt2020',
        '-colorspace',
        'bt2020nc',
        '-c:v',
        'libx265',
        '-x265-params',
        'log-level=error',
        '-tag:v',
        'hvc1',
        out
      ])
    }
    const pq = join(work, 'pq.mp4')
    const hlg = join(work, 'hlg.mov')
    hdr('smpte2084', pq)
    hdr('arib-std-b67', hlg)
    const ref = meanRgb(sdr, 0.5)
    // 計器の対照: 素材をそのまま読むと暗く色が薄い(実地テストと同じ向き)
    expect(colorDiff(meanRgb(pq, 0.5), ref)).toBeGreaterThan(25)
    expect(colorDiff(meanRgb(hlg, 0.5), ref)).toBeGreaterThan(25)

    const assets = [await asset('sdr', sdr), await asset('pq', pq), await asset('hlg', hlg)]
    const { std, seg } = await exportBoth(project(assets), 'hdr')
    const got: Record<string, number[]> = {}
    for (const [name, out] of [
      ['std', std],
      ['seg', seg]
    ]) {
      got[`${name}-sdr`] = meanRgb(out, 0.5)
      got[`${name}-pq`] = meanRgb(out, 1.5)
      got[`${name}-hlg`] = meanRgb(out, 2.5)
    }
    const proxyPq = await ensurePreviewProxy(pq)
    const proxyHlg = await ensurePreviewProxy(hlg)
    got['proxy-pq'] = meanRgb(proxyPq, 0.5)
    got['proxy-hlg'] = meanRgb(proxyHlg, 0.5)
    got['thumb-pq'] = dataUrlRgb(await generateThumbnailDataUrl(pq, 0.5))
    got['thumb-hlg'] = dataUrlRgb(await generateThumbnailDataUrl(hlg, 0.5))
    const frames = await readFramesRgb(
      [
        { path: pq, time: 0.5 },
        { path: hlg, time: 0.5 }
      ],
      { w: 8, h: 8 },
      () => {}
    )
    frames.forEach((f, i) => {
      const px = f ? [0, 1, 2].map((c) => f[c + 3 * 27]) : [0, 0, 0]
      got[`match-${i === 0 ? 'pq' : 'hlg'}`] = px
    })
    // 修正前(実測): std/seg の pq (111,96,76)・hlg (123,93,65)、プロキシ・サムネイル・色合わせも同じ向き。
    // 修正後: pq (158,103,67)・hlg (157,104,67)(基準 (157,101,64))
    const off = Object.entries(got)
      .filter(([, v]) => colorDiff(v, ref) > 10)
      .map(([k, v]) => `${k}=(${v.join(',')})`)
    expect(off, `基準 (${ref.join(',')})`).toEqual([])

    // 出力とプロキシの色のタグは BT.709(素材の PQ・HLG のタグを写さない)
    for (const out of [std, seg, proxyPq, proxyHlg])
      expect(colorTags(out), out).toBe('bt709,bt709,bt709')
  }, 120_000)

  it('zscale の無い ffmpeg 向けの近似(表引き)も、基準の白までの色は SDR に寄る', async (ctx) => {
    if (!haveZscale) ctx.skip()
    const ref = meanRgb(join(work, 'sdr.mp4'), 0.5)
    const pq = meanRgb(join(work, 'pq.mp4'), 0.5, `${hdrToSdrLutFilter('pq')},`)
    const hlg = meanRgb(join(work, 'hlg.mov'), 0.5, `${hdrToSdrLutFilter('hlg')},`)
    expect(colorDiff(pq, ref), `pq (${pq.join(',')})`).toBeLessThanOrEqual(10)
    expect(colorDiff(hlg, ref), `hlg (${hlg.join(',')})`).toBeLessThanOrEqual(10)
  }, 60_000)

  it('インターレース(25i)は解除し、プログレッシブはそのまま(標準・区間ごと・プロキシ・サムネイル)', async () => {
    const moving = (r: number): string =>
      `color=c=gray:s=640x360:r=${r}:d=1[bg];color=c=white:s=40x360:r=${r}:d=1[bar];` +
      `[bg][bar]overlay=x='mod(t*600,600)':y=0`
    const il = join(work, 'il.mpg')
    ff([
      '-f',
      'lavfi',
      '-i',
      `${moving(50)},tinterlace=mode=interleave_top,setfield=tff`,
      '-c:v',
      'mpeg2video',
      '-flags',
      '+ilme+ildct',
      '-b:v',
      '1500k',
      '-an',
      '-f',
      'mpeg',
      il
    ])
    const prog = join(work, 'prog.mp4')
    ff([
      '-f',
      'lavfi',
      '-i',
      moving(25),
      '-c:v',
      'libx264',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      prog
    ])
    // 計器の対照: 素材のままだと櫛状
    expect(combing(il, 0.5)).toBeGreaterThan(2)

    const { std, seg } = await exportBoth(
      project([await asset('il', il), await asset('prog', prog)]),
      'il'
    )
    const proxy = await ensurePreviewProxy(il)
    const thumbPath = join(work, 'thumb-il.jpg')
    const thumb = await generateThumbnailDataUrl(il, 0.5)
    writeFileSync(thumbPath, Buffer.from(thumb.split(',')[1], 'base64'))
    const comb = {
      std: combing(std, 0.5),
      seg: combing(seg, 0.5),
      proxy: combing(proxy, 0.5),
      stdProg: combing(std, 1.5),
      segProg: combing(seg, 1.5)
    }
    // 修正前(実測): std・seg・proxy とも 4 前後
    for (const [k, v] of Object.entries(comb))
      expect(v, `${k} ${JSON.stringify(comb)}`).toBeLessThan(0.5)
    // サムネイルは 320 幅に縮めるので別の物差し: 縮めたあとも櫛は縞になって残る(解除すれば 0 に近い)
    expect(combing(thumbPath, 0)).toBeLessThan(0.5)
    // プログレッシブだけの書き出しは色のタグを付けない(今までと同じ)
    expect(colorTags(std)).not.toContain('bt709')
  }, 120_000)
})

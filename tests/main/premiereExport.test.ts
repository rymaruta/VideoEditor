import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { ffmpegPath, ffprobePath } from '@main/ffmpegService'
import { exportPremiereXml, type PremiereExportPayload } from '@main/premiereExportService'
import { appendTelopLayerImages, beginTelopLayer, withTelopLayer } from '@main/telopLayerStage'
import { readFcp7, type XmlElement } from '@shared/import/fcp7'
import { projectV1ToV2 } from '@shared/sequence/fromV1'
import { sequenceDurationFrames } from '@shared/sequence/segmentPlan'
import type { TelopLayerPayload } from '@shared/telop/layer'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project } from '@shared/types'
import { removeTempDir } from '../helpers/tempDir'

/**
 * Premiere 用 XML の書き出し(main)。XML・SRT と、見た目どおりのテロップ(透過 PNG・ProRes 4444)を
 * 同梱の ffmpeg で実際に書き、XML を読み戻して置き場所を確かめる。
 */

const W = 854
const H = 480
let work = ''

function ff(args: string[]): Buffer {
  return execFileSync(ffmpegPath, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 26 })
}

function png(name: string, alpha: string): Uint8Array {
  const path = join(work, name)
  ff([
    '-f',
    'lavfi',
    '-i',
    `color=c=white:s=${W}x${H}:d=0.04,format=rgba,geq=r=255:g=255:b=255:a='${alpha}'`,
    '-frames:v',
    '1',
    path
  ])
  return new Uint8Array(readFileSync(path))
}

const project = (): Project => ({
  id: 'p',
  name: '試験の回 #1',
  aspectRatio: '16:9',
  assets: [
    {
      id: 'a',
      filePath: '/media/a.mp4',
      fileName: 'a.mp4',
      duration: 60,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    }
  ],
  clips: [{ id: 'c1', assetId: 'a', inPoint: 1, outPoint: 2.5, speed: 1 }],
  audioTracks: [],
  videoOverlayTracks: [],
  textOverlays: [
    { id: 't1', text: 'こんにちは', startTime: 0, endTime: 0.5, style: defaultTextStyle() },
    { id: 't2', text: '**どうも**', startTime: 0.5, endTime: 1.5, style: defaultTextStyle() }
  ]
})

async function stagedLayer(): Promise<TelopLayerPayload> {
  const id = beginTelopLayer(W, H)
  await appendTelopLayerImages(id, 0, [
    png('blank.png', '0'),
    png('one.png', 'if(lt(Y,H/2),255,0)'),
    png('two.png', 'if(lt(X,W/2),200,0)')
  ])
  return {
    width: W,
    height: H,
    stagedId: id,
    imageCount: 3,
    runs: [
      { startFrame: 0, endFrame: 15, image: 1 },
      { startFrame: 15, endFrame: 30, image: 2 },
      { startFrame: 30, endFrame: 45, image: 1 }
    ]
  }
}

function read(xmlPath: string): ReturnType<typeof readFcp7> {
  const doc = new DOMParser().parseFromString(readFileSync(xmlPath, 'utf-8'), 'text/xml')
  return readFcp7(doc.documentElement as unknown as XmlElement)
}

const base = (
  p: Project,
  dir: string,
  mode: PremiereExportPayload['telopMode']
): PremiereExportPayload => ({
  project: p,
  aspectRatio: '16:9',
  resolutionHeight: 480,
  outputPath: join(dir, `${mode}.xml`),
  telopMode: mode
})

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 've-premiere-test-'))
})
afterAll(() => removeTempDir(work))

describe('exportPremiereXml(main)', () => {
  it('文字だけ: XML と同じ名前の SRT(BOM 付き)を書き、テロップの文字はマーカーに', async () => {
    const payload = base(project(), work, 'text')
    const r = await exportPremiereXml(payload, payload.outputPath, { ffmpegPath })
    expect(r.srtPath).toBe(join(work, 'text.srt'))
    const srt = readFileSync(r.srtPath, 'utf-8')
    expect(srt.charCodeAt(0)).toBe(0xfeff)
    expect(srt).toContain('どうも')
    expect(srt).not.toContain('**')
    const seq = read(payload.outputPath)!
    expect(seq.markers!.map((m) => m.comment)).toEqual(['こんにちは', 'どうも'])
    expect(r.telopPath).toBeUndefined()
    expect(seq.video.length).toBe(1)
  })

  it('透過 PNG: 使う画像だけをフォルダに写し、区間どおりに一番上のトラックへ', async () => {
    const layer = await stagedLayer()
    const payload = { ...base(project(), work, 'png'), telopLayer: layer }
    const r = await withTelopLayer(layer, () =>
      exportPremiereXml(payload, payload.outputPath, { ffmpegPath })
    )
    expect(r.telopPath).toBe(join(work, 'png_telop'))
    expect(readdirSync(r.telopPath!).sort()).toEqual(['telop_000001.png', 'telop_000002.png'])
    const seq = read(payload.outputPath)!
    const top = seq.video[seq.video.length - 1]
    expect(top.map((c) => [Math.round(c.start * 30), Math.round(c.end * 30)])).toEqual([
      [0, 15],
      [15, 30],
      [30, 45]
    ])
    expect(top[0].path).toBe(join(work, 'png_telop', 'telop_000001.png'))
    expect(top[2].path).toBe(top[0].path)
  })

  it('ProRes 4444: 透過付きの 1 本を、シーケンスの尺ちょうどのフレーム数で', async () => {
    const layer = await stagedLayer()
    const p = project()
    const payload = { ...base(p, work, 'prores'), telopLayer: layer }
    const r = await withTelopLayer(layer, () =>
      exportPremiereXml(payload, payload.outputPath, { ffmpegPath })
    )
    expect(r.telopPath).toBe(join(work, 'prores_telop.mov'))
    expect(existsSync(r.telopPath!)).toBe(true)
    const total = sequenceDurationFrames(projectV1ToV2(p, { resolution: 480 }).sequence)
    const info = execFileSync(ffprobePath, [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_name,profile,pix_fmt,nb_read_frames,width,height',
      '-of',
      'json',
      r.telopPath!
    ]).toString()
    const s = JSON.parse(info).streams[0]
    expect(s.codec_name).toBe('prores')
    expect(s.pix_fmt).toMatch(/^yuva444p/)
    expect([s.width, s.height]).toEqual([W, H])
    expect(Number(s.nb_read_frames)).toBe(total)
    const seq = read(payload.outputPath)!
    const top = seq.video[seq.video.length - 1]
    expect(top.length).toBe(1)
    expect(Math.round(top[0].end * 30)).toBe(total)
    // 透過: 下半分(PNG の 1 枚目は上半分だけ不透明)は透明のまま
    const alpha = ff([
      '-i',
      r.telopPath!,
      '-vf',
      `format=rgba,crop=1:1:10:${H - 10},extractplanes=a`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-'
    ])
    expect(alpha[0]).toBe(0)
  })
})

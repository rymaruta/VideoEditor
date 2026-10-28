import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { ffmpegPath, ffprobePath } from '@main/ffmpegService'
import {
  existingPremiereSidecars,
  exportPremiereXml,
  telopPngsUsedAsAssets,
  type PremiereExportPayload
} from '@main/premiereExportService'
import { appendTelopLayerImages, beginTelopLayer, withTelopLayer } from '@main/telopLayerStage'
import { fileUrl } from '@shared/export/premiereXml'
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

/** XML の中の pathurl(書いたままの文字) */
function pathUrls(xmlPath: string): string[] {
  const doc = new DOMParser().parseFromString(readFileSync(xmlPath, 'utf-8'), 'text/xml')
  const els = doc.getElementsByTagName('pathurl')
  return Array.from({ length: els.length }, (_, i) => els[i].textContent?.trim() ?? '')
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
  it('T1 を隠したら、テロップ(SRT・テロップのマーカー)は出さず、章のマーカーは残す', async () => {
    const p = project()
    p.textOverlays.push({
      id: 't3',
      text: '第1章',
      startTime: 1,
      endTime: 1.4,
      effectId: 'chapter-title',
      style: defaultTextStyle()
    })
    const dir = join(work, 'hidden')
    mkdirSync(dir, { recursive: true })
    const payload = base({ ...p, telopTrackHidden: true }, dir, 'text')
    const r = await exportPremiereXml(payload, payload.outputPath, { ffmpegPath })
    const srt = readFileSync(r.srtPath, 'utf-8')
    expect(srt).not.toContain('こんにちは')
    expect(srt).not.toContain('第1章')
    const names = read(payload.outputPath)!.markers!.map((m) => m.name)
    expect(names).toContain('章: 第1章')
    expect(names).not.toContain('テロップ')
  })
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
    const first = join(work, 'png_telop', 'telop_000001.png')
    // XML には Premiere が読む形の pathurl で書く(Windows: file://localhost/C%3a/Users/…/telop_000001.png)
    expect(pathUrls(payload.outputPath)).toContain(fileUrl(first))
    // 読み戻した pathurl のパスは、どの OS でも区切りが /(Windows では C:/Users/…)
    expect(top[0].path).toBe(first.replace(/\\/g, '/'))
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

  it('並べて書くものが既にあれば一覧に出る(保存先を選ぶときの確認に使う)', () => {
    const xml = join(work, 'text.xml')
    expect(existingPremiereSidecars(xml)).toEqual([join(work, 'text.srt')])
  })

  it('透過 PNG: 前回の余り(今回より多かった telop_*.png)は消し、ほかのファイルは残す', async () => {
    const dir = join(work, 'png2_telop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'telop_000009.png'), 'old')
    writeFileSync(join(dir, 'memo.txt'), 'keep')
    const layer = await stagedLayer()
    const payload = {
      ...base(project(), work, 'png'),
      outputPath: join(work, 'png2.xml'),
      telopLayer: layer
    }
    await withTelopLayer(layer, () =>
      exportPremiereXml(payload, payload.outputPath, { ffmpegPath })
    )
    expect(readdirSync(dir).sort()).toEqual(['memo.txt', 'telop_000001.png', 'telop_000002.png'])
  })

  it('透過 PNG: 中止すると写すのをやめる', async () => {
    const layer = await stagedLayer()
    const payload = {
      ...base(project(), work, 'png'),
      outputPath: join(work, 'png3.xml'),
      telopLayer: layer
    }
    const ac = new AbortController()
    ac.abort()
    await expect(
      withTelopLayer(layer, () =>
        exportPremiereXml(payload, payload.outputPath, { ffmpegPath, signal: ac.signal })
      )
    ).rejects.toThrow('EXPORT_CANCELED')
    expect(existsSync(payload.outputPath)).toBe(false)
  })

  it('ProRes 4444: 空きが足りなければ書き始める前に止める', async () => {
    const layer = await stagedLayer()
    const payload = {
      ...base(project(), work, 'prores'),
      outputPath: join(work, 'full.xml'),
      telopLayer: layer
    }
    await expect(
      withTelopLayer(layer, () =>
        exportPremiereXml(payload, payload.outputPath, { ffmpegPath, freeBytes: () => 1024 })
      )
    ).rejects.toThrow(/空き/)
    expect(existsSync(join(work, 'full_telop.mov'))).toBe(false)
  })

  it('音声のチャンネル数を調べ、モノラルの素材は 1 本のトラックに', async () => {
    const p = project()
    p.audioTracks = [
      {
        id: 'na',
        name: 'ナレーション',
        muted: false,
        volume: 1,
        duckingEnabled: false,
        clips: [{ id: 'n1', assetId: 'a', startTime: 0, inPoint: 0, outPoint: 1 }]
      }
    ]
    const payload = { ...base(p, work, 'text'), outputPath: join(work, 'mono.xml') }
    await exportPremiereXml(payload, payload.outputPath, {
      ffmpegPath,
      probeChannels: async () => 1
    })
    const xml = readFileSync(payload.outputPath, 'utf-8')
    expect(xml).toContain('premiereTrackType="Mono"')
    expect(xml).not.toContain('currentExplodedTrackIndex')
    expect(xml).toContain('<channelcount>1</channelcount>')
  })

  it('透過 PNG: 中止・失敗のときは前回の PNG を消さない(一時フォルダに書いて最後に入れ替える)', async () => {
    const dir = join(work, 'keep_telop')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'telop_000001.png'), 'previous')
    const layer = await stagedLayer()
    const payload = {
      ...base(project(), work, 'png'),
      outputPath: join(work, 'keep.xml'),
      telopLayer: layer
    }
    // チャンネル数を調べている所(PNG を写し終えた後)で中止する
    const ac = new AbortController()
    await expect(
      withTelopLayer(layer, () =>
        exportPremiereXml(payload, payload.outputPath, {
          ffmpegPath,
          signal: ac.signal,
          probeChannels: async () => {
            ac.abort()
            return 2
          }
        })
      )
    ).rejects.toThrow('EXPORT_CANCELED')
    expect(readFileSync(join(dir, 'telop_000001.png'), 'utf-8')).toBe('previous')
    expect(readdirSync(dir)).toEqual(['telop_000001.png'])
    // 一時フォルダは残らない
    expect(readdirSync(work).filter((n) => n.startsWith('keep_telop.partial-'))).toEqual([])
    // 最後まで行けば入れ替わる
    const layer2 = await stagedLayer()
    await withTelopLayer(layer2, () =>
      exportPremiereXml({ ...payload, telopLayer: layer2 }, payload.outputPath, { ffmpegPath })
    )
    expect(readdirSync(dir).sort()).toEqual(['telop_000001.png', 'telop_000002.png'])
    expect(readFileSync(join(dir, 'telop_000001.png')).subarray(1, 4).toString()).toBe('PNG')
    expect(readdirSync(work).filter((n) => n.startsWith('keep_telop.partial-'))).toEqual([])
  })

  it('透過 PNG: そのフォルダの telop_*.png を企画の素材に使っていれば、消さずに止める', async () => {
    const dir = join(work, 'asset_telop')
    mkdirSync(dir, { recursive: true })
    const used = join(dir, 'telop_000003.png')
    writeFileSync(used, 'asset')
    const p = project()
    p.assets.push({
      id: 'cg',
      filePath: used,
      fileName: 'telop_000003.png',
      duration: 0,
      width: W,
      height: H,
      fps: 30,
      hasAudio: false,
      hasVideo: true,
      still: true
    })
    expect(telopPngsUsedAsAssets(dir, p.assets)).toEqual(['telop_000003.png'])
    const layer = await stagedLayer()
    const payload = {
      ...base(p, work, 'png'),
      outputPath: join(work, 'asset.xml'),
      telopLayer: layer
    }
    await expect(
      withTelopLayer(layer, () => exportPremiereXml(payload, payload.outputPath, { ffmpegPath }))
    ).rejects.toThrow(/素材として使われている/)
    expect(readFileSync(used, 'utf-8')).toBe('asset')
  })

  it('チャンネル数の ffprobe は同時に 4 つまで', async () => {
    const p = project()
    p.assets = Array.from({ length: 10 }, (_, i) => ({
      ...p.assets[0],
      id: `a${i}`,
      filePath: `/media/a${i}.mp4`
    }))
    p.clips = p.assets.map((a, i) => ({
      id: `c${i}`,
      assetId: a.id,
      inPoint: 0,
      outPoint: 0.5,
      speed: 1
    }))
    let running = 0
    let peak = 0
    let calls = 0
    const payload = { ...base(p, work, 'text'), outputPath: join(work, 'probe.xml') }
    await exportPremiereXml(payload, payload.outputPath, {
      ffmpegPath,
      probeChannels: async () => {
        calls++
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        return 2
      }
    })
    expect(calls).toBe(10)
    expect(peak).toBeLessThanOrEqual(4)
  })
})

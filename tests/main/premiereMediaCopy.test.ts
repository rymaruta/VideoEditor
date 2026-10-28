import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { ffmpegPath } from '@main/ffmpegService'
import {
  existingPremiereSidecars,
  exportPremiereXml,
  premiereMediaCopies,
  type PremiereExportPayload
} from '@main/premiereExportService'
import { fileUrl } from '@shared/export/premiereXml'
import { premiereMediaNote } from '@shared/export/premiereTypes'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project } from '@shared/types'
import { removeTempDir } from '../helpers/tempDir'

/**
 * Premiere 用 XML が、マイクの音としてアプリの設定フォルダの中のノイズ除去後のキャッシュ
 * (`userData/clean-audio/*.flac`)を指していた(別の PC・キャッシュを消すとオフラインになる)。
 * 設定フォルダの中の素材は XML の隣の `名前_media/` へ写し、XML はそちらを指す。
 * PNG のテロップと同じく一時フォルダに写して最後に入れ替え、失敗・中止で半端に残さない。
 */

let work = ''
let userData = ''
let cleanAudio = ''

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 've-premiere-media-'))
  userData = join(work, 'userData')
  cleanAudio = join(userData, 'clean-audio')
  mkdirSync(cleanAudio, { recursive: true })
  writeFileSync(join(cleanAudio, 'PIN_01-1bbface6e0ad.flac'), 'denoised-1')
  writeFileSync(join(cleanAudio, 'PIN_02-9c0ffee00000.flac'), 'denoised-2')
})
afterAll(() => removeTempDir(work))

const project = (): Project => ({
  id: 'p',
  name: '試し編集 第1回',
  aspectRatio: '16:9',
  assets: [
    {
      id: 'cam',
      filePath: '/media/C0001.MP4',
      fileName: 'C0001.MP4',
      duration: 60,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      hasVideo: true
    },
    {
      id: 'pin1',
      filePath: join(cleanAudio, 'PIN_01-1bbface6e0ad.flac'),
      denoisedFrom: '/media/PIN_01.WAV',
      fileName: 'PIN_01.WAV',
      duration: 60,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: true,
      hasVideo: false
    },
    {
      id: 'pin2',
      filePath: join(cleanAudio, 'PIN_02-9c0ffee00000.flac'),
      denoisedFrom: '/media/PIN_02.WAV',
      fileName: 'PIN_02.WAV',
      duration: 60,
      width: 0,
      height: 0,
      fps: 0,
      hasAudio: true,
      hasVideo: false
    }
  ],
  clips: [{ id: 'c1', assetId: 'cam', inPoint: 0, outPoint: 2, speed: 1 }],
  audioTracks: [
    {
      id: 'mics',
      name: 'マイク1',
      muted: false,
      volume: 1,
      duckingEnabled: false,
      clips: [
        { id: 'm1', assetId: 'pin1', startTime: 0, inPoint: 0, outPoint: 2 },
        { id: 'm2', assetId: 'pin2', startTime: 0, inPoint: 0, outPoint: 2 }
      ]
    }
  ],
  videoOverlayTracks: [],
  textOverlays: [
    { id: 't1', text: 'こんにちは', startTime: 0, endTime: 1, style: defaultTextStyle() }
  ]
})

const payload = (name: string): PremiereExportPayload => ({
  project: project(),
  aspectRatio: '16:9',
  resolutionHeight: 480,
  outputPath: join(work, 'out', `${name}.xml`),
  telopMode: 'text'
})

function pathUrls(xmlPath: string): string[] {
  const doc = new DOMParser().parseFromString(readFileSync(xmlPath, 'utf-8'), 'text/xml')
  const els = doc.getElementsByTagName('pathurl')
  return Array.from({ length: els.length }, (_, i) => els[i].textContent?.trim() ?? '')
}

describe('Premiere 用 XML: アプリの設定フォルダの中の素材', () => {
  it('ノイズ除去後のマイクの音を XML の隣の「名前_media」へ写し、XML はそちらを指す', async () => {
    const p = payload('試し編集')
    mkdirSync(join(work, 'out'), { recursive: true })
    const r = await exportPremiereXml(p, p.outputPath, { ffmpegPath, appCacheDirs: [userData] })
    const mediaDir = join(work, 'out', '試し編集_media')
    expect(readdirSync(mediaDir).sort()).toEqual([
      'PIN_01-1bbface6e0ad.flac',
      'PIN_02-9c0ffee00000.flac'
    ])
    expect(readFileSync(join(mediaDir, 'PIN_01-1bbface6e0ad.flac'), 'utf-8')).toBe('denoised-1')
    const urls = pathUrls(p.outputPath)
    // 設定フォルダ(clean-audio)を指さない。写した先を指す。設定フォルダの外の素材はそのまま
    expect(urls.some((u) => u.includes('clean-audio'))).toBe(false)
    expect(urls).toContain(fileUrl(join(mediaDir, 'PIN_01-1bbface6e0ad.flac')))
    expect(urls).toContain(fileUrl(join(mediaDir, 'PIN_02-9c0ffee00000.flac')))
    expect(urls).toContain(fileUrl('/media/C0001.MP4'))
    // 何を写したかを画面に出せる
    expect(r.media?.dir).toBe(mediaDir)
    expect(r.media?.files.map((f) => f.name)).toEqual([
      'PIN_01-1bbface6e0ad.flac',
      'PIN_02-9c0ffee00000.flac'
    ])
    const note = premiereMediaNote(r.media)!
    expect(note).toContain('2 本を「試し編集_media」に写し')
    expect(note).toContain('PIN_01-1bbface6e0ad.flac')
    // 上書きの確認の一覧にも出る
    expect(existingPremiereSidecars(p.outputPath)).toContain(mediaDir)
    // 企画の素材は替えない(写した先は XML の中だけ)
    expect(p.project.assets[1].filePath).toBe(join(cleanAudio, 'PIN_01-1bbface6e0ad.flac'))
  })

  it('設定フォルダの中の素材を使っていなければ、フォルダを作らない', async () => {
    const p = payload('カメラだけ')
    p.project.audioTracks = []
    mkdirSync(join(work, 'out'), { recursive: true })
    const r = await exportPremiereXml(p, p.outputPath, { ffmpegPath, appCacheDirs: [userData] })
    expect(r.media).toBeUndefined()
    expect(existsSync(join(work, 'out', 'カメラだけ_media'))).toBe(false)
  })

  it('途中で失敗したら、前回の写しを元に戻し、一時フォルダを残さない', async () => {
    const p = payload('失敗')
    const mediaDir = join(work, 'out', '失敗_media')
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(join(mediaDir, 'PIN_01-1bbface6e0ad.flac'), 'previous')
    writeFileSync(join(mediaDir, 'メモ.txt'), '人が置いたもの')
    // SRT の置き換えで失敗させる(同じ名前のフォルダがある)
    mkdirSync(join(work, 'out', '失敗.srt'), { recursive: true })
    await expect(
      exportPremiereXml(p, p.outputPath, { ffmpegPath, appCacheDirs: [userData] })
    ).rejects.toThrow()
    expect(readFileSync(join(mediaDir, 'PIN_01-1bbface6e0ad.flac'), 'utf-8')).toBe('previous')
    expect(readdirSync(mediaDir).sort()).toEqual(['PIN_01-1bbface6e0ad.flac', 'メモ.txt'])
    expect(readdirSync(join(work, 'out')).filter((n) => n.includes('.partial-'))).toEqual([])
    expect(readdirSync(join(work, 'out')).filter((n) => n.includes('.previous-'))).toEqual([])
  })

  it('中止したら写しを残さない', async () => {
    const p = payload('中止')
    const ac = new AbortController()
    await expect(
      exportPremiereXml(p, p.outputPath, {
        ffmpegPath,
        appCacheDirs: [userData],
        signal: ac.signal,
        probeChannels: async () => {
          ac.abort()
          return 2
        }
      })
    ).rejects.toThrow('EXPORT_CANCELED')
    expect(existsSync(join(work, 'out', '中止_media'))).toBe(false)
    expect(readdirSync(join(work, 'out')).filter((n) => n.startsWith('中止_media'))).toEqual([])
  })

  it('同じ名前のファイルは名前を分け、同じファイルを指す素材は 1 回だけ写す', () => {
    const copies = premiereMediaCopies(
      [
        { id: 'a', filePath: '/u/clean-audio/x.flac' },
        { id: 'b', filePath: '/u/narration/x.flac' },
        { id: 'c', filePath: '/u/clean-audio/x.flac' },
        { id: 'd', filePath: '/media/y.wav' },
        { id: 'e', filePath: '/u/clean-audio/unused.flac' }
      ],
      new Set(['a', 'b', 'c', 'd']),
      ['/u']
    )
    expect(copies.map((c) => [c.assetId, c.name])).toEqual([
      ['a', 'x.flac'],
      ['b', 'x-2.flac'],
      ['c', 'x.flac']
    ])
  })
})

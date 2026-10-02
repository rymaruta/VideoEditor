import { describe, expect, it } from 'vitest'
import {
  classifyFootage,
  fileNamePrefix,
  sourceDuration,
  type ProbedFile
} from '../../src/shared/ingest/classify'

function file(relativePath: string, p: Partial<ProbedFile> = {}): ProbedFile {
  return {
    path: `E:/収録/${relativePath}`,
    relativePath,
    duration: 60,
    hasVideo: true,
    hasAudio: true,
    size: 1,
    ...p
  }
}

describe('fileNamePrefix', () => {
  it('機材ごとのファイル名の頭を取る', () => {
    expect(fileNamePrefix('A-0388.MP4')).toBe('A')
    expect(fileNamePrefix('GX010123.MP4')).toBe('GX')
    expect(fileNamePrefix('ZOOM0001.WAV')).toBe('ZOOM')
    expect(fileNamePrefix('DJI_0012.MP4')).toBe('DJI')
    expect(fileNamePrefix('C0001.MP4')).toBe('C')
    expect(fileNamePrefix('0001.MP4')).toBe('')
  })
})

describe('classifyFootage', () => {
  it('カードごとのフォルダで分け、カメラ → マイクの順に名前を付ける', () => {
    const sources = classifyFootage([
      file('CAM_B/C0002.MP4'),
      file('CAM_A/A-0002.MP4', { recordedAt: 200 }),
      file('CAM_A/A-0001.MP4', { recordedAt: 100 }),
      file('CAM_B/C0001.MP4'),
      file('AUDIO/PIN_01.WAV', { hasVideo: false, duration: 3600 }),
      file('AUDIO/PIN_02.WAV', { hasVideo: false, duration: 3500 })
    ])
    expect(sources.map((s) => s.name)).toEqual(['カメラA', 'カメラB', 'マイク1', 'マイク2'])
    expect(sources[0].files.map((f) => f.relativePath)).toEqual([
      'CAM_A/A-0001.MP4',
      'CAM_A/A-0002.MP4'
    ])
    expect(sources[1].files.map((f) => f.relativePath)).toEqual([
      'CAM_B/C0001.MP4',
      'CAM_B/C0002.MP4'
    ])
    expect(sources[0].basis).toBe('フォルダ CAM_A')
    // 同じ頭でも、続きと分からないピンマイクは人ごとの別のマイクにする
    expect(sources[2].files.map((f) => f.relativePath)).toEqual(['AUDIO/PIN_01.WAV'])
    expect(sources[3].files.map((f) => f.relativePath)).toEqual(['AUDIO/PIN_02.WAV'])
  })

  it('録音時刻から続きと分かるマイクの録音は1つにまとめる', () => {
    const sources = classifyFootage([
      file('ZOOM/ZOOM0001.WAV', { hasVideo: false, duration: 3600, recordedAt: 0 }),
      file('ZOOM/ZOOM0002.WAV', { hasVideo: false, duration: 1200, recordedAt: 3600 }),
      // 同じ時間に録っている別の録音機
      file('ZOOM/ZOOM0003.WAV', { hasVideo: false, duration: 3000, recordedAt: 100 })
    ])
    expect(sources).toHaveLength(2)
    expect(sourceDuration(sources[0])).toBe(4800)
    expect(sources[1].files[0].relativePath).toBe('ZOOM/ZOOM0003.WAV')
  })

  it('1つのフォルダに混ざった機材は、ファイル名の頭と機種で分ける', () => {
    const sources = classifyFootage([
      file('DCIM/GX010001.MP4', { device: 'GoPro HERO12' }),
      file('DCIM/DJI_0001.MP4', { device: 'DJI Osmo' }),
      file('DCIM/GX010002.MP4', { device: 'GoPro HERO12' })
    ])
    expect(sources).toHaveLength(2)
    expect(sources.find((s) => s.files.length === 2)!.basis).toContain('ファイル名 GX')
  })

  it('音も映像も無いファイルは除く', () => {
    expect(classifyFootage([file('x/memo.MP4', { hasVideo: false, hasAudio: false })])).toEqual([])
  })
})

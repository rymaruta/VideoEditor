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

  it('英字以外の名前の頭も取る', () => {
    expect(fileNamePrefix('カメラ_0001.MP4')).toBe('カメラ')
    expect(fileNamePrefix('ä-0001.MP4')).toBe('Ä')
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

  it('カードを替えて別のフォルダに続けて撮ったカメラは1台にまとめる', () => {
    const sources = classifyFootage([
      file('CamA/Card1/C0001.MP4', { device: 'Sony FX3', recordedAt: 0, duration: 600 }),
      file('CamA/Card1/C0002.MP4', { device: 'Sony FX3', recordedAt: 600, duration: 600 }),
      file('CamA/Card2/C0001.MP4', { device: 'Sony FX3', recordedAt: 1300, duration: 600 }),
      file('DCIM/100CANON/MVI_0001.MP4', { device: 'Canon R6', recordedAt: 0, duration: 900 }),
      file('DCIM/101CANON/MVI_0001.MP4', { device: 'Canon R6', recordedAt: 1000, duration: 900 })
    ])
    expect(sources).toHaveLength(2)
    const sony = sources.find((s) => s.files.length === 3)!
    expect(sony.files.map((f) => f.relativePath)).toEqual([
      'CamA/Card1/C0001.MP4',
      'CamA/Card1/C0002.MP4',
      'CamA/Card2/C0001.MP4'
    ])
    expect(sony.basis).toContain('Card1・Card2')
    expect(sources.find((s) => s.files.length === 2)!.files[1].relativePath).toBe(
      'DCIM/101CANON/MVI_0001.MP4'
    )
  })

  it('カードを丸ごと写したフォルダ(DCIM・PRIVATE/M4ROOT)でも、カードを替えて続けて撮ったカメラは1台', () => {
    for (const [a, b, name] of [
      [
        'CamA/Card1/DCIM/100CANON/MVI_0001.MP4',
        'CamA/Card2/DCIM/100CANON/MVI_0001.MP4',
        'Card1・Card2'
      ],
      [
        'CamB/Card1/PRIVATE/M4ROOT/CLIP/C0001.MP4',
        'CamB/Card2/PRIVATE/M4ROOT/CLIP/C0001.MP4',
        'Card1・Card2'
      ],
      ['Card1/DCIM/100GOPRO/GX010001.MP4', 'Card2/DCIM/100GOPRO/GX010001.MP4', 'Card1・Card2']
    ]) {
      const sources = classifyFootage([
        file(a, { device: 'X', recordedAt: 0, duration: 1800 }),
        file(b, { device: 'X', recordedAt: 1900, duration: 1800 })
      ])
      expect(sources, a).toHaveLength(1)
      expect(sources[0].files.map((f) => f.relativePath)).toEqual([a, b])
      expect(sources[0].basis).toContain(name)
    }
    // 同じ時間に撮った2枚のカードは別のカメラ
    expect(
      classifyFootage([
        file('Card1/DCIM/100GOPRO/GX010001.MP4', { device: 'X', recordedAt: 0, duration: 600 }),
        file('Card2/DCIM/100GOPRO/GX010001.MP4', { device: 'X', recordedAt: 30, duration: 600 })
      ])
    ).toHaveLength(2)
  })

  it('カメラごとのフォルダに写したカード(CamA/DCIM と CamB/DCIM)は、時刻が続いていても別のカメラ', () => {
    const sources = classifyFootage([
      file('CamA/DCIM/100CANON/MVI_0001.MP4', { device: 'Canon R6', recordedAt: 0, duration: 600 }),
      file('CamB/DCIM/100CANON/MVI_0001.MP4', {
        device: 'Canon R6',
        recordedAt: 700,
        duration: 600
      })
    ])
    expect(sources).toHaveLength(2)
    // 読み込んだフォルダの直下に写したカードと、別のカードのフォルダ: 名前の頭に「・」を付けない
    for (const s of classifyFootage([
      file('DCIM/100CANON/MVI_0001.MP4', { device: 'X', recordedAt: 0, duration: 600 }),
      file('Card2/DCIM/100CANON/MVI_0001.MP4', { device: 'X', recordedAt: 700, duration: 600 })
    ]))
      expect(s.basis).not.toMatch(/フォルダ ・|・$/)
  })

  it('カードのフォルダの名前は、全角の数字・後ろの日付・リール名・〜枚目でもカードとみなす', () => {
    for (const [c1, c2] of [
      ['カード１', 'カード２'],
      ['SD1_0501', 'SD2_0501'],
      ['A001', 'A002'],
      ['1枚目', '2枚目']
    ]) {
      const sources = classifyFootage([
        file(`CamA/${c1}/DCIM/100CANON/MVI_0001.MP4`, {
          device: 'R6',
          recordedAt: 0,
          duration: 1800
        }),
        file(`CamA/${c2}/DCIM/100CANON/MVI_0001.MP4`, {
          device: 'R6',
          recordedAt: 1900,
          duration: 1800
        })
      ])
      expect(sources, c1).toHaveLength(1)
    }
  })

  it('1段深いフォルダ(Day1/CamA/DCIM と Day1/CamB/DCIM)でも、別々のカメラのまま', () => {
    const sources = classifyFootage([
      file('Day1/CamA/DCIM/100CANON/MVI_0001.MP4', { device: 'R6', recordedAt: 0, duration: 600 }),
      file('Day1/CamB/DCIM/100CANON/MVI_0001.MP4', { device: 'R6', recordedAt: 700, duration: 600 })
    ])
    expect(sources).toHaveLength(2)
  })

  it('録音機が撮るたびに作るフォルダ(ZOOM0001 → 0002)の同じトラックは、1人のマイクにまとめる', () => {
    const mic = (take: number, tr: number): ProbedFile =>
      file(`ZOOM/ZOOM000${take}/ZOOM000${take}_Tr${tr}.WAV`, {
        hasVideo: false,
        device: 'H6',
        recordedAt: (take - 1) * 1000,
        duration: 900
      })
    const sources = classifyFootage([
      mic(1, 1),
      mic(1, 2),
      mic(2, 1),
      mic(2, 2),
      mic(3, 1),
      mic(3, 2)
    ])
    expect(sources.map((s) => s.files.map((f) => f.relativePath.split('/').pop()))).toEqual([
      ['ZOOM0001_Tr1.WAV', 'ZOOM0002_Tr1.WAV', 'ZOOM0003_Tr1.WAV'],
      ['ZOOM0001_Tr2.WAV', 'ZOOM0002_Tr2.WAV', 'ZOOM0003_Tr2.WAV']
    ])
    expect(sources.map((s) => s.name)).toEqual(['マイク1', 'マイク2'])
    // トラックの印の無い別々の録音機(PIN_01・PIN_02)は、時刻が続いていても別のフォルダならまとめない
    expect(
      classifyFootage([
        file('PIN_A/PIN_01.WAV', { hasVideo: false, recordedAt: 0, duration: 600 }),
        file('PIN_B/PIN_01.WAV', { hasVideo: false, recordedAt: 700, duration: 600 })
      ])
    ).toHaveLength(2)
  })

  it('名前で分けたカメラのフォルダ(CamA と CamB)は、同じ機種で時刻が続いていても別のカメラ', () => {
    const sources = classifyFootage([
      file('CamA/C0001.MP4', { device: 'Sony FX3', recordedAt: 0, duration: 600 }),
      file('CamB/C0001.MP4', { device: 'Sony FX3', recordedAt: 700, duration: 600 })
    ])
    expect(sources).toHaveLength(2)
    // カメラが作る続きのフォルダ(100CANON → 101CANON・DJI_001 → DJI_002・Camera01 → Camera02・日付)は1台
    for (const [a, b] of [
      ['DCIM/100CANON', 'DCIM/101CANON'],
      ['DCIM/DJI_001', 'DCIM/DJI_002'],
      ['DCIM/Camera01', 'DCIM/Camera02'],
      ['2024-05-01', '2024-05-02']
    ])
      expect(
        classifyFootage([
          file(`${a}/MVI_0001.MP4`, { device: 'X', recordedAt: 0, duration: 600 }),
          file(`${b}/MVI_0001.MP4`, { device: 'X', recordedAt: 700, duration: 600 })
        ]),
        `${a} ${b}`
      ).toHaveLength(1)
  })

  it('同じ機種でも同じ時間に撮っていれば・時刻が分からなければ別のカメラのまま', () => {
    const sources = classifyFootage([
      file('CAM_A/C0001.MP4', { device: 'Sony FX3', recordedAt: 0, duration: 600 }),
      file('CAM_B/C0001.MP4', { device: 'Sony FX3', recordedAt: 10, duration: 600 }),
      file('CAM_C/C0001.MP4', { device: 'Sony FX3' })
    ])
    expect(sources).toHaveLength(3)
  })

  it('音も映像も無いファイルは除く', () => {
    expect(classifyFootage([file('x/memo.MP4', { hasVideo: false, hasAudio: false })])).toEqual([])
  })
})

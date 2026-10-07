import { describe, expect, it } from 'vitest'
import { buildShortProject } from '../../src/renderer/src/lib/gameShorts'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project } from '@shared/types'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import { containRect, faceToCanvas } from '@shared/telop/avoidFaces'
import { hudMapToCanvas, speechYAvoidingHud, type HudMap } from '@shared/telop/hud'

/**
 * ショートは本編の人の修正に従う(削った区間・直した文字・消したテロップ・消した音)。
 * 本編で削った所(個人の情報・関係の無い話)をショートに戻さない
 */
const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' },
    { id: 'b', name: 'B', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 60 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 60 },
    { assetId: 'MB', sourceId: 'b', start: 0, rate: 1, duration: 60 }
  ]
}
const utt = (id: string, assetId: string, start: number, end: number, text: string): unknown => ({
  id,
  assetId,
  speaker: assetId === 'MA' ? 'A' : 'B',
  sourceStart: start,
  sourceEnd: end,
  text,
  words: [{ text, start, end }],
  overlap: false
})
const asset = (id: string, video: boolean): unknown => ({
  id,
  filePath: `/r/${id}`,
  fileName: id,
  duration: 60,
  width: video ? 1920 : 0,
  height: video ? 1080 : 0,
  hasAudio: true,
  hasVideo: video
})
const activity = (() => {
  const a = new Uint8Array(60 * TURN_RATE)
  for (const [s, e] of [
    [2, 5],
    [10, 14],
    [20, 24]
  ])
    a.fill(1, s * TURN_RATE, e * TURN_RATE)
  return a
})()

describe('ショートは本編の人の修正に従う', () => {
  const project = {
    id: 'p',
    name: '本編',
    aspectRatio: '16:9',
    assets: [asset('C', true), asset('MA', false), asset('MB', false)],
    clips: [],
    audioTracks: [
      {
        id: 't',
        name: 'B',
        multicamSourceId: 'b',
        muted: true,
        volume: 1,
        autoVolume: 1,
        duckingEnabled: false,
        clips: []
      }
    ],
    videoOverlayTracks: [],
    textOverlays: [],
    transcript: [
      utt('u1', 'MA', 2, 5, 'ごしきじ'),
      utt('u2', 'MB', 10, 14, 'じゅうしょはとうきょう'),
      utt('u3', 'MA', 20, 24, 'すごい')
    ],
    multicam: info,
    dismissedTelops: ['u:u3#0'],
    editedTelops: { 'u:u1#0': { text: '誤字直し', style: defaultTextStyle() } }
  } as unknown as Project

  it('削った区間・直した文字・消したテロップ・消した音を、そのまま当てる', () => {
    const short = buildShortProject(
      {
        project,
        info,
        hype: [],
        activity,
        styles: [],
        speechLook: { style: defaultTextStyle() },
        overrides: {
          removed: [{ start: 9.5, end: 14.5 }],
          added: [{ start: 40, end: 50 }],
          angles: []
        }
      },
      { start: 0, end: 30, strength: 10, peaks: 1 },
      0
    )
    const texts = short.textOverlays.map((t) => t.text)
    expect(texts).toContain('誤字直し')
    expect(texts).not.toContain('ごしきじ')
    expect(texts).not.toContain('すごい')
    expect(texts).not.toContain('じゅうしょはとうきょう')
    // 削った 9.5〜14.5 秒は本編に入らない。足した区間はショートの外なので入れない
    for (const c of short.clips) {
      expect(c.outPoint <= 9.5 + 1e-6 || c.inPoint >= 14.5 - 1e-6).toBe(true)
      expect(c.inPoint).toBeLessThan(30)
    }
    expect(short.audioTracks.find((t) => t.multicamSourceId === 'b')?.muted).toBe(true)
    expect(short.audioTracks.find((t) => t.multicamSourceId === 'a')?.muted).toBe(false)
  })
})

describe('縦長の企画に横長の録画を置いたとき、HUD・顔は画面の位置で比べる', () => {
  it('16:9 の録画の下の HUD は、9:16 の画面では真ん中より下の帯の中。既定の下のテロップ(黒い帯の上)は動かさない', () => {
    const cols = 16
    const rows = 9
    const cells = new Float32Array(cols * rows)
    // 絵の下 2 割・横の真ん中に HUD
    for (let r = 7; r < 9; r++) for (let c = 4; c < 12; c++) cells[r * cols + c] = 1
    const map: HudMap = { cols, rows, cells }
    const fit = containRect({ width: 1920, height: 1080 }, { w: 1080, h: 1920 })
    expect(fit.y).toBeCloseTo(0.342, 2)
    const onCanvas = hudMapToCanvas(map, fit)
    expect(speechYAvoidingHud(onCanvas, 0.895)).toBeNull()
    // 同じ縦横比なら写しても変わらない
    expect(
      hudMapToCanvas(map, containRect({ width: 1920, height: 1080 }, { w: 1920, h: 1080 }))
    ).toBe(map)
    const face = faceToCanvas({ x: 0.4, y: 0.8, w: 0.2, h: 0.2, score: 1 }, fit)
    expect(face.y).toBeCloseTo(0.342 + 0.8 * 0.316, 2)
  })
})

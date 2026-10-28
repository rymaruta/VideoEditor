import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import {
  applyVerticalFill,
  coverRect,
  framingCenter,
  prepareVerticalFill,
  windowFraction
} from '@renderer/lib/verticalFraming'
import { useSettingsStore } from '@renderer/store/settingsStore'
import type { FaceBox } from '@shared/telop/avoidFaces'
import { defaultTextStyle } from '@shared/textStyle'
import type { Project, TextOverlay } from '@shared/types'

/**
 * 試し編集 第2回の不具合 4: ショートを書き出すと、横の絵を縮めて上下を黒にした形になり、人物が小さかった。
 * 縦(9:16)は既定で、人物(顔)に寄せて絵で埋めるように切り出す。黒帯の形は設定で選べる
 */
const face = (x: number, w = 0.08, score = 0.9): FaceBox => ({ x, y: 0.3, w, h: w * 1.6, score })
const SRC = { width: 640, height: 360 }
const FRACTION = windowFraction(SRC, 9 / 16)

describe('縦の枠の真ん中(人物に寄せる)', () => {
  it('16:9 の絵を 9:16 で埋めると、枠は絵の幅の 3 割ほど', () => {
    expect(FRACTION).toBeCloseTo(0.316, 3)
  })

  it('1人なら、その人の顔に寄せる', () => {
    const c = framingCenter([[face(0.66)], [face(0.67)], null], FRACTION)!
    expect(c.x).toBeGreaterThan(0.66)
    expect(c.x).toBeLessThan(0.75)
  })

  it('2人が枠に収まる間隔なら、両方が入る位置', () => {
    const c = framingCenter([[face(0.4), face(0.56)]], FRACTION)!
    expect(c.x).toBeCloseTo((0.4 + 0.64) / 2, 6)
  })

  it('2人が離れていて枠に収まらなければ、よく映っている方に寄せる', () => {
    // 左の人は小さく1回、右の人は大きく3回映る
    const c = framingCenter(
      [[face(0.12, 0.05), face(0.7, 0.1)], [face(0.71, 0.1)], [face(0.7, 0.1)]],
      FRACTION
    )!
    expect(c.x).toBeGreaterThan(0.7)
    // 顔が無ければ決めない(真ん中で切る)
    expect(framingCenter([[], null], FRACTION)).toBeNull()
  })

  it('切り出した絵の画面での位置は、書き出しの切り出しと同じ(端では内側へ寄せる)', () => {
    const r = coverRect(SRC, { w: 1080, h: 1920 }, { x: 0.7, y: 0.5 })
    expect(r.h).toBeCloseTo(1, 9)
    expect(r.w).toBeCloseTo(1 / FRACTION, 6)
    // 素材の 0.7 の所が画面の真ん中に来る
    expect(r.x + r.w * 0.7).toBeCloseTo(0.5, 6)
    const edge = coverRect(SRC, { w: 1080, h: 1920 }, { x: 0.98, y: 0.5 })
    expect(edge.x + edge.w).toBeCloseTo(1, 9)
  })
})

describe('縦の書き出し用の写し', () => {
  const asset = {
    id: 'A',
    filePath: '/r/A001.mp4',
    fileName: 'A001.mp4',
    duration: 660,
    width: 640,
    height: 360,
    hasAudio: true,
    hasVideo: true
  }
  const telop = (
    id: string,
    startTime: number,
    endTime: number,
    extra: Partial<TextOverlay> = {}
  ): TextOverlay => ({
    id,
    text: '賃上げもしっかりと\nされたというふうに',
    startTime,
    endTime,
    style: defaultTextStyle(),
    source: 'auto',
    utteranceId: `u-${id}`,
    utteranceChunk: 0,
    ...extra
  })
  const project = {
    id: 'p',
    name: '試し編集',
    aspectRatio: '9:16',
    assets: [asset],
    clips: [
      { id: 'c1', assetId: 'A', inPoint: 276, outPoint: 300, speed: 1 },
      // 人が「枠を埋めない」と決めたクリップ
      { id: 'c2', assetId: 'A', inPoint: 300, outPoint: 310, speed: 1, fillCrop: false },
      { id: 'c3', assetId: 'A', inPoint: 310, outPoint: 326, speed: 1 }
    ],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [telop('t1', 2, 5), telop('t2', 36, 40)]
  } as unknown as Project

  it('人が決めていないクリップを、顔に寄せて絵で埋める(人の決めた切り抜きと企画はそのまま)', () => {
    const before = JSON.stringify(project)
    const faces = new Map([['c1', [[face(0.62)], [face(0.63)], [face(0.62)]]]])
    const r = applyVerticalFill(project, faces)
    expect(JSON.stringify(project)).toBe(before)
    const [c1, c2, c3] = r.project.clips
    expect(c1.fillCrop).toBe(true)
    expect(c1.cropCenter!.x).toBeGreaterThan(0.6)
    expect(c2.fillCrop).toBe(false)
    expect(c2.cropCenter).toBeUndefined()
    // 顔が見つからないクリップは真ん中で埋める
    expect(c3.fillCrop).toBe(true)
    expect(c3.cropCenter).toEqual({ x: 0.5, y: 0.5 })
    expect(r.filled).toBe(2)
    expect(r.onFaces).toBe(1)
  })

  it('発言テロップは、切り出した絵の顔を避け、Shorts の下の帯に隠れない高さへ', () => {
    // c1 の顔が下の方まで大きく映る(切り出すと画面の下に掛かる)
    const low: FaceBox = { x: 0.55, y: 0.62, w: 0.12, h: 0.3, score: 0.95 }
    const r = applyVerticalFill(project, new Map([['c1', [[low], [low], [low]]]]))
    const [t1, t2] = r.project.textOverlays
    expect(t1.style.position).toBe('top')
    expect(r.movedTelops).toBe(1)
    // 顔の無い所のテロップは、下の帯(高さの 84% より下)に入らない高さへ上げる
    expect(t2.style.position).toBe('bottom')
    expect(t2.style.customPosition!.y).toBeLessThan(0.84)
  })

  it('書き出しの前に顔を探して写しを作る(探せなければ真ん中で埋める)', async () => {
    const calls: unknown[] = []
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        onFaceProgress: () => () => {},
        faceDetect: async (requests: { time: number }[]) => {
          calls.push(...requests)
          return requests.map((q) => (q.time < 300 ? [face(0.3)] : []))
        }
      }
    }
    const r = await prepareVerticalFill(project)
    // c1 と c3 の 3 か所ずつ(人の決めた c2 は探さない)
    expect(calls).toHaveLength(6)
    expect(r.project.clips[0].cropCenter!.x).toBeLessThan(0.45)
    expect(r.project.clips[2].cropCenter).toEqual({ x: 0.5, y: 0.5 })
  })

  it('既定は「人物に寄せて切り出す」。黒帯の形は設定で選べる', () => {
    expect(useSettingsStore.getState().verticalFraming).toBe('fill')
    useSettingsStore.getState().setVerticalFraming('letterbox')
    expect(useSettingsStore.getState().verticalFraming).toBe('letterbox')
  })
})

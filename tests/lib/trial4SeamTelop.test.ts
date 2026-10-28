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
  seamTelopBottom,
  stackFacesOnCanvas,
  type FaceSample
} from '@renderer/lib/verticalFraming'
import type { FaceBox } from '@shared/telop/avoidFaces'
import { stackSimultaneousTelops, telopBlockHeight } from '@shared/telop/stack'
import { stackTopHeight } from '@shared/videoFrame'
import { defaultTextStyle, TEXT_MARGIN_V_RATIO } from '@shared/textStyle'
import type { Project, TextOverlay } from '@shared/types'

/**
 * 試し編集 第4回 N2: 上下2段(splitStack)のショートで、発言テロップが行数によって上の段(2行)と下の段(1行)を
 * 行き来し、2〜3 秒ごとに位置が跳んだ(下の人のあごにも掛かった)。2段の形では縦の定番どおり継ぎ目(縦の真ん中)
 * に置き、行数が変わっても下端をそろえる。顔に掛かるときだけ継ぎ目の帯の中でずらす
 */
const CANVAS = { w: 1080, h: 1920 }
const SEAM = stackTopHeight(CANVAS.h) / CANVAS.h
const face = (x: number, w = 0.08, y = 0.3, score = 0.9): FaceBox => ({
  x,
  y,
  w,
  h: w * 1.6,
  score
})
const asset = {
  id: 'A',
  filePath: '/r/A001.mp4',
  fileName: 'A001.mp4',
  duration: 660,
  width: 640,
  height: 360,
  fps: 30,
  hasAudio: true,
  hasVideo: true
}
// 第4回の書き出しで続いた発言テロップ(2行・1行・2行・1行…)
const TEXTS = [
  '賃上げもしっかりと\nされたというふうに',
  '多くなってきて特に昨年は',
  'お給料はですね\nコストではなくて',
  '課題を乗り越えていただき',
  'そこで働いている\n方々のやる気であったり',
  'そして投資'
]
const telops = (): TextOverlay[] =>
  TEXTS.map((text, i) => ({
    id: `t${i}`,
    text,
    startTime: 2 + i * 2.5,
    endTime: 4.4 + i * 2.5,
    style: { ...defaultTextStyle(), fontSize: 64 },
    source: 'auto',
    utteranceId: `u${i}`,
    utteranceChunk: 0
  }))
const project = (): Project =>
  ({
    id: 'p',
    name: '車座',
    aspectRatio: '9:16',
    assets: [asset],
    clips: [{ id: 'c1', assetId: 'A', inPoint: 276, outPoint: 326, speed: 1 }],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: telops()
  }) as unknown as Project
const samplesFor = (faces: FaceBox[]): FaceSample[] =>
  [280, 300, 320].map((time) => ({ time, faces }))

/** 書き出しで描く範囲(下端・上端) */
const span = (o: TextOverlay): { top: number; bottom: number } => {
  const h = telopBlockHeight(o, CANVAS.h, CANVAS.w)
  // 上へ移した枚(前の動き)は画面の上端から
  if (!o.style.customPosition)
    return o.style.position === 'top'
      ? { top: TEXT_MARGIN_V_RATIO, bottom: TEXT_MARGIN_V_RATIO + h }
      : { top: 1 - TEXT_MARGIN_V_RATIO - h, bottom: 1 - TEXT_MARGIN_V_RATIO }
  const y = o.style.customPosition.y
  return { top: y - h / 2, bottom: y + h / 2 }
}
const overlaps = (s: { top: number; bottom: number }, f: FaceBox): boolean =>
  Math.min(s.bottom, f.y + f.h) - Math.max(s.top, f.y) > 0

describe('上下2段のショートの発言テロップは継ぎ目に置き、行数で跳ばない', () => {
  // 第4回: 2人とも絵のやや下に映り、下の人の顔が段の上の方に来る
  const cases: [string, FaceBox[]][] = [
    ['ふつうの高さ', [face(0.15), face(0.75)]],
    ['2人が絵の下の方', [face(0.12, 0.12, 0.62), face(0.72, 0.12, 0.62)]],
    ['上の人が低い・下の人が高い', [face(0.15, 0.1, 0.5), face(0.75, 0.1, 0.12)]]
  ]
  for (const [name, faces] of cases)
    it(`${name}: 行数の違う続いたテロップの下端が同じ・継ぎ目の帯の中・顔に掛からない`, () => {
      const r = applyVerticalFill(project(), new Map([['c1', samplesFor(faces)]]))
      const split = r.project.clips[0].splitStack!
      expect(split).toBeDefined()
      const onCanvas = stackFacesOnCanvas(faces, split, CANVAS.h).filter((f) => f.score >= 0.7)
      const spans = r.project.textOverlays.map(span)
      // 位置は一定(下端そろえ)
      for (const s of spans) expect(s.bottom).toBeCloseTo(spans[0].bottom, 6)
      // 上の段・下の段を行き来しない: どれも継ぎ目の帯の中(継ぎ目から 0.12 + 2行の半分まで)
      const two = telopBlockHeight({ text: 'あ\nあ', style: telopsStyle() }, CANVAS.h, CANVAS.w)
      expect(Math.abs(spans[0].bottom - (SEAM + two / 2))).toBeLessThanOrEqual(0.12 + 1e-9)
      for (const s of spans) {
        expect(s.top).toBeLessThan(SEAM + 0.12 + two)
        expect(s.bottom).toBeGreaterThan(SEAM - 0.12)
        // Shorts の下の帯に隠れない
        expect(s.bottom).toBeLessThanOrEqual(0.82 + 1e-9)
      }
      // 顔に掛からない(あごも)
      for (const s of spans) for (const f of onCanvas) expect(overlaps(s, f)).toBe(false)
    })

  it('顔が継ぎ目から離れていれば、ちょうど継ぎ目(2行のテロップが継ぎ目をまたぐ高さ)', () => {
    const r = applyVerticalFill(project(), new Map([['c1', samplesFor([face(0.15), face(0.75)])]]))
    const two = telopBlockHeight({ text: 'あ\nあ', style: telopsStyle() }, CANVAS.h, CANVAS.w)
    for (const o of r.project.textOverlays) {
      const s = span(o)
      expect(s.bottom).toBeCloseTo(SEAM + two / 2, 6)
      // 1行のテロップも継ぎ目に触れる
      expect(s.top).toBeLessThanOrEqual(SEAM + two / 2)
    }
    expect(r.movedTelops).toBe(0)
  })

  it('手で置いたテロップ(自由配置)・上のテロップは動かさない', () => {
    const p = project()
    p.textOverlays[0] = {
      ...p.textOverlays[0],
      style: { ...p.textOverlays[0].style, customPosition: { x: 0.3, y: 0.2 } }
    }
    p.textOverlays[1] = {
      ...p.textOverlays[1],
      style: { ...p.textOverlays[1].style, position: 'top' }
    }
    const r = applyVerticalFill(p, new Map([['c1', samplesFor([face(0.15), face(0.75)])]]))
    expect(r.project.textOverlays[0].style).toEqual(p.textOverlays[0].style)
    expect(r.project.textOverlays[1].style).toEqual(p.textOverlays[1].style)
  })

  it('seamTelopBottom: 帯の中で避けられなければ継ぎ目のまま', () => {
    const wall: FaceBox[] = [{ x: 0, y: 0.2, w: 1, h: 0.6, score: 0.9 }]
    expect(seamTelopBottom(0.04, 0.08, 0.5, wall)).toBeCloseTo(0.54, 9)
    // 1行でも2行でも同じ下端
    const chin: FaceBox[] = [{ x: 0.3, y: 0.3, w: 0.3, h: 0.22, score: 0.9 }]
    expect(seamTelopBottom(0.04, 0.08, 0.5, chin)).toBeCloseTo(
      seamTelopBottom(0.08, 0.08, 0.5, chin),
      9
    )
    // あごを避けて下へ(あごの端にわずかに触れる程度まで)
    expect(seamTelopBottom(0.04, 0.08, 0.5, chin) - 0.08).toBeGreaterThan(0.51)
  })
})

function telopsStyle(): TextOverlay['style'] {
  return telops()[0].style
}

describe('上下2段で同じ時間に出る2人のテロップ(第4回の直しの監査の指摘 5)', () => {
  // 掛け合いで声が重なり、組み立てが段に積んだ2枚(後の発言が1段上の自由配置)
  const pairProject = (): Project => {
    const base = telops().slice(0, 2)
    const a = { ...base[0], startTime: 2, endTime: 5 }
    const b = { ...base[1], startTime: 3, endTime: 6 }
    const stacked = stackSimultaneousTelops([a, b], CANVAS.h)
    expect(stacked[1].style.customPosition).toBeDefined()
    return { ...project(), textOverlays: stacked }
  }

  it('継ぎ目の上下に並べる(先の発言が上・後の発言が下)。重ならない', () => {
    const r = applyVerticalFill(
      pairProject(),
      new Map([['c1', samplesFor([face(0.15), face(0.75)])]])
    )
    const [first, second] = r.project.textOverlays.map(span)
    expect(first.bottom).toBeLessThanOrEqual(SEAM)
    expect(second.top).toBeGreaterThanOrEqual(SEAM)
    expect(first.bottom).toBeGreaterThan(SEAM - 0.05)
    expect(second.top).toBeLessThan(SEAM + 0.05)
  })

  it('手で置いた枚は、同じ時間に出ていても動かさない', () => {
    const p = pairProject()
    const manual = {
      ...p.textOverlays[1],
      style: { ...p.textOverlays[1].style, customPosition: { x: 0.5, y: 0.3 } }
    }
    const q = { ...p, textOverlays: [p.textOverlays[0], manual] }
    const r = applyVerticalFill(q, new Map([['c1', samplesFor([face(0.15), face(0.75)])]]))
    expect(r.project.textOverlays[1].style.customPosition).toEqual({ x: 0.5, y: 0.3 })
  })
})

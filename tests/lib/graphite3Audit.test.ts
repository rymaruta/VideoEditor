/**
 * Graphite 3(g3-timeline)の監査の指摘の守り。
 * 取り消しの振り分け・並べ方と安全枠の記憶・テロップの字/秒と fps・下段の既定の高さ・
 * 波形の絵の上限・見えなくなったタイルを捨てる処理・ほどいた絵の覚え場所の上限。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const store = new Map<string, string>()
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0
}

import { modifierLabel, performUndoRedo } from '@renderer/lib/undoAction'
import {
  readMediaLayout,
  readSafeFrame,
  readTelopMetricsOpen,
  storeMediaLayout,
  storeSafeFrame,
  storeTelopMetricsOpen
} from '@renderer/lib/uiPrefs'
import { telopMetrics } from '@renderer/lib/telopMetrics'
import { TIMELINE_LANES_HEIGHT, defaultBottomHeight } from '@renderer/lib/layoutDefaults'
import {
  ByteLimitedCache,
  WAVEFORM_HEIGHT_SCALE,
  fitsFfmpegImage,
  releaseCanvas,
  waveformImageRequestSize
} from '@renderer/lib/waveformTiles'
import { WAVE_PEAKS_MAX_COLUMNS, WavePeakAccumulator, wavePeaksBytes } from '@shared/waveformPeaks'
import type { Clip, MediaAsset, TextOverlay } from '@shared/types'

beforeEach(() => store.clear())

describe('取り消しの振り分け(上の帯のボタン・メニュー)', () => {
  const deps = (
    typing: boolean,
    modalOpen: boolean
  ): {
    typing: boolean
    modalOpen: boolean
    execCommand: Mock
    undo: Mock
    redo: Mock
  } => ({
    typing,
    modalOpen,
    execCommand: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn()
  })
  it('文字を打っている欄なら、欄の取り消し(文字単位)。プロジェクトは取り消さない', () => {
    const d = deps(true, false)
    expect(performUndoRedo('undo', d)).toBe('field')
    expect(d.execCommand).toHaveBeenCalledWith('undo')
    expect(d.undo).not.toHaveBeenCalled()
  })
  it('ダイアログの上では何もしない(裏のプロジェクトを取り消さない)', () => {
    const d = deps(false, true)
    expect(performUndoRedo('redo', d)).toBe('blocked')
    expect(d.redo).not.toHaveBeenCalled()
    expect(d.execCommand).not.toHaveBeenCalled()
  })
  it('それ以外はプロジェクトの取り消し・やり直し', () => {
    const d = deps(false, false)
    performUndoRedo('undo', d)
    performUndoRedo('redo', d)
    expect(d.undo).toHaveBeenCalledTimes(1)
    expect(d.redo).toHaveBeenCalledTimes(1)
  })
  it('キーの表記は mac で Cmd、ほかは Ctrl', () => {
    expect(modifierLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Cmd')
    expect(modifierLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl')
  })
})

describe('見え方の記憶', () => {
  it('素材の並べ方: 既定は一覧。格子を選んだら覚える', () => {
    expect(readMediaLayout()).toBe('list')
    storeMediaLayout('grid')
    expect(readMediaLayout()).toBe('grid')
    storeMediaLayout('list')
    expect(readMediaLayout()).toBe('list')
  })
  it('安全枠: 既定は出さない。出すと決めたら覚える', () => {
    expect(readSafeFrame()).toBe(false)
    storeSafeFrame(true)
    expect(readSafeFrame()).toBe(true)
  })
  it('テロップの数値のカード: 低い窓では畳む。開け閉めを選んだら覚える', () => {
    expect(readTelopMetricsOpen(768)).toBe(false)
    expect(readTelopMetricsOpen(1080)).toBe(true)
    storeTelopMetricsOpen(true)
    expect(readTelopMetricsOpen(768)).toBe(true)
  })
})

describe('テロップの数値(字/秒と fps)', () => {
  const overlay = (id: string, text: string, s: number, e: number): TextOverlay =>
    ({ id, text, startTime: s, endTime: e, style: {} }) as unknown as TextOverlay
  const project = (
    fps: number
  ): { textOverlays: TextOverlay[]; clips: Clip[]; assets: MediaAsset[] } => ({
    textOverlays: [overlay('b', '二枚目', 5, 6), overlay('a', '**なぜ**私の\nロボット', 1, 3)],
    clips: [{ id: 'c', assetId: 'v', inPoint: 0, outPoint: 10, speed: 1 } as Clip],
    assets: [{ id: 'v', fps } as MediaAsset]
  })
  it('字数は描かれる文字だけ・空白を除く。字/秒は表示の秒で割る。時刻順で何枚目か', () => {
    const p = project(24)
    const m = telopMetrics(p.textOverlays[1], p)
    expect(m.chars).toBe(8) // なぜ私の + ロボット
    expect(m.shownSec).toBe(2)
    expect(m.cps).toBe(4)
    expect(m.nth).toBe(1)
    expect(m.total).toBe(2)
    expect(m.longestLine).toBe(4)
  })
  it('時刻のフレームレートは企画のもの(30 決め打ちにしない)', () => {
    expect(telopMetrics(project(24).textOverlays[0], project(24)).fps).toBe(24)
    expect(telopMetrics(project(60).textOverlays[0], project(60)).fps).toBe(60)
  })
  it('表示 0 秒なら字/秒は 0', () => {
    const p = project(30)
    expect(telopMetrics(overlay('z', 'あ', 2, 2), p).cps).toBe(0)
  })
})

describe('下段(タイムライン)の既定の高さ', () => {
  it('1920×1080 ではレーンが全部見える高さ、1366×768 ではモニターに半分を残す', () => {
    expect(defaultBottomHeight(1080, 112, 180)).toBe(TIMELINE_LANES_HEIGHT)
    expect(defaultBottomHeight(768, 112, 180)).toBe(328)
    expect(defaultBottomHeight(300, 112, 180)).toBe(180)
  })
})

describe('波形の上限とメモリ', () => {
  it('どの長さ・拡大でも、絵の波形は ffmpeg の上限 (w+128)(h+128) < 2^28 を越えない', () => {
    // 3 時間のクリップを最大拡大(160px/秒)・本編/音の波形の高さ
    for (const sec of [10, 600, 3600, 2.5 * 3600, 3 * 3600]) {
      for (const pps of [10, 40, 160]) {
        for (const h of [28, 30]) {
          const s = waveformImageRequestSize(sec * pps, h)
          expect(fitsFfmpegImage(s.width, s.height)).toBe(true)
          expect(s.width).toBeGreaterThan(0)
        }
      }
    }
    // 短いクリップは細かいまま(横 2 倍・縦 2 倍)
    expect(waveformImageRequestSize(1000, 30)).toEqual({
      width: 2000,
      height: 30 * WAVEFORM_HEIGHT_SCALE
    })
  })
  it('値の波形は絵を作らない。列は上限で切り、大きさは列の数ぶん', () => {
    const acc = new WavePeakAccumulator(3 * 3600 * 160 * 2, 2, 1000)
    const p = acc.finish()
    expect(p.columns).toBe(WAVE_PEAKS_MAX_COLUMNS)
    expect(wavePeaksBytes(p)).toBeLessThan(2 * 1024 * 1024)
  })
  it('見えなくなったタイルは canvas の中身を捨てる(幅・高さ 0)', () => {
    const canvas = { width: 2048, height: 60 }
    releaseCanvas(canvas)
    expect(canvas).toEqual({ width: 0, height: 0 })
  })
  it('ほどいた絵の覚え場所は、バイト数の合計で上限を持つ(送り続けても増えない)', () => {
    const cache = new ByteLimitedCache<number>(10 * 1024 * 1024, 64)
    // 3 時間の素材を端まで送る: 大きな絵(各 2MB)を 500 枚
    for (let i = 0; i < 500; i++) {
      cache.set(`u${i}`, i, 2 * 1024 * 1024)
      expect(cache.bytes).toBeLessThanOrEqual(10 * 1024 * 1024)
    }
    expect(cache.size).toBe(5)
    expect(cache.get('u499')).toBe(499)
    expect(cache.get('u0')).toBeUndefined()
    // 1 つで上限を越えるものは覚えない
    cache.set('huge', 1, 11 * 1024 * 1024)
    expect(cache.get('huge')).toBeUndefined()
  })
  it('数の上限も効き、使ったものは新しい側へ移る', () => {
    const cache = new ByteLimitedCache<string>(1e9, 2)
    cache.set('a', 'A', 1)
    cache.set('b', 'B', 1)
    cache.get('a')
    cache.set('c', 'C', 1)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('A')
  })
})

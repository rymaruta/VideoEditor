import { describe, expect, it } from 'vitest'
import { frameCountForDuration, targetFrameRate } from '@shared/frameRate'
import { targetResolution, textCanvasSize } from '@shared/resolution'
import { pipMarginPx } from '@shared/pipLayout'
import { safeFileBaseName, DEFAULT_PROJECT_NAME } from '@shared/fileName'
import { NASTY_NUMBERS } from '../helpers/boundary'

describe('targetFrameRate — 出力のフレームレート', () => {
  it('素材のフレームレートに合わせる(決め打ちしない)', () => {
    expect(targetFrameRate([60])).toBe(60)
    expect(targetFrameRate([30])).toBe(30)
    expect(targetFrameRate([24])).toBe(24)
  })

  it('混ざっていたら一番速いものに合わせる', () => {
    expect(targetFrameRate([24, 30, 60])).toBe(60)
  })

  it('小数のフレームレートは丸める(29.97 → 30)', () => {
    expect(targetFrameRate([29.97])).toBe(30)
    expect(targetFrameRate([59.94])).toBe(60)
  })

  it('素材が無い/全部おかしいときは既定へ落ちる', () => {
    const fallback = targetFrameRate([])
    expect(Number.isFinite(fallback)).toBe(true)
    expect(fallback).toBeGreaterThan(0)
    expect(targetFrameRate([NaN, Infinity, -1, 0, 1e9])).toBe(fallback)
  })

  it('【不変条件】必ず有限で正、上限以下', () => {
    for (const v of NASTY_NUMBERS) {
      const f = targetFrameRate([v])
      expect(Number.isFinite(f), `${v} -> ${f}`).toBe(true)
      expect(f).toBeGreaterThan(0)
      expect(f).toBeLessThanOrEqual(240)
    }
  })
})

describe('frameCountForDuration — 秒 → コマ数', () => {
  it('秒 × fps を四捨五入', () => {
    expect(frameCountForDuration(1, 30)).toBe(30)
    expect(frameCountForDuration(2.345, 30)).toBe(70)
    expect(frameCountForDuration(0.5, 60)).toBe(30)
  })

  it('0・負・NaN は 0 コマ', () => {
    const cases: [number, number][] = [
      [0, 30],
      [-1, 30],
      [NaN, 30],
      [1, 0],
      [1, -30],
      [1, NaN]
    ]
    for (const [d, f] of cases) {
      expect(frameCountForDuration(d, f), `${d}s @${f}fps`).toBe(0)
    }
  })

  it('【不変条件】0 以上で、NaN を返さない', () => {
    for (const d of NASTY_NUMBERS) {
      for (const f of [24, 30, 60]) {
        const n = frameCountForDuration(d, f)
        expect(Number.isNaN(n), `${d}@${f} -> ${n}`).toBe(false)
        expect(n).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('実用の範囲(0〜24時間)では必ず整数', () => {
    for (const d of [0.001, 0.5, 1, 2.345, 60, 3600, 86400]) {
      for (const f of [24, 30, 60]) {
        expect(Number.isInteger(frameCountForDuration(d, f)), `${d}@${f}`).toBe(true)
      }
    }
  })

  it('【既知の穴】桁が極端な尺は掛け算で Infinity になる', () => {
    // 尺そのものは有限性を見ているが、**fps を掛けた結果**は見ていない。
    // 手で書き換えた `.veproj` からしか届かない(読み込みは有限性しか見ない)。
    // BACKLOG の候補に積んである。直したらこのテストが落ちるので期待値を書き換えること。
    expect(frameCountForDuration(Number.MAX_VALUE, 30)).toBe(Infinity)
  })
})

describe('targetResolution — 出力の縦横', () => {
  it('16:9 は横長、9:16 は縦長', () => {
    expect(targetResolution('16:9', 720)).toEqual({ w: 1280, h: 720 })
    expect(targetResolution('9:16', 720)).toEqual({ w: 720, h: 1280 })
  })

  it('1080 でも同じ規則', () => {
    expect(targetResolution('16:9', 1080)).toEqual({ w: 1920, h: 1080 })
    expect(targetResolution('9:16', 1080)).toEqual({ w: 1080, h: 1920 })
  })

  it('【不変条件】幅も高さも偶数(libx264 が奇数を受け付けない)', () => {
    for (const std of [360, 480, 540, 720, 1080, 1440, 2160]) {
      for (const ar of ['16:9', '9:16'] as const) {
        const { w, h } = targetResolution(ar, std)
        expect(w % 2, `${ar} ${std} w=${w}`).toBe(0)
        expect(h % 2, `${ar} ${std} h=${h}`).toBe(0)
      }
    }
  })

  it('テロップの仮想キャンバスは出力解像度に依らない', () => {
    expect(textCanvasSize('16:9')).toEqual({ w: 1920, h: 1080 })
    expect(textCanvasSize('9:16')).toEqual({ w: 1080, h: 1920 })
  })
})

describe('pipMarginPx — PiP の余白', () => {
  it('幅に対する割合', () => {
    expect(pipMarginPx(1000)).toBeCloseTo(40, 6)
  })

  it('0・負・NaN は 0', () => {
    for (const v of [0, -100, NaN, Infinity]) {
      const m = pipMarginPx(v)
      expect(Number.isFinite(m), `${v} -> ${m}`).toBe(true)
      expect(m).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('safeFileBaseName — 利用者が付けた名前をファイル名にする', () => {
  it('ふつうの名前はそのまま', () => {
    expect(safeFileBaseName('わたしの動画')).toBe('わたしの動画')
  })

  it('パス区切りや使えない字を落とす', () => {
    const r = safeFileBaseName('a/b\\c:d*e?f"g<h>i|j')
    for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(r.includes(bad), `${bad} が残っている: ${r}`).toBe(false)
    }
  })

  it('空・空白だけなら既定の名前へ', () => {
    expect(safeFileBaseName('')).toBe(DEFAULT_PROJECT_NAME)
    expect(safeFileBaseName('   ')).toBe(DEFAULT_PROJECT_NAME)
  })

  it('【不変条件】結果は必ず空でなく、区切り文字を含まない', () => {
    const samples = ['', ' ', '.', '..', '/', 'あ'.repeat(500), 'con', 'a b', '..\\..\\x']
    for (const s of samples) {
      const r = safeFileBaseName(s)
      expect(r.length, JSON.stringify(s)).toBeGreaterThan(0)
      expect(r.includes('/')).toBe(false)
      expect(r.includes('\\')).toBe(false)
    }
  })
})

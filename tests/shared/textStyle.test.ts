import { describe, expect, it } from 'vitest'
import { defaultTextStyle, normalizeTextStyle } from '@shared/textStyle'
import { buildAssContent } from '@main/assSubtitle'
import type { TextOverlay } from '@shared/types'
import { NASTY_NUMBERS, NASTY_VALUES, seeded } from '../helpers/boundary'

const KEYS = Object.keys(defaultTextStyle()) as (keyof ReturnType<typeof defaultTextStyle>)[]

/** 「どの項目も undefined でない」——書き出しが読む項目が1つでも欠けると落ちる */
function everyFieldPresent(style: object): string[] {
  const rec = style as unknown as Record<string, unknown>
  return KEYS.filter((k) => rec[k] === undefined)
}

describe('normalizeTextStyle — 外から来た見た目を「全項目が揃った形」に直す', () => {
  it('ふつう: 指定した項目はそのまま残り、欠けた項目だけ既定で埋まる', () => {
    const s = normalizeTextStyle({ fontSize: 80, bold: true, position: 'top' })
    expect(s.fontSize).toBe(80)
    expect(s.bold).toBe(true)
    expect(s.position).toBe('top')
    // 埋まったぶん
    expect(s.color).toBe('#ffffff')
    expect(s.outlineColor).toBe('#000000')
    expect(everyFieldPresent(s)).toEqual([])
  })

  it('境界: 何を渡しても全項目が揃う', () => {
    for (const v of [...NASTY_VALUES, ...NASTY_NUMBERS]) {
      const s = normalizeTextStyle(v)
      expect(everyFieldPresent(s), `入力 ${String(v)}`).toEqual([])
    }
  })

  it('境界: 空のオブジェクトは既定値そのもの', () => {
    expect(normalizeTextStyle({})).toEqual(defaultTextStyle())
    expect(normalizeTextStyle(null)).toEqual(defaultTextStyle())
    expect(normalizeTextStyle([])).toEqual(defaultTextStyle())
  })

  it('境界: 使えない値は既定へ落とす(NaN・Infinity・型違い・知らない選択肢)', () => {
    const base = defaultTextStyle()
    const s = normalizeTextStyle({
      fontFamily: 'mincho', // 選択肢に無い
      fontSize: NaN,
      color: '', // 空文字は「色なし」と同じで ASS に書けない
      position: 'diagonal',
      rotation: Infinity,
      bold: 'yes',
      outlineWidth: -5,
      backgroundOpacity: '0.5',
      animation: 'explode',
      highlightColor: null
    })
    expect(s.fontFamily).toBe(base.fontFamily)
    expect(s.fontSize).toBe(base.fontSize)
    expect(s.color).toBe(base.color)
    expect(s.position).toBe(base.position)
    expect(s.rotation).toBe(base.rotation)
    expect(s.bold).toBe(base.bold)
    expect(s.outlineWidth).toBe(0) // 負は 0 まで(既定へ戻さず、下限で止める)
    expect(s.backgroundOpacity).toBe(base.backgroundOpacity)
    expect(s.animation).toBe(base.animation)
    expect(s.highlightColor).toBe(base.highlightColor)
  })

  it('知らない項目は落とさずに残す(将来増えた項目を読み込みで捨てない)', () => {
    const s = normalizeTextStyle({ 未来の項目: 42 }) as unknown as Record<string, unknown>
    expect(s['未来の項目']).toBe(42)
  })

  it('customPosition は x・y が両方そろっているときだけ通す', () => {
    expect(normalizeTextStyle({ customPosition: { x: 0.2, y: 0.8 } }).customPosition).toEqual({
      x: 0.2,
      y: 0.8
    })
    for (const bad of [{ x: 0.2 }, { y: 0.8 }, {}, null, 'a', [0.2, 0.8], { x: '1', y: 2 }]) {
      expect(normalizeTextStyle({ customPosition: bad }).customPosition, JSON.stringify(bad)).toBe(
        undefined
      )
    }
    // 数ではあるが有限でないものは 0.5(枠の中央)へ
    expect(normalizeTextStyle({ customPosition: { x: NaN, y: Infinity } }).customPosition).toEqual({
      x: 0.5,
      y: 0.5
    })
  })

  it('【不変条件】通したものをもう一度通しても変わらない(冪等)', () => {
    const rnd = seeded(20260913)
    const pool = [...NASTY_VALUES, ...NASTY_NUMBERS, 'top', 'center', 'bottom', 'fadeIn', '#123456']
    for (let i = 0; i < 3000; i++) {
      const raw: Record<string, unknown> = {}
      for (const k of KEYS) {
        if (rnd() < 0.5) raw[k] = pool[Math.floor(rnd() * pool.length)]
      }
      const once = normalizeTextStyle(raw)
      expect(normalizeTextStyle(once), JSON.stringify(raw)).toEqual(once)
      expect(everyFieldPresent(once), JSON.stringify(raw)).toEqual([])
    }
  })

  it('【不変条件】数の項目は必ず有限、選択肢の項目は必ず選択肢の中', () => {
    const rnd = seeded(777)
    const pool = [...NASTY_VALUES, ...NASTY_NUMBERS]
    for (let i = 0; i < 3000; i++) {
      const raw: Record<string, unknown> = {}
      for (const k of KEYS) raw[k] = pool[Math.floor(rnd() * pool.length)]
      const s = normalizeTextStyle(raw)
      for (const k of [
        'fontSize',
        'rotation',
        'outlineWidth',
        'backgroundOpacity',
        'letterSpacing'
      ] as const) {
        expect(Number.isFinite(s[k]), `${k}=${String(raw[k])}`).toBe(true)
      }
      expect(s.outlineWidth).toBeGreaterThanOrEqual(0)
      expect([
        'sans-serif',
        'serif',
        'M PLUS Rounded 1c',
        'Noto Sans JP',
        'Noto Serif JP'
      ]).toContain(s.fontFamily)
      expect(['top', 'center', 'bottom']).toContain(s.position)
      for (const k of ['color', 'outlineColor', 'backgroundColor', 'highlightColor'] as const) {
        expect(typeof s[k], k).toBe('string')
        expect(s[k].length, k).toBeGreaterThan(0)
      }
    }
  })
})

describe('【レグレッション】項目の欠けた見た目で書き出しが落ちない (2026-09-13)', () => {
  /**
   * `toAssColor(hex)` は `hex.replace('#','')` から始まる。`color` が `undefined` だと
   * **書き出しが生の英語で落ちる**(実測: 実際に ffmpeg を回して
   * 「Cannot read properties of undefined (reading 'replace')」。
   * `style: {}` でも、`color` だけ・`outlineColor` だけ落としても同じ)。
   * ここでは ffmpeg を起動せず、**ASS を組み立てる所**で同じことを確かめる。
   */
  const overlay = (style: unknown): TextOverlay =>
    ({ id: 'o1', text: 'テロップ', startTime: 0.5, endTime: 2.5, style, source: 'manual' }) as never

  it('直す前の形(生の style)は、いまも組み立てで落ちる——これが症状', () => {
    // 実測: どれも「Cannot read properties of undefined (reading 'replace')」
    for (const bad of [
      {},
      { fontSize: 80, bold: true, position: 'top' },
      { color: '#fff', outline: true }
    ]) {
      expect(() => buildAssContent([overlay(bad)], 640, 360), JSON.stringify(bad)).toThrow(
        /reading 'replace'/
      )
    }
  })

  it('落ちないほうがむしろ悪い: 欠けた項目が「undefined」の文字で焼かれる', () => {
    // `outline` が falsy だと縁取りの色を読まないので例外にならない。代わりに
    // 実測で `{\an5\fnundefined\fsundefined...}` がそのまま ASS に入る
    // ——**書き出しは成功し、出来上がった動画だけが崩れる**。
    const ass = buildAssContent([overlay({ color: '#ffffff' })], 640, 360)
    expect(ass).toContain('\\fnundefined')
    expect(ass).toContain('\\fsundefined')
    // 入口で通せば消える(対照)
    expect(
      buildAssContent([overlay(normalizeTextStyle({ color: '#ffffff' }))], 640, 360)
    ).not.toMatch(/undefined/)
  })

  it('入口で通してから渡せば落ちない(対照)', () => {
    for (const bad of [
      {},
      { fontSize: 80, bold: true, position: 'top' },
      { color: '#fff', outline: true }
    ]) {
      const ass = buildAssContent([overlay(normalizeTextStyle(bad))], 640, 360)
      expect(ass, JSON.stringify(bad)).toContain('テロップ')
      expect(ass).not.toMatch(/undefined/)
    }
  })

  it('【不変条件】どんな入力を通した見た目でも、ASS に undefined が焼かれない', () => {
    const rnd = seeded(31337)
    const pool = [...NASTY_VALUES, ...NASTY_NUMBERS, 'top', 'fadeIn', '#abcdef']
    for (let i = 0; i < 500; i++) {
      const raw: Record<string, unknown> = {}
      for (const k of KEYS) if (rnd() < 0.6) raw[k] = pool[Math.floor(rnd() * pool.length)]
      const ass = buildAssContent([overlay(normalizeTextStyle(raw))], 640, 360)
      expect(ass, JSON.stringify(raw)).not.toMatch(/undefined|NaN/)
    }
  })
})

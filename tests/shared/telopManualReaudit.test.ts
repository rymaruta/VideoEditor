import { describe, expect, it } from 'vitest'
import { utteranceToTelopChunks } from '../../src/shared/telop/fromTranscript'
import {
  autoTelopKey,
  mergeManualTelops,
  normalizeAutoSource,
  rememberEditedTelops
} from '../../src/shared/telop/manual'
import { defaultTextStyle } from '../../src/shared/textStyle'
import * as OM from '../lib/fixtures/telopc25f5af/manual'
import type { TextOverlay } from '../../src/shared/types'

const ws = [
  '今日は',
  'みんなで',
  'ラーメンを',
  '食べに',
  '横浜まで',
  '来ました',
  'すごく',
  '並んで',
  'ますね',
  '楽しみ',
  'です'
]
const u = {
  text: ws.join(''),
  words: ws.map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.5 })),
  sourceStart: 0,
  sourceEnd: 5.5
}
const style = defaultTextStyle()
type Auto = Omit<TextOverlay, 'id'> & { autoSource?: { start: number; end: number; text: string } }
const mk = (maxLineChars: number, withSource = true, offset = 0): Auto[] =>
  utteranceToTelopChunks(u, { maxLineChars }).map((c, i) => ({
    text: c.text,
    startTime: c.sourceStart + offset,
    endTime: c.sourceEnd + offset,
    style,
    source: 'auto' as const,
    utteranceId: 'u1',
    utteranceChunk: i,
    ...(withSource ? { autoSource: { start: c.sourceStart, end: c.sourceEnd, text: c.text } } : {})
  }))
const ids = (xs: Auto[]): TextOverlay[] =>
  xs.map((o, i) => ({ ...o, id: `o${i}` })) as TextOverlay[]
const flat = (s: string): string => s.replace(/\s/g, '')
const shown = (xs: readonly { text: string }[]): string => xs.map((m) => flat(m.text)).join('')

describe('人の修正の当て直し(第54回の見直し)', () => {
  it('前の版の鍵で直した枚を直し直すと、古い文字は作り直しで出ない(同じ発言が2回出ない)', () => {
    const old = ids(mk(14, false))
    old[1] = { ...old[1], text: old[1].text.replace('楽しみ', 'v1たのしみ'), edited: true }
    let remembered = rememberEditedTelops(old, undefined)
    const tl = ids(mergeManualTelops(old, mk(14), new Set(), remembered))
    remembered = rememberEditedTelops(tl, remembered)
    const i = tl.findIndex((o) => o.edited)
    tl[i] = { ...tl[i], text: tl[i].text.replace('v1たのしみ', 'v2たのしみ') }
    remembered = rememberEditedTelops(tl, remembered)
    // 前の版の鍵の修正は、直し直しても前の版と同じく何枚目かの鍵のまま覚える(第67回: 前の版の印のある発話は、
    // 何回作り直しても前の版と同じ当て方を続ける)。古い文字は残さない
    expect(Object.keys(remembered!)).toEqual(['u:u1#1'])
    expect(remembered!['u:u1#1'].text).toContain('v2')
    const merged = mergeManualTelops(tl, mk(8), new Set(), remembered)
    expect(shown(merged)).not.toContain('v1')
    expect(merged.filter((o) => o.text.includes('v2たのしみ'))).toHaveLength(1)
    // 前の版のまま作り直した結果と同じ
    expect(shown(merged)).toBe(shown(OM.mergeManualTelops(tl, mk(8), new Set(), remembered)))
    // すでに両方の鍵を覚えてしまった企画でも、古い方は当てない
    // (範囲つきの鍵で直し直した修正と、前の版の鍵の古い修正の両方)
    const fresh = mk(14)[1]
    const both = {
      [autoTelopKey(fresh)!]: { text: 'v2新しい', style, autoSource: fresh.autoSource },
      'u:u1#1': { text: 'v1古い', style }
    }
    expect(shown(mergeManualTelops([], mk(8), new Set(), both))).not.toContain('v1')
  })

  it('直してから消した枚は、枚の分け方が変わっても隣の枚に出てこない', () => {
    for (const [a, b] of [
      [14, 8],
      [8, 14],
      [6, 10]
    ]) {
      const first = ids(mk(a))
      for (let k = 0; k < first.length; k++) {
        const ex = first.map((o, i) => (i === k ? { ...o, text: 'EDITED', edited: true } : o))
        const rem = rememberEditedTelops(ex, undefined)
        const rest = ex.filter((_, i) => i !== k)
        const again = mergeManualTelops(
          rest,
          mk(b),
          new Set([autoTelopKey(ex[k])!]),
          rememberEditedTelops(rest, rem)
        )
        expect(again.some((m) => m.text === 'EDITED')).toBe(false)
      }
    }
  })

  it('当て直しで分かれた残りの枚を消すと、作り直しても足し直さない', () => {
    let checked = 0
    for (const [a, b] of [
      [14, 8],
      [10, 6],
      [6, 10],
      [12, 8]
    ]) {
      const first = ids(mk(a))
      for (let k = 0; k < first.length; k++) {
        const ex = first.map((o, i) => (i === k ? { ...o, text: 'X' + o.text, edited: true } : o))
        const rem = rememberEditedTelops(ex, undefined)
        const merged = ids(mergeManualTelops(ex, mk(b), new Set(), rem))
        const full = new Set(mk(b).map((x) => x.text))
        for (const victim of merged.filter((m) => !m.edited && !full.has(m.text))) {
          checked++
          const rest = merged.filter((m) => m !== victim)
          const again = mergeManualTelops(
            rest,
            mk(b),
            new Set([autoTelopKey(victim)!]),
            rememberEditedTelops(rest, rem)
          )
          expect(again.map((m) => flat(m.text))).not.toContain(flat(victim.text))
          // 直した枚は残る
          expect(again.filter((m) => m.edited).length).toBe(1)
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('前の版の修正は、頭を削った枚のあるショート(別のタイムライン)でも何枚目かで当たる', () => {
    const main = ids(mk(8, false, 100))
    main[2] = { ...main[2], text: '直した', edited: true }
    const short = mk(8, true, 0)
    short[0] = { ...short[0], text: short[0].text.slice(2) }
    const merged = mergeManualTelops(main, short, new Set(), rememberEditedTelops(main, undefined))
    expect(merged.filter((m) => m.text === '直した').length).toBe(1)
    expect(merged.find((m) => m.text === '直した')!.utteranceChunk).toBe(2)
  })

  it('読み込んだ元の部分が壊れていれば外す', () => {
    expect(normalizeAutoSource({ start: 1, end: 2, text: 'a' })).toEqual({
      start: 1,
      end: 2,
      text: 'a'
    })
    expect(normalizeAutoSource({ start: '1', end: 2, text: 'a' })).toBeUndefined()
    expect(normalizeAutoSource({ start: NaN, end: 2, text: 'a' })).toBeUndefined()
    expect(normalizeAutoSource({ start: 1, end: 2 })).toBeUndefined()
    expect(normalizeAutoSource('x')).toBeUndefined()
  })
})

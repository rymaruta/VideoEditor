import { describe, expect, it } from 'vitest'
import { wrapTelopLines } from '../../src/shared/telop/fromTranscript'
import { balancedLineEnds, breakScore, lineBreakScore } from '../../src/shared/telop/polish'
import * as F from './fixtures/polishF02d6be'
import { LINE_BREAK_CORPUS, parseCorpus } from './fixtures/lineBreakCorpus'
import { REAL_TELOP_TEXTS } from './fixtures/realTelopTexts'

/**
 * テロップの改行(行の中の改行の位置)は、push 済みの f02d6be と完全に同じ。手作りの規則での改行の直し
 * (語の途中を避ける規則・1字のはみ出し)は、f02d6be より悪くなる例が残ったので打ち切り、f02d6be の挙動に
 * 戻した(最終監査)。改行の改善は後で別のやり方(形態素解析・BudouX など)で行う。
 * 文の集まり(正解付きの文集 70 文)と、試し編集 第2回・第3回の実文 244 文の全部を、幅 8〜24 字で比べる
 */
const TEXTS = [...LINE_BREAK_CORPUS.map((l) => parseCorpus(l).text), ...REAL_TELOP_TEXTS]

describe('テロップの改行は f02d6be と完全に同じ', () => {
  it('文は 300 文以上', () => {
    expect(TEXTS.length).toBeGreaterThanOrEqual(300)
  })

  for (let max = 8; max <= 24; max++)
    it(`1行 ${max} 字: 改行・行の区切り・区切りの良さが一致する`, () => {
      const diff: string[] = []
      for (const text of TEXTS) {
        const a = wrapTelopLines(text, max)
        const b = F.wrapTelopLines(text, max)
        if (a.join('/') !== b.join('/')) diff.push(`${b.join('/')} → ${a.join('/')}`)
        const chars = [...text]
        for (const phrases of [false, true])
          expect(balancedLineEnds(chars, max, undefined, phrases), text).toEqual(
            F.balancedLineEnds(chars, max, undefined, phrases)
          )
      }
      expect(diff).toEqual([])
    })

  it('区切りの良さ(breakScore・lineBreakScore)も、どの位置でも一致する', () => {
    for (const text of TEXTS) {
      const chars = [...text]
      for (let k = 0; k <= chars.length; k++) {
        expect(breakScore(chars, k), `${text} ${k}`).toBe(F.breakScore(chars, k))
        expect(lineBreakScore(chars, k), `${text} ${k}`).toBe(F.lineBreakScore(chars, k))
      }
    }
  })
})

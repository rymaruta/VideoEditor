import { describe, expect, it } from 'vitest'
import { wrapTelopLines } from '../../src/shared/telop/fromTranscript'
import { balancedLineEnds as balancedD110078 } from './fixtures/polishD110078'
import { LINE_BREAK_CORPUS, parseCorpus } from './fixtures/lineBreakCorpus'
import { lineOverflowFits } from '../../src/shared/telop/stack'
import { defaultTextStyle } from '../../src/shared/textStyle'

/**
 * テロップの改行で「語の途中で切る」数が、文節の見当を入れる前(d110078)の改行より1つも増えない
 * (見直しの指摘: 文末の見当で「雨が降った / ら」「どういうことなんだ / ろうと」「知らない / けど」と切る例が出た)。
 * 「語の途中」かどうかは、文の集まり(`LINE_BREAK_CORPUS`)に手で付けた切れ目で決める
 */

/** 改行の位置(文字の位置)。行の頭・終わりの空白は落とすので、残った行の長さから決める */
function breaksOf(lines: readonly string[]): number[] {
  const out: number[] = []
  let at = 0
  for (const l of lines.slice(0, -1)) {
    at += [...l].length
    out.push(at)
  }
  return out
}

function oldLines(text: string, max: number): string[] {
  const chars = [...text]
  let from = 0
  return balancedD110078(chars, max)
    .map((end) => {
      const l = chars.slice(from, end).join('').trim()
      from = end
      return l
    })
    .filter((l) => l.length > 0)
}

/** 語の途中の改行の重さ: 付属語(助詞・助動詞)の前は 1、語の中は 2 */
function severity(text: string, at: number): number {
  const rest = [...text].slice(at).join('')
  return /^(?:と|が|を|に|で|は|も|の|へ|や|から|まで|より|けど|けれど|ので|のに|って|よ|ね|ぐらい|くらい|だけ|など)/u.test(
    rest
  )
    ? 1
    : 2
}

const midWord = (breaks: readonly number[], allowed: ReadonlySet<number>): number[] =>
  breaks.filter((b) => !allowed.has(b))

describe('テロップの改行: 語の途中で切る数が前より増えない', () => {
  it('文の集まりは 60 文以上', () => {
    expect(LINE_BREAK_CORPUS.length).toBeGreaterThanOrEqual(60)
  })

  for (const max of [10, 12, 14, 16, 18, 20])
    it(`1行 ${max} 字`, () => {
      const worse: string[] = []
      let oldTotal = 0
      let newTotal = 0
      for (const line of LINE_BREAK_CORPUS) {
        const { text, allowed } = parseCorpus(line)
        const before = oldLines(text, max)
        const after = wrapTelopLines(text, max)
        expect(after.join('')).toBe(text)
        const oldMid = midWord(breaksOf(before), allowed)
        const newMid = midWord(breaksOf(after), allowed)
        const a = oldMid.length
        const b = newMid.length
        oldTotal += a
        newTotal += b
        // 数が増えたら悪化。重さ(付属語の前は 1・語の中は 2)の合計が増えても悪化。数も重さも同じなら、
        // 前の版に無かった語の中の改行が入ったら悪化(「お / 聞きする」を「お聞 / きする」、「おせんべい / の」を
        // 「焼 / いた」に替えるのは、数が同じでも読みにくくなる)
        const weight = (ps: number[]): number => ps.reduce((t, p) => t + severity(text, p), 0)
        const wa = weight(oldMid)
        const wb = weight(newMid)
        if (
          b > a ||
          wb > wa ||
          (b === a &&
            wb === wa &&
            newMid.some((x) => !oldMid.includes(x) && severity(text, x) === 2))
        )
          worse.push(`${before.join('/')} → ${after.join('/')}`)
      }
      expect(worse).toEqual([])
      expect(newTotal).toBeLessThanOrEqual(oldTotal)
    })

  it('試し編集 第3回で語の途中に入った改行が直る(1行 14 字)', () => {
    const cases: [string, string][] = [
      ['単にそういう科学的なものだけではなくてですね', '科学/的'],
      ['いかに増やしていくかということをこの', '増や/して'],
      ['最終的につながりにもつながっていったと思うんですが', 'つな/がって'],
      ['そういう価格転換の指針みたいなものを発表はされている', 'みたい/な']
    ]
    for (const [text, bad] of cases) {
      // 1字はみ出してよい(描画の枠に収まる)とき
      const lines = wrapTelopLines(text, 14, true)
      expect(lines.join('')).toBe(text)
      expect(lines.join('/')).not.toContain(bad)
      // 1行は 14 字(はみ出しても1字)まで・2行まで
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const l of lines) expect([...l].length).toBeLessThanOrEqual(15)
      // 文節の切れ目で切る
      const { allowed } = parseCorpus(
        LINE_BREAK_CORPUS.find((c) => c.replaceAll('|', '') === text)!
      )
      expect(midWord(breaksOf(lines), allowed)).toEqual([])
    }
  })

  it('1字はみ出すのは、描画の枠に収まると確かめたときだけ(監査の指摘 5)', () => {
    const text = '最終的につながりにもつながっていったと思うんですが'
    // 確かめていなければはみ出さない(1行は 14 字まで)
    for (const l of wrapTelopLines(text, 14)) expect([...l].length).toBeLessThanOrEqual(14)
    expect(wrapTelopLines(text, 14, true)).toEqual([
      '最終的につながりにも',
      'つながっていったと思うんですが'
    ])
    // 枠: 9:16 は幅 972px と Shorts の右のボタンの列(真ん中揃えで 831px)。15 字 × 54px は収まり、
    // 15 字 × 64px(960px)は 972px には収まるが右の列に掛かる
    const style = { ...defaultTextStyle(), outline: false }
    expect(lineOverflowFits({ ...style, fontSize: 54 }, '9:16', 14)).toBe(true)
    expect(lineOverflowFits({ ...style, fontSize: 64 }, '9:16', 14)).toBe(false)
    expect(lineOverflowFits({ ...style, fontSize: 64 }, '16:9', 14)).toBe(true)
    expect(lineOverflowFits({ ...style, fontSize: 64, vertical: true }, '16:9', 14)).toBe(false)
  })

  it('改善した例は保つ(文の終わりで切る)', () => {
    expect(wrapTelopLines('ありがとうございましたそれでは次に', 14)).toEqual([
      'ありがとうございました',
      'それでは次に'
    ])
    expect(wrapTelopLines('ちゃんとできていますかそれでは続けます', 14)).toEqual([
      'ちゃんとできていますか',
      'それでは続けます'
    ])
  })
})

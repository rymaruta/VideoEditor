import { describe, expect, it } from 'vitest'
import {
  applyDictionary,
  breakScore,
  parseDictionary,
  removeFillers
} from '../../src/shared/telop/polish'
import { utteranceToTelopChunks, wrapTelopLines } from '../../src/shared/telop/fromTranscript'

describe('removeFillers', () => {
  it('発言の頭や区切りの後の言いよどみを除く', () => {
    expect(removeFillers('えー、それでですね')).toBe('それでですね')
    expect(removeFillers('えっと あのー 坂がきつい')).toBe('坂がきつい')
    expect(removeFillers('ここは、あのー、景色がいい')).toBe('ここは、景色がいい')
    expect(removeFillers('まあ、行ってみましょう')).toBe('行ってみましょう')
  })

  it('意味のある言葉は残す', () => {
    expect(removeFillers('あの人が来た')).toBe('あの人が来た')
    expect(removeFillers('まあまあ美味しい')).toBe('まあまあ美味しい')
    expect(removeFillers('えーマジで')).toBe('えーマジで')
  })
})

describe('applyDictionary / parseDictionary', () => {
  it('登録した置き換えを、長いものから当てる', () => {
    const dict = parseDictionary('# 聞き違い\n定選 → 停戦\n基礎川=>木曽川\n浄土\t浄土ヶ浜\n\n')
    expect(dict).toEqual([
      { from: '定選', to: '停戦' },
      { from: '基礎川', to: '木曽川' },
      { from: '浄土', to: '浄土ヶ浜' }
    ])
    expect(applyDictionary('木曜日、定選会談', dict)).toBe('木曜日、停戦会談')
    expect(
      applyDictionary('あいうえお', [
        { from: 'い', to: 'X' },
        { from: 'いう', to: 'Y' }
      ])
    ).toBe('あYえお')
  })
})

describe('改行の禁則', () => {
  it('句読点・小さい仮名・長音を行頭に置かない', () => {
    const lines = wrapTelopLines('ちょっと休憩しませんかって言ったじゃないですか', 7)
    for (const l of lines.slice(1)) expect(/^[、。っゃゅょー]/u.test(l)).toBe(false)
  })

  it('助詞の後で区切りやすい', () => {
    expect(breakScore([...'坂がきつい'], 2)).toBe(2)
    expect(breakScore([...'坂がきつい'], 1)).toBe(0)
    // 「ちょ|っと」: 小さい「っ」を行頭に置かない
    expect(breakScore([...'ちょっと'], 2)).toBe(-Infinity)
  })

  it('禁則の文字が続いても、1行が上限を1文字より多く超えない(はみ出さない)', () => {
    for (const text of ['すごーーーーーーーーーーーーーーーーーい', 'あ…………………………………………………………']) {
      const lines = wrapTelopLines(text, 14)
      expect(lines.join('')).toBe(text)
      for (const l of lines) expect([...l].length).toBeLessThanOrEqual(15)
    }
  })
})

describe('utteranceToTelopChunks と整え', () => {
  it('言いよどみを除き、辞書で直してからテロップにする', () => {
    const [c] = utteranceToTelopChunks(
      {
        text: '',
        words: [
          { text: 'えー、', start: 0, end: 0.5 },
          { text: '定選会談は終了しました。', start: 0.5, end: 2.5 }
        ],
        sourceStart: 0,
        sourceEnd: 2.5
      },
      { dictionary: [{ from: '定選', to: '停戦' }] }
    )
    expect(c.text).toBe('停戦会談は終了しました')
  })
})

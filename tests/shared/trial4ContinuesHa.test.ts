import { describe, expect, it } from 'vitest'
import { continuesSentence } from '../../src/shared/structure/scenes'

/**
 * 第4回の直し(N4)の監査の指摘 6: 「は」で終わる発話を続きのある形とみなす範囲に、挨拶(「今日は」
 * 「こんちは」「本日は」)と言いさしの質問(「お名前は」「ご出身は」)が入っていた
 */
describe('「は」で終わる発話', () => {
  it('挨拶・言いさしの質問は続きのある形にしない', () => {
    for (const t of [
      'こんにちは',
      'こんちは',
      'こんばんは',
      '今日は',
      '本日は',
      'お名前は',
      'ご出身は',
      'ご感想は',
      '年齢は',
      'では、お名前は'
    ])
      expect(continuesSentence(t), t).toBe(false)
  })

  it('話の続く「は」は続きのある形のまま', () => {
    for (const t of [
      'あとやはり我々は',
      '実は千崎社長の日立健貴さんは',
      '私は',
      'このあたりのお話は',
      '先ほどの点については',
      'それでは'
    ])
      expect(continuesSentence(t), t).toBe(true)
  })
})

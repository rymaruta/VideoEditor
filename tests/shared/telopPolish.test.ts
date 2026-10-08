import { describe, expect, it } from 'vitest'
import {
  applyDictionary,
  breakScore,
  INSIDE_WORD_SCORE,
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

  it('単語の途中で改行しない(実写の素材で起きていた「と / ころ」「で / すね」「200 / 0円」)', () => {
    const cases = [
      '大学の近くにこういう面白いところがあったから寄らせてもらいました',
      '中華街のお食事でよくあるパターンはですね私も横浜国大入学',
      '素晴らしい中華料理まあ2000円くらい出せばお腹いっぱいね',
      '渡っている頭いい利口なカラスの様子を皆さんにお届けする'
    ]
    const seg = new Intl.Segmenter('ja', { granularity: 'word' })
    for (const text of cases) {
      const lines = wrapTelopLines(text, 14)
      expect(lines.join('')).toBe(text)
      let at = 0
      for (const l of lines.slice(0, -1)) {
        at += l.length
        const starts = new Set([...seg.segment(text)].map((s) => s.index))
        expect(starts.has(at), `${lines.join(' / ')}`).toBe(true)
      }
    }
    // 単語の途中は、ほかに区切れる所が無いときだけ
    expect(breakScore([...'ところ'], 1)).toBe(INSIDE_WORD_SCORE)
  })

  it('単語の途中しか区切れない長い語も、上限で区切る(はみ出さない)', () => {
    const text = 'アンチディスエスタブリッシュメンタリアニズム'
    const lines = wrapTelopLines(text, 14)
    expect(lines.join('')).toBe(text)
    for (const l of lines) expect([...l].length).toBeLessThanOrEqual(15)
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

describe('辞書で長くなった発言テロップ', () => {
  it('辞書で文字が増えても、1枚は2行まで(収まらない分は次の枚にし、時間を割り振る)', () => {
    const text = 'AIがAIでAIをAIにしてAIとAIのAIだよね'
    const chunks = utteranceToTelopChunks(
      { text, words: [{ text, start: 0, end: 5 }], sourceStart: 0, sourceEnd: 5 },
      { dictionary: [{ from: 'AI', to: '人工知能' }] }
    )
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.split('\n').length, c.text).toBeLessThanOrEqual(2)
    expect(chunks.map((c) => c.text.replace(/\n/g, '')).join('')).toBe(
      text.replace(/AI/g, '人工知能')
    )
    for (let k = 0; k + 1 < chunks.length; k++)
      expect(chunks[k].sourceEnd).toBeLessThanOrEqual(chunks[k + 1].sourceStart + 1e-9)
    expect(chunks[0].sourceStart).toBeGreaterThanOrEqual(0)
    expect(chunks.at(-1)!.sourceEnd).toBeLessThanOrEqual(5 + 1e-9)
  })
})

describe('辞書の置き換えは1回だけ', () => {
  const d = (...pairs: [string, string][]): { from: string; to: string }[] =>
    pairs.map(([from, to]) => ({ from, to }))
  it('置き換えた結果を、後の置き換えでまた書き換えない', () => {
    expect(applyDictionary('AB', d(['A', 'B'], ['B', 'A']))).toBe('BA')
    expect(applyDictionary('きむらさん', d(['きむら', '木村'], ['木', '樹']))).toBe('木村さん')
    expect(applyDictionary('ジョウドガハマに来た', d(['ジョウド', 'ジョウドガハマ']))).toBe(
      'ジョウドガハマに来た'
    )
    expect(applyDictionary('ジョウドに来た', d(['ジョウド', 'ジョウドガハマ']))).toBe(
      'ジョウドガハマに来た'
    )
    expect(applyDictionary('abc', d(['abc', 'abc'], ['b', 'X']))).toBe('abc')
    expect(applyDictionary('a.b(c)', d(['.', '・'], ['(c)', '[c]']))).toBe('a・b[c]')
  })
})

describe('辞書で直す言葉をテロップの枚の境目で切らない', () => {
  it('長い発言でも、辞書の言葉は1枚の中に入って直る', () => {
    const chunks = utteranceToTelopChunks(
      {
        text: '今日は朝から天気が良かったので家族みんなでよこはまこくだいに来ています。すごくきれいなところです',
        words: [],
        sourceStart: 0,
        sourceEnd: 20
      },
      { dictionary: [{ from: 'よこはまこくだい', to: '横浜国大' }] }
    )
    expect(chunks.map((c) => c.text.replace(/\n/g, '')).join('')).toContain('横浜国大')
  })
})

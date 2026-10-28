import { describe, expect, it } from 'vitest'
import { utteranceToTelopChunks, wrapTelopLines } from '../../src/shared/telop/fromTranscript'
import { breakScore } from '../../src/shared/telop/polish'
import { joinSplitNumbers, type TranscriptUtterance } from '../../src/shared/transcript'
import { recordingDuration } from '../../src/shared/ingest/classify'

/** 試し編集 第2回(首相官邸の車座対話・マイク1本)で見つかったテロップの文字の不具合 */
describe('テロップの改行を語の途中に入れない(不具合 5)', () => {
  const lines = (text: string): string[] => wrapTelopLines(text, 14)

  it('「会長の思い / 切った」と複合語の途中で切らない', () => {
    const got = lines('そのあたり会長の思い切った決断について')
    expect(got.join('/')).not.toContain('思い/切')
    expect(got).toEqual(['そのあたり会長の', '思い切った決断について'])
  })

  it('「お聞かせいただ / きたい」と活用の途中で切らない', () => {
    const got = lines('ぜひお聞かせいただきたいなと思います')
    expect(got.join('/')).not.toMatch(/いただ\/き|お\/聞/)
    expect(got.every((l) => [...l].length <= 14)).toBe(true)
  })

  it('助詞・「する」の活用の前(「経済 / にとって」「いらっしゃっ / た」)で切らない', () => {
    expect(lines('日本の経済にとって大事なことだと').join('/')).not.toContain('経済/に')
    expect(lines('皆様がいらっしゃったということで')).toEqual([
      '皆様が',
      'いらっしゃったということで'
    ])
    expect(lines('そういう価格転換の指針みたいなものを').join('/')).not.toContain('みたい/な')
  })
})

describe('数字と「%」を分けない(不具合 6)', () => {
  it('数字の後ろの「%」の前では、改行も枚の境目も入れない', () => {
    expect(breakScore([...'約4%弱'], 2)).toBe(-Infinity)
    expect(breakScore([...'2000円'], 2)).toBe(-Infinity)
    const chunks = utteranceToTelopChunks({
      text: '平均すると約4%弱ぐらいの賃上げをさせていただきましたし',
      words: [],
      sourceStart: 0,
      sourceEnd: 5
    })
    for (const c of chunks) expect(c.text).not.toMatch(/[0-9]$|^%/m)
  })

  const utt = (
    id: string,
    text: string,
    sourceStart: number,
    sourceEnd: number,
    extra: Partial<TranscriptUtterance> = {}
  ): TranscriptUtterance => ({
    id,
    assetId: 'M',
    speaker: 'マイク1',
    sourceStart,
    sourceEnd,
    text,
    words: [{ text, start: sourceStart, end: sourceEnd }],
    overlap: false,
    ...extra
  })

  it('「、約4」と「%弱ぐらいの賃上げを」に分かれた発話を1つにつなぐ', () => {
    const got = joinSplitNumbers([
      utt('a', 'それで昨年は', 258, 261.5),
      utt('b', '、約4', 261.94, 263.74),
      utt('c', '%弱ぐらいの賃上げをさせていただきましたし、', 264.1, 268),
      utt('d', 'はい', 270, 270.5)
    ])
    expect(got.map((u) => u.text)).toEqual([
      'それで昨年は',
      '、約4%弱ぐらいの賃上げをさせていただきましたし、',
      'はい'
    ])
    const joined = got[1]
    expect(joined.id).toBe('b')
    expect(joined.sourceStart).toBe(261.94)
    expect(joined.sourceEnd).toBe(268)
    expect(joined.words).toHaveLength(2)
  })

  it('間が長い・別の素材・数字で終わらないものはつながない', () => {
    const list = [
      utt('a', '約4', 10, 11),
      utt('b', '%です', 14, 15),
      utt('c', '約5', 20, 21),
      utt('d', '%です', 21.2, 22, { assetId: 'N' }),
      utt('e', '約', 30, 31),
      utt('f', '%です', 31.1, 32)
    ]
    expect(joinSplitNumbers(list).map((u) => u.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })
})

describe('新しい回を作るの「収録の長さ」(不具合 10)', () => {
  it('同じ時間を録ったカメラとマイクを足さない', () => {
    const src = (d: number, track = false): { files: never[] } => ({
      files: [{ duration: d, ...(track ? { track: { role: 'mic' } } : {}) }] as never[]
    })
    expect(recordingDuration([src(660), src(660)])).toBe(660)
    expect(recordingDuration([src(600), src(660), src(660, true)])).toBe(660)
    expect(recordingDuration([])).toBe(0)
  })
})

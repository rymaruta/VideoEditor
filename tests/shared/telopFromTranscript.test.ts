import { describe, expect, it } from 'vitest'
import {
  FIRST_TELOP_DELAY_SEC,
  settleTelopTimes,
  tidyTelopText,
  utteranceToTelopChunks,
  wrapTelopLines
} from '../../src/shared/telop/fromTranscript'
import { utteranceTimelineRange, isLikelyHallucination } from '../../src/shared/transcript'

describe('tidyTelopText', () => {
  it('文末の句点を落とし、読点は空白にする(言葉は変えない)', () => {
    expect(tidyTelopText('木曜日、停戦会談は終了しました。')).toBe('木曜日 停戦会談は終了しました')
    expect(tidyTelopText('えっ？ヤバイですよね!')).toBe('えっ？ヤバイですよね!')
  })
})

describe('wrapTelopLines', () => {
  it('行の後ろ半分に句読点があれば、その後で改行する', () => {
    expect(wrapTelopLines('あいうえおかきくけこ、さしすせそ', 14)).toEqual([
      'あいうえおかきくけこ、',
      'さしすせそ'
    ])
  })

  it('行の長さを揃え、その近くの良い区切り(助詞の後)で改行する', () => {
    expect(wrapTelopLines('木曜日、停戦会談は何の進展もないまま終了', 14)).toEqual([
      '木曜日、停戦会談は何の',
      '進展もないまま終了'
    ])
  })

  it('長い発話の最後の1枚が数文字だけにならず、どの1枚も2行に収まる(1行18字でも)', () => {
    const text = '森永の美味しい牛乳は濃い青色に牛乳瓶をあしらったデザインのパック牛乳である'
    for (const maxLineChars of [14, 18]) {
      const chunks = utteranceToTelopChunks(
        { text, words: [{ text, start: 0, end: 5 }], sourceStart: 0, sourceEnd: 5 },
        { maxLineChars }
      )
      for (const c of chunks) {
        const lines = c.text.split('\n')
        expect(lines.length).toBeLessThanOrEqual(2)
        for (const l of lines) expect([...l].length).toBeLessThanOrEqual(maxLineChars)
        expect([...c.text.replace(/\s/g, '')].length).toBeGreaterThan(6)
      }
      expect(chunks.map((c) => c.text.replace(/\n/g, '')).join('')).toBe(text)
    }
  })
})

describe('utteranceToTelopChunks', () => {
  it('長い発話は2行×14文字に収まるよう分け、時刻は言葉の時刻から取る', () => {
    const words = [
      { text: '木曜日、', start: 10, end: 10.8 },
      { text: '停戦会談は何の進展もないまま終了しました。', start: 10.8, end: 14 },
      { text: 'そして次の会談の日程も決まらないまま、関係者は帰国しました。', start: 14.5, end: 19 }
    ]
    const chunks = utteranceToTelopChunks({ text: '', words, sourceStart: 10, sourceEnd: 19 })
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    for (const c of chunks) {
      const lines = c.text.split('\n')
      expect(lines.length).toBeLessThanOrEqual(2)
      expect(lines.every((l) => [...l].length <= 14)).toBe(true)
    }
    expect(chunks[0].sourceStart).toBe(10)
    expect(chunks.at(-1)!.sourceEnd).toBeCloseTo(19, 5)
    // 言葉は落とさない(句読点と空白を除いて元と同じ)
    const strip = (s: string): string => s.replace(/[\s、。\n]/g, '')
    expect(strip(chunks.map((c) => c.text).join(''))).toBe(strip(words.map((w) => w.text).join('')))
  })

  it('英数字の言葉の間は空け、言葉の途中で改行しない', () => {
    const words = ['Hello', 'world', 'iPhone', '15'].map((text, i) => ({
      text,
      start: i * 0.5,
      end: i * 0.5 + 0.5
    }))
    const [c] = utteranceToTelopChunks({
      text: 'Hello world iPhone 15',
      words,
      sourceStart: 0,
      sourceEnd: 2
    })
    expect(c.text).toBe('Hello world\niPhone 15')
  })

  it('言葉の時刻が無ければ、発話の時間を文字数で割り振る(どの枚も長さがある)', () => {
    const text = 'きょうはとてもいい天気ですね、みんなで浄土ヶ浜に行ってパック牛乳を飲みました'
    const chunks = utteranceToTelopChunks({ text, words: [], sourceStart: 0, sourceEnd: 10 })
    expect(chunks.length).toBe(2)
    for (const c of chunks) expect(c.sourceEnd - c.sourceStart).toBeGreaterThan(3)
    expect(chunks[0].sourceEnd).toBeCloseTo(chunks[1].sourceStart, 5)
  })

  it('頭の言いよどみのあいだは、次の言葉を出さない', () => {
    const text = 'えーと、今日は天気がとても良いですね'
    const words = [...text].map((ch, i) => ({ text: ch, start: i, end: i + 1 }))
    const [c] = utteranceToTelopChunks(
      { text, words, sourceStart: 0, sourceEnd: words.length },
      { maxLineChars: 8, maxLines: 1 }
    )
    expect(c.text.startsWith('今日は')).toBe(true)
    expect(c.sourceStart).toBe(4)
  })

  it('最初の1枚は、言葉の時刻が遅れていても発話の頭(声の少し前)から出す', () => {
    // 発話の区間(声の検出)は 24.73 秒から、音声認識の言葉の時刻は 25.17 秒から(実際の回で見た値)
    const [c] = utteranceToTelopChunks({
      text: '私は松井さんが書いた作文を読みました',
      words: [{ text: '私は松井さんが書いた作文を読みました', start: 25.17, end: 28.43 }],
      sourceStart: 24.73,
      sourceEnd: 27.72
    })
    expect(c.sourceStart).toBeCloseTo(24.73 + FIRST_TELOP_DELAY_SEC, 9)
    // 言葉の時刻のほうが早ければ、そちら(遅らせない)
    const [d] = utteranceToTelopChunks({
      text: 'こんにちは',
      words: [{ text: 'こんにちは', start: 3.02, end: 4 }],
      sourceStart: 3,
      sourceEnd: 4
    })
    expect(d.sourceStart).toBe(3.02)
  })

  it('2枚目からは言葉の時刻のまま(言った時に替わる)', () => {
    const words = [
      { text: '木曜日、', start: 10.5, end: 11 },
      { text: '停戦会談は何の進展もないまま終了しました。', start: 11, end: 14 },
      { text: 'そして次の会談の日程も決まらないまま、関係者は帰国しました。', start: 14.5, end: 19 }
    ]
    const chunks = utteranceToTelopChunks({ text: '', words, sourceStart: 10, sourceEnd: 19 })
    expect(chunks[0].sourceStart).toBeCloseTo(10 + FIRST_TELOP_DELAY_SEC, 9)
    expect(chunks[1].sourceStart).toBeGreaterThan(11)
  })

  it('短い発話でも最低 1 秒は出す', () => {
    const [c] = utteranceToTelopChunks({
      text: 'えっ',
      words: [{ text: 'えっ', start: 5, end: 5.3 }],
      sourceStart: 5,
      sourceEnd: 5.3
    })
    expect(c.sourceEnd - c.sourceStart).toBeCloseTo(1, 5)
  })
})

describe('utteranceTimelineRange', () => {
  it('その素材を使っているクリップから、タイムラインの位置を割り出す', () => {
    const clips = [
      { assetId: 'M', startTime: 0, inPoint: 10, outPoint: 310 },
      { assetId: 'M', startTime: 300, inPoint: 400, outPoint: 700, speed: 1.0001 }
    ]
    expect(utteranceTimelineRange({ assetId: 'M', sourceStart: 20, sourceEnd: 22 }, clips)).toEqual(
      {
        start: 10,
        end: 12
      }
    )
    const r = utteranceTimelineRange({ assetId: 'M', sourceStart: 500, sourceEnd: 501 }, clips)!
    expect(r.start).toBeCloseTo(300 + 100 / 1.0001, 9)
    // カットで落とした部分(310〜400)の発話は出さない
    expect(
      utteranceTimelineRange({ assetId: 'M', sourceStart: 350, sourceEnd: 351 }, clips)
    ).toBeNull()
  })
})

describe('isLikelyHallucination', () => {
  it('無音で出がちな決まり文句を見分ける', () => {
    expect(isLikelyHallucination('ご視聴ありがとうございました')).toBe(true)
    expect(isLikelyHallucination('ありがとうございました')).toBe(false)
  })
})

describe('settleTelopTimes — タイムラインに置いたテロップの時刻を整える', () => {
  const t = (
    text: string,
    startTime: number,
    endTime: number
  ): {
    text: string
    startTime: number
    endTime: number
  } => ({ text, startTime, endTime })

  it('0.3 秒以下の切れ目は、前のテロップを次の頭まで延ばしてつなぐ(点滅させない)', () => {
    const out = settleTelopTimes([t('こんにちは', 0, 2), t('どうも', 2.2, 4), t('はい', 5, 6)], [])
    expect(out.map((x) => [x.startTime, x.endTime])).toEqual([
      [0, 2.2],
      [2.2, 4],
      [5, 6]
    ])
  })

  it('カットの切れ目はまたがない。切れ目の直後に出るテロップは切れ目から出す', () => {
    // 10 秒で時間が飛ぶ。前のテロップは 10 秒で切れ、次は切れ目の 0.07 秒後に出ていた
    const out = settleTelopTimes([t('こんにちは', 8, 10), t('どうも', 10.07, 12)], [10])
    expect(out.map((x) => [x.startTime, x.endTime])).toEqual([
      [8, 10],
      [10, 12]
    ])
    // 切れ目の 0.3 秒より後なら、そのまま
    const late = settleTelopTimes([t('こんにちは', 8, 9.5), t('どうも', 10.5, 12)], [10])
    expect(late.map((x) => [x.startTime, x.endTime])).toEqual([
      [8, 9.5],
      [10.5, 12]
    ])
  })

  it('文字数に対して短い枚は、次のテロップ・カットの切れ目までの範囲で延ばす(1秒10文字)', () => {
    const text = 'どうもありがとうございました' // 14 文字 → 1.4 秒
    const [a] = settleTelopTimes([t(text, 0, 1.08)], [])
    expect(a.endTime).toBeCloseTo(1.4, 5)
    const [b] = settleTelopTimes([t(text, 0, 1.08), t('はい', 1.2, 2)], [])
    expect(b.endTime).toBeCloseTo(1.2, 9)
    const [c] = settleTelopTimes([t(text, 0, 1.08)], [1.1])
    expect(c.endTime).toBeCloseTo(1.1, 9)
  })

  it('声が重なって同時に出ているテロップは延ばさない', () => {
    const out = settleTelopTimes([t('ええ', 0, 0.3), t('ほんとに', 0.1, 2)], [])
    expect(out[0].endTime).toBe(0.3)
  })
})

describe('音声認識の繰り返しの暴走', () => {
  it('同じ短い言葉が 8 回以上続いて発話の大半を占めたら捨てる。人の言う繰り返しは残す', () => {
    for (const t of [
      'ヴィヴィヴィヴィヴィヴィヴィヴィヴィヴィヴィヴィ',
      '彼女彼女彼女彼女彼女彼女彼女彼女彼女彼女',
      '私は 私は 私は 私は 私は 私は 私は 私は 私は 私は 私は',
      'お客様に行くと お客様に行くと お客様に行くと お客様に行くと お客様に行くと お客様に行くと お客様に行くと お客様に行くと'
    ])
      expect(isLikelyHallucination(t), t).toBe(true)
    for (const t of [
      'やばいやばいやばい!',
      'ははははは、すごい',
      'えーっと、あのー、ここのラーメンがすごくおいしくて',
      'ーーーうまい',
      'うわあああああああああ!',
      'きゃーーーーーーーーー!',
      'はははははははははははははははははははは',
      'あはははははははは',
      'えーーーーーーーーっ!',
      'おいしいいいいいいいい!',
      'いけいけいけいけいけいけいけいけ!',
      'ラッシュ ラッシュ ラッシュ ラッシュ ラッシュ ラッシュ ラッシュ ラッシュ',
      'ドドドドドドドドド'
    ])
      expect(isLikelyHallucination(t), t).toBe(false)
  })
})

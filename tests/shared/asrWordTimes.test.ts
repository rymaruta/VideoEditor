import { describe, expect, it } from 'vitest'
import {
  asrGroupResults,
  groupAsrJobs,
  markSegmentStarts,
  type AsrRawChunk
} from '../../src/shared/diarize/groupJobs'

/**
 * 実地テスト(英語 10 分・日本語 43 分)で見つかった、音声認識の結果の扱いの不具合。
 * モデルは動かさず、transformers.js の返す形をまねた入力で試す。
 */

const chunk = (text: string, s: number, e: number | null): AsrRawChunk => ({
  text,
  timestamp: [s, e]
})

describe('言葉の時刻: 窓の境目で終わりが始まりより前にならない', () => {
  // 実例: 発話 119.76〜120.42 を含む窓(105.17〜120.42)。最後の片の時刻が [29.82, 0]
  // (音の終わりより後ろ=無音で埋めた所の作り話・終わりは終わりの印の 0 秒)で、
  // 「、彼の」134.99→105.17 になり、真ん中の時刻 120.08 で発話に振り分けられていた
  const parts = [
    { id: 'u1', path: 'a.wav', start: 105.17, end: 110 },
    { id: 'u2', path: 'a.wav', start: 112, end: 118 },
    { id: 'u3', path: 'a.wav', start: 119.76, end: 120.42 }
  ]

  it('まとめて読んだ窓: どの言葉も終わり ≥ 始まり。音の終わりより後ろ(無音で埋めた所)の片は捨てる', () => {
    const [group] = groupAsrJobs(parts)
    expect(group.parts).toHaveLength(3)
    const out = asrGroupResults(group, '', [
      chunk('はい', 0.2, 1.0),
      chunk('そうです', 7.0, 8.2),
      chunk('、彼の中で', 14.06, 15.0),
      chunk('、彼の', 29.82, 0)
    ])
    for (const [i, r] of out.entries()) {
      const p = parts[i]
      for (const w of r.words) {
        expect(w.end).toBeGreaterThanOrEqual(w.start)
        const mid = (w.start + w.end) / 2
        expect(mid).toBeGreaterThanOrEqual(p.start - 0.25)
        expect(mid).toBeLessThanOrEqual(p.end + 0.25)
      }
    }
    expect(out.map((r) => r.text)).toEqual(['はい', 'そうです', '、彼の中で'])
  })

  it('音の外の作り話を、最後の発話へ押し込まない(窓 12 秒・「ご視聴…」を 20〜22 秒)', () => {
    const [group] = groupAsrJobs([
      { id: 'u1', path: 'a.wav', start: 100, end: 105 },
      { id: 'u2', path: 'a.wav', start: 107, end: 112 }
    ])
    const out = asrGroupResults(group, '', [
      chunk('はい', 0.5, 1),
      chunk('そうです', 8, 9),
      chunk('ご視聴ありがとうございました', 20, 22)
    ])
    expect(out.map((r) => r.text)).toEqual(['はい', 'そうです'])
  })

  it('1件だけの窓: 音の外の片は文からも捨て、終わりの分からない片は次の片の始まりまで', () => {
    const [group] = groupAsrJobs([{ id: 'v', path: 'a.wav', start: 583.07, end: 584.26 }])
    const [r] = asrGroupResults(group, '彼らは彼らは彼らは彼ら', [
      chunk('彼らは', 0.02, 0.74),
      chunk('彼らは', 0.74, 1.02),
      chunk('彼らは', 1.02, 1.14),
      chunk('彼ら', 12.6, 0)
    ])
    expect(r.text).toBe('彼らは彼らは彼らは')
    expect(r.words).toHaveLength(3)
    for (const w of r.words) {
      expect(w.end).toBeGreaterThanOrEqual(w.start)
      expect(w.end).toBeLessThanOrEqual(584.26 + 1e-9)
    }
    // 終わりの無い片(null)は次の片の始まりまで。最後なら音の終わりまで
    const [g2] = groupAsrJobs([{ id: 'x', path: 'a.wav', start: 10, end: 14 }])
    const [r2] = asrGroupResults(g2, 'abc', [
      chunk('a', 1, null),
      chunk('b', 2, 3),
      chunk('c', 3.5, 0)
    ])
    expect(r2.words).toEqual([
      { text: 'a', start: 11, end: 12 },
      { text: 'b', start: 12, end: 13 },
      { text: 'c', start: 13.5, end: 14 }
    ])
  })

  it('音の終わりのすぐ後ろ(余裕の中)・終わりをまたぐ決まり文句の作り話は捨て、本物の言葉は残す', () => {
    const multi = [
      { id: 'u1', path: 'a.wav', start: 100, end: 105 },
      { id: 'u2', path: 'a.wav', start: 107, end: 112 }
    ]
    const [g] = groupAsrJobs(multi)
    // 窓 12 秒。12.1 秒に始まる「ご視聴」「ありがとうございました」(2つの片で決まり文句)
    expect(
      asrGroupResults(g, '', [
        chunk('はい', 0.5, 1.0),
        chunk('そうです', 8, 9),
        chunk('ご視聴', 12.1, 12.3),
        chunk('ありがとうございました', 12.3, 13.5)
      ]).map((r) => r.text)
    ).toEqual(['はい', 'そうです'])
    // 終わりをまたぐ1つの片
    expect(
      asrGroupResults(g, '', [
        chunk('そうです', 8, 9),
        chunk('ご視聴ありがとうございました', 11.8, 13)
      ]).map((r) => r.text)
    ).toEqual(['', 'そうです'])
    // 音の外でも決まり文句でない本物の言葉(VAD が早く切った「ね」)は残す
    expect(
      asrGroupResults(g, '', [chunk('そうです', 8, 9), chunk('ね', 12.1, 12.3)]).map((r) => r.text)
    ).toEqual(['', 'そうですね'])
    // 1件だけの窓(5 秒の窓で 5.3 秒に始まる)
    const [one] = groupAsrJobs([{ id: 's', path: 'a.wav', start: 50, end: 55 }])
    const [r] = asrGroupResults(one, 'こんにちは。ご視聴ありがとうございました', [
      chunk('こんにちは。', 0.2, 1.5),
      chunk('ご視聴ありがとうございました', 5.3, 7)
    ])
    expect(r.text).toBe('こんにちは。')
    expect(r.words.map((w) => w.text)).toEqual(['こんにちは。'])
  })

  it('正しい時刻の言葉は、発話の範囲で切り詰めない(話す速さの判定に使う)', () => {
    const [group] = groupAsrJobs([
      { id: 'a', path: 'a.wav', start: 0, end: 1.2 },
      { id: 'b', path: 'a.wav', start: 1.9, end: 4.7 }
    ])
    const out = asrGroupResults(group, '', [chunk('彼らは', 1.14, 2.74), chunk('です', 4.6, 4.9)])
    expect(out[1].words).toEqual([
      { text: '彼らは', start: 1.14, end: 2.74 },
      { text: 'です', start: 4.6, end: 4.9 }
    ])
  })
})

// ---- 多バイトの文字が認識の区切りの境目で割れる(「十三四の倅」が「十三子の�狼」)

/** 片の番号 → バイト列(Whisper の BPE をまねる)。「倅」= E5 80 85 を2つの片に分ける */
const BYTES: Record<number, number[]> = {
  1: [...new TextEncoder().encode('十三四の')],
  2: [0xe5, 0x80],
  3: [0x85],
  4: [...new TextEncoder().encode('がいた。')],
  5: [...new TextEncoder().encode('次へ')]
}

/** transformers.js の WhisperTokenizer をまねる: 区切りごとに言葉を束ね、区切りの文をつなぐ */
function fakeTokenizer(): {
  decode: (t: number[]) => string
  collateWordTimestamps: (
    t: number[],
    ts: [number, number][],
    lang?: string
  ) => { text: string; timestamp: [number, number] }[]
  _decode_asr: (segments: { tokens: number[]; ts: [number, number][] }[]) => [string, AsrRawChunk[]]
} {
  const decode = (t: number[]): string =>
    new TextDecoder().decode(new Uint8Array(t.flatMap((x) => BYTES[x])))
  return {
    decode,
    collateWordTimestamps(t, ts) {
      return t.length === 0 ? [] : [{ text: this.decode(t), timestamp: [ts[0][0], ts.at(-1)![1]] }]
    },
    _decode_asr(segments) {
      const words: AsrRawChunk[] = []
      let text = ''
      for (const s of segments) {
        text += this.decode(s.tokens)
        words.push(...(this.collateWordTimestamps(s.tokens, s.ts) as AsrRawChunk[]))
      }
      return [text, words]
    }
  }
}

describe('区切りの境目で割れた多バイトの文字', () => {
  const segments = [
    {
      tokens: [1, 2],
      ts: [
        [0, 1],
        [1, 1.2]
      ] as [number, number][]
    },
    {
      tokens: [3, 4],
      ts: [
        [1.2, 1.3],
        [1.3, 2]
      ] as [number, number][]
    }
  ]

  it('割れた片を次の区切りの頭へつないでから文字にする。テロップの文にも「�」を出さない', () => {
    const tokenizer = fakeTokenizer()
    // 直す前の形: 「十三四の�」「�がいた。」
    const [rawText, rawWords] = tokenizer._decode_asr(segments)
    expect(rawText).toContain('�')
    expect(rawWords.map((w) => w.text).join('')).toContain('�')

    const asr = Object.assign(async () => ({ text: '' }), { tokenizer })
    expect(markSegmentStarts(asr)).toBe(true)
    const [text, words] = tokenizer._decode_asr(segments)
    expect(words.map((w) => w.text)).toEqual(['十三四の', '倅がいた。'])
    // 割れた片の時刻も一緒に移る
    expect(words[1].timestamp).toEqual([1, 2])
    expect(words.every((w) => w.segmentStart)).toBe(true)

    const [group] = groupAsrJobs([{ id: 'u', path: 'a.wav', start: 132.73, end: 136.79 }])
    const [r] = asrGroupResults(group, text, words)
    expect(r.text).toBe('十三四の倅がいた。')
    expect(r.words.map((w) => w.text).join('')).toBe('十三四の倅がいた。')
  })

  it('次の区切りが無い・つないでも直らない片は「�」を出さずに落とす', () => {
    const tokenizer = fakeTokenizer()
    const asr = Object.assign(async () => ({ text: '' }), { tokenizer })
    markSegmentStarts(asr)
    // 区切りの終わりで割れたまま、認識が終わる(残った片は捨てる)。次の認識へ持ち越さない
    const [t1, w1] = tokenizer._decode_asr([segments[0]])
    expect(w1.map((w) => w.text)).toEqual(['十三四の'])
    const [, w2] = tokenizer._decode_asr([{ tokens: [5], ts: [[0, 1]] }])
    expect(w2.map((w) => w.text)).toEqual(['次へ'])
    const [group] = groupAsrJobs([{ id: 'u', path: 'a.wav', start: 0, end: 3 }])
    expect(asrGroupResults(group, t1, w1)[0].text).toBe('十三四の')

    // 認識そのものが文字の途中の片を出した(「の」E5 80 「狼」): つないでも直らないので「�」だけ落とす
    const [g2] = groupAsrJobs([{ id: 'v', path: 'a.wav', start: 0, end: 5 }])
    const [r] = asrGroupResults(g2, '、十三子の�狼がいた。', [
      chunk('、十三子の�狼がいた。', 0.06, 3.78)
    ])
    expect(r.text).toBe('、十三子の狼がいた。')
    expect(r.words.map((w) => w.text)).toEqual(['、十三子の狼がいた。'])
    // まとめて読んだ窓でも
    const [g3] = groupAsrJobs([
      { id: 'a', path: 'a.wav', start: 0, end: 1 },
      { id: 'b', path: 'a.wav', start: 1.5, end: 3 }
    ])
    const out = asrGroupResults(g3, '', [chunk('は�い', 0.1, 0.5), chunk('�', 1.6, 1.7)])
    expect(out.map((x) => x.text)).toEqual(['はい', ''])
    expect(out[1].words).toEqual([])
  })
})

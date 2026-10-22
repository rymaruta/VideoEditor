import { describe, expect, it } from 'vitest'
import {
  asrGroupResults,
  groupAsrJobs,
  markSegmentStarts,
  type AsrRawChunk
} from '../../src/shared/diarize/groupJobs'
import { utteranceToTelopChunks } from '../../src/shared/telop/fromTranscript'

/**
 * 英語の語の間の空白が消える(実地テスト: 「I knowI should」)。
 *
 * 自動編集の文字起こしは日本語に固定して認識する。日本語の設定では、認識の区切り(Whisper の時刻の区切り)
 * の頭に空白が付かず、transformers.js は区切りの文をそのままつなぐので「I know」「I should…」が
 * 「I knowI should…」になる。言葉の片も「I」(頭に空白なし)になり、空白のあった所が分からない
 */
const chunk = (text: string, s: number, e: number, segmentStart = false): AsrRawChunk => ({
  text,
  timestamp: [s, e],
  ...(segmentStart ? { segmentStart: true } : {})
})

const english: AsrRawChunk[] = [
  chunk('I', 0, 0.2, true),
  chunk(' know', 0.2, 0.5),
  chunk('I', 0.9, 1.0, true),
  chunk(' should', 1.0, 1.3),
  chunk(' just', 1.3, 1.5),
  chunk(' crush', 1.5, 1.8),
  chunk(' you!', 1.8, 2.1)
]

describe('認識の区切りの頭の空白(英語)', () => {
  it('1件だけの発話: 区切りの頭の英数字どうしの間を空け、テロップも「I know I should」になる', () => {
    const [group] = groupAsrJobs([{ id: 'a', path: 'm.wav', start: 94, end: 100 }])
    const [r] = asrGroupResults(group, 'I knowI should just crush you!', english)
    expect(r.text).toBe('I know I should just crush you!')
    expect(asrGroupResults(group, ' I knowI should just crush you!', english)[0].text).toBe(
      'I know I should just crush you!'
    )
    expect(r.words.map((w) => w.text)).toEqual([
      'I',
      'know',
      'I',
      'should',
      'just',
      'crush',
      'you!'
    ])
    const telops = utteranceToTelopChunks(
      { text: r.text, words: r.words, sourceStart: 94, sourceEnd: 100 },
      { maxLineChars: 14 }
    )
    expect(telops.map((t) => t.text.replace(/\n/g, ' ')).join(' ')).toBe(
      'I know I should just crush you!'
    )
  })

  it('まとめて読んだ発話でも同じ', () => {
    const [group] = groupAsrJobs([
      { id: 'a', path: 'm.wav', start: 0, end: 0.6 },
      { id: 'b', path: 'm.wav', start: 0.8, end: 2.2 }
    ])
    expect(group.parts).toHaveLength(2)
    const out = asrGroupResults(group, 'I knowI should just crush you!', english)
    expect(out.map((r) => r.text)).toEqual(['I know', 'I should just crush you!'])
    const one = groupAsrJobs([{ id: 'c', path: 'm.wav', start: 0, end: 2.2 }])[0]
    // 区切りの頭でも、続いていた片(「Mine」「craft」)・日本語は詰めたまま
    const r = asrGroupResults(one, 'Minecraft。そこは深い谷', [
      chunk('Mine', 0, 0.3, true),
      chunk('craft。', 0.3, 0.6),
      chunk('そこは', 0.8, 1.2, true),
      chunk('深い谷', 1.2, 1.6)
    ])[0]
    expect(r.text).toBe('Minecraft。そこは深い谷')
  })

  it('日本語の文はそのまま(空白も変えない)', () => {
    const [group] = groupAsrJobs([{ id: 'a', path: 'm.wav', start: 0, end: 5 }])
    const [r] = asrGroupResults(group, ' はい ありがとう。2人で', [
      chunk(' はい', 0, 0.4, true),
      chunk(' ありがとう。', 0.5, 1.2),
      chunk('2', 1.5, 1.6, true),
      chunk('人で', 1.6, 2)
    ])
    expect(r.text).toBe('はい ありがとう。2人で')
  })
})

describe('markSegmentStarts — 認識の区切りの頭の言葉に印を付ける', () => {
  it('区切りごとに呼ばれる言葉の束ね(collateWordTimestamps)の最初の言葉に印を付ける', () => {
    const tokenizer = {
      collateWordTimestamps(tokens: number[]): { text: string; timestamp: [number, number] }[] {
        return tokens.map((t) => ({ text: `w${t}`, timestamp: [t, t + 1] }))
      }
    }
    const asr = Object.assign(async () => ({ text: '' }), { tokenizer })
    expect(markSegmentStarts(asr)).toBe(true)
    const a = tokenizer.collateWordTimestamps([1, 2]) as AsrRawChunk[]
    const b = tokenizer.collateWordTimestamps([3]) as AsrRawChunk[]
    expect([...a, ...b].map((w) => Boolean(w.segmentStart))).toEqual([true, false, true])
    // 2回付けても二重にならない
    expect(markSegmentStarts(asr)).toBe(true)
    expect(
      (tokenizer.collateWordTimestamps([4, 5]) as AsrRawChunk[]).map((w) => Boolean(w.segmentStart))
    ).toEqual([true, false])
    // 束ねの関数が無い版では何もしない
    expect(markSegmentStarts(Object.assign(async () => ({ text: '' }), { tokenizer: {} }))).toBe(
      false
    )
  })
})

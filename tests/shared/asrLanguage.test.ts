import { describe, expect, it } from 'vitest'
import {
  averageProbs,
  groupAsrJobs,
  languageProbes,
  languageProbs
} from '../../src/shared/diarize/groupJobs'
import {
  ASR_LANGUAGES,
  AUTO_LANGUAGE_CONFIDENCE,
  chooseAsrLanguage,
  isAsrLanguage,
  whisperLanguageCode,
  withLanguageFallback
} from '../../src/shared/transcript'

/**
 * 自動編集の文字起こしは日本語に固定されていて、英語の素材は日本語への訳として出ていた
 * (実地テスト: 英語 10 分)。言語を選べるようにし、自動判定は素材(マイク)ごとに声の多い窓で決める。
 * モデルは動かさず、最初の言葉(言語の印)の点数をまねた入力で試す
 */

const LANG_TO_ID = { '<|en|>': 1, '<|ja|>': 2, '<|zh|>': 3, '<|ko|>': 4 }

/** 言語の印の点数(それ以外の言葉の点数は大きくても数えない) */
function logits(scores: Partial<Record<'en' | 'ja' | 'zh' | 'ko', number>>): number[] {
  const out = [50, -5, -5, -5, -5]
  for (const [code, v] of Object.entries(scores)) out[LANG_TO_ID[`<|${code}|>` as '<|en|>']] = v
  return out
}

describe('言語の判定', () => {
  it('言語の印の中で確からしさを出す(足して 1)', () => {
    const p = languageProbs(logits({ en: 5, ja: 1 }), LANG_TO_ID)
    expect([...p.keys()].sort()).toEqual(['en', 'ja', 'ko', 'zh'])
    expect([...p.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(p.get('en')!).toBeGreaterThan(0.9)
  })

  it('はっきり英語なら英語、日本語・はっきりしないときは日本語', () => {
    const en = languageProbs(logits({ en: 6, ja: 0 }), LANG_TO_ID)
    const ja = languageProbs(logits({ en: 0, ja: 6 }), LANG_TO_ID)
    const unsure = languageProbs(logits({ en: 0.6, ja: 0.5, zh: 0.5, ko: 0.4 }), LANG_TO_ID)
    expect(chooseAsrLanguage(en)).toBe('en')
    expect(chooseAsrLanguage(ja)).toBe('ja')
    expect(unsure.get('en')!).toBeLessThan(AUTO_LANGUAGE_CONFIDENCE)
    expect(chooseAsrLanguage(unsure)).toBe('ja')
    expect(chooseAsrLanguage(new Map())).toBe('ja')
    // 窓ごとの判定を平均する(1つの窓だけ英語に寄っても、素材は日本語)
    expect(chooseAsrLanguage(averageProbs([en, ja, ja]))).toBe('ja')
    expect(chooseAsrLanguage(averageProbs([en, en, ja]))).toBe('ja')
    // 英語が一番でも、日本語の確からしさが残っていれば日本語
    expect(
      chooseAsrLanguage(
        new Map([
          ['en', 0.6],
          ['ja', 0.3],
          ['zh', 0.1]
        ])
      )
    ).toBe('ja')
    expect(
      chooseAsrLanguage(
        new Map([
          ['en', 0.55],
          ['ja', 0.05],
          ['es', 0.4]
        ])
      )
    ).toBe('en')
    expect(chooseAsrLanguage(averageProbs([en, en, en]))).toBe('en')
  })

  it('判定に読む窓は、素材ごとに声の多い順に 3 つまで', () => {
    const groups = groupAsrJobs([
      { id: 'a1', path: 'A.wav', start: 0, end: 2 },
      { id: 'a2', path: 'A.wav', start: 30, end: 50 },
      { id: 'a3', path: 'A.wav', start: 100, end: 105 },
      { id: 'a4', path: 'A.wav', start: 200, end: 210 },
      { id: 'b1', path: 'B.wav', start: 0, end: 3 }
    ])
    const probes = languageProbes(groups)
    expect(probes.get('A.wav')!.map((g) => g.parts[0].id)).toEqual(['a2', 'a4', 'a3'])
    expect(probes.get('B.wav')!.map((g) => g.parts[0].id)).toEqual(['b1'])
  })

  it('選べる言語(自動判定・日本語・英語…)', () => {
    expect(ASR_LANGUAGES).toContain('auto')
    expect(ASR_LANGUAGES).toContain('japanese')
    expect(ASR_LANGUAGES).toContain('english')
    expect(isAsrLanguage('english')).toBe(true)
    expect(isAsrLanguage('klingon')).toBe(false)
  })

  it('判定した言語は認識に渡せる符号に限る(広東語 yue は中国語へ、受けない符号は日本語)', () => {
    expect(
      chooseAsrLanguage(
        new Map([
          ['yue', 0.9],
          ['ja', 0.01]
        ])
      )
    ).toBe('zh')
    expect(
      chooseAsrLanguage(
        new Map([
          ['xx', 0.9],
          ['ja', 0.01]
        ])
      )
    ).toBe('ja')
    expect(whisperLanguageCode('en')).toBe('en')
    expect(whisperLanguageCode('yue')).toBe('zh')
    expect(whisperLanguageCode('klingon')).toBe('ja')
  })

  it('言語の指定で認識が失敗したら日本語で認識し直す(全体を止めない)。日本語で失敗したらそのまま失敗', async () => {
    const calls: string[] = []
    const run = async (lang: string): Promise<string> => {
      calls.push(lang)
      if (lang === 'yue') throw new Error('Language "yue" is not supported')
      return `ok:${lang}`
    }
    await expect(withLanguageFallback('yue', run)).resolves.toBe('ok:japanese')
    expect(calls).toEqual(['yue', 'japanese'])
    await expect(withLanguageFallback('en', run)).resolves.toBe('ok:en')
    const fail = async (): Promise<string> => {
      throw new Error('boom')
    }
    await expect(withLanguageFallback('japanese', fail)).rejects.toThrow('boom')
    await expect(withLanguageFallback('ja', fail)).rejects.toThrow('boom')
  })

  it('言語と関係のない失敗(メモリ不足など)は日本語でやり直さず、そのまま返す', async () => {
    const calls: string[] = []
    const oom = async (lang: string): Promise<string> => {
      calls.push(lang)
      throw new Error('out of memory')
    }
    await expect(withLanguageFallback('en', oom)).rejects.toThrow('out of memory')
    expect(calls).toEqual(['en'])
  })
})

import { describe, expect, it } from 'vitest'
import { utteranceToTelopChunks, clipTelopChunkText } from '../../src/shared/telop/fromTranscript'
import { groupAsrJobs, splitGroupWords } from '../../src/shared/diarize/groupJobs'
import { breakScore } from '../../src/shared/telop/polish'
import {
  autoTelopKey,
  mergeManualTelops,
  rememberEditedTelops
} from '../../src/shared/telop/manual'
import { telopIssues } from '../../src/shared/qc/telop'
import { defaultTextStyle } from '../../src/shared/textStyle'
import type { AsrJob } from '../../src/shared/transcript'
import type { TextOverlay } from '../../src/shared/types'

const timed = (ws: string[], dt = 0.3): { text: string; start: number; end: number }[] =>
  ws.map((text, i) => ({ text, start: i * dt, end: i * dt + dt }))

describe('発言テロップ: 認識の片(サブワード)の間を空けない', () => {
  it('認識した文で続いていた英数字の片は詰め、空白のあった所だけ空ける', () => {
    const ws = ['今日は', 'Mine', 'craft', 'で', '15', '000', '円', '使いました']
    const c = utteranceToTelopChunks({
      text: '今日はMinecraftで15000円使いました',
      words: timed(ws),
      sourceStart: 0,
      sourceEnd: 2.4
    })
    const text = c.map((x) => x.text).join('')
    expect(text).toContain('Minecraft')
    expect(text).toContain('15000円')
    // 英語の言葉どうしは、認識した文のとおり空ける
    const g = utteranceToTelopChunks({
      text: 'Good morning みんな',
      words: timed(['Good', 'morning', 'みんな']),
      sourceStart: 0,
      sourceEnd: 0.9
    })
    // (空けた所は改行の位置にもなる)
    expect(g.map((x) => x.text).join('\n')).toMatch(/^Good[ \n]morning/)
  })

  it('まとめて認識した発話も、片の頭の空白で空けるかを決める', () => {
    const job = (id: string, start: number, end: number): AsrJob => ({
      id,
      path: '/A.wav',
      start,
      end
    })
    const [group] = groupAsrJobs([job('a1', 0, 2), job('a2', 3, 5)])
    const r = splitGroupWords(
      group,
      [
        { text: 'Mine', start: 0.2, end: 0.5 },
        { text: 'craft', start: 0.5, end: 0.8 },
        { text: ' 15', start: 1, end: 1.2 },
        { text: '000', start: 1.2, end: 1.4 },
        { text: ' Good', start: 3.2, end: 3.5 },
        { text: ' morning', start: 3.5, end: 3.9 }
      ],
      true
    )
    expect(r.map((x) => x.text)).toEqual(['Minecraft 15000', 'Good morning'])
    // 返す言葉は空白を落とす
    expect(r[1].words.map((w) => w.text)).toEqual(['Good', 'morning'])
  })
})

describe('発言テロップ: 桁区切りの数字の途中で切らない', () => {
  it('「2,800」のカンマの後では行・枚を分けない', () => {
    expect(breakScore([...'は2,800円'], 3)).toBe(-Infinity)
    expect(breakScore([...'は２，８００円'], 3)).toBe(-Infinity)
    // 数字ではない所のカンマの後は、これまでどおり区切ってよい
    expect(breakScore([...'はい,そう'], 3)).toBeGreaterThan(0)
    const ws = ['お会計は', '2,800', '円', 'でした', 'ね', '本当に', '高かった', 'です', 'よね']
    const c = utteranceToTelopChunks(
      { text: ws.join(''), words: timed(ws), sourceStart: 0, sourceEnd: 2.7 },
      { maxLineChars: 6 }
    )
    expect(c.some((x) => x.text.replace(/\n/g, '').includes('2,800'))).toBe(true)
  })
})

describe('テロップの自動確認: 改行で折れた言葉も見つける', () => {
  const ctx = {
    font: '',
    measureText(ch: string) {
      const s = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
      return { width: s * [...ch].length } as TextMetrics
    }
  }
  const overlay = (id: string, text: string, start: number): TextOverlay => ({
    id,
    text,
    startTime: start,
    endTime: start + 3,
    style: defaultTextStyle()
  })
  const options = {
    bannedWords: ['クソゲー', 'dmo'],
    dictionary: [{ from: 'クソゲー', to: '難しいゲーム' }]
  }

  it('「クソ\\nゲー」「クソ ゲー」を確認する言葉・辞書の誤の表記として知らせる', () => {
    const issues = telopIssues(
      [overlay('a', 'ゲームはクソ\nゲーすぎて', 0), overlay('b', 'これはクソ ゲー', 4)],
      ctx,
      { w: 1920, h: 1080 },
      options
    )
    expect(issues.filter((i) => i.kind === 'telopWord').map((i) => i.overlayId)).toEqual(['a', 'b'])
    expect(issues.filter((i) => i.kind === 'telopDictionary').map((i) => i.overlayId)).toEqual([
      'a',
      'b'
    ])
  })

  it('別のテロップどうし・英語の言葉の境目はつながない', () => {
    const issues = telopIssues(
      [
        overlay('a', 'これはクソ', 0),
        overlay('b', 'ゲーだね', 3),
        overlay('c', 'Good\nmorning', 6)
      ],
      ctx,
      { w: 1920, h: 1080 },
      options
    )
    expect(issues.filter((i) => i.kind === 'telopWord' || i.kind === 'telopDictionary')).toEqual([])
  })
})

describe('人の修正: 枚の分け方が変わっても同じ言葉の枚へ当てる', () => {
  const ws = [
    '今日は',
    'みんなで',
    'ラーメンを',
    '食べに',
    '横浜まで',
    '来ました',
    'すごく',
    '並んで',
    'ますね',
    '楽しみ',
    'です'
  ]
  const u = { text: ws.join(''), words: timed(ws, 0.5), sourceStart: 0, sourceEnd: 5.5 }
  const style = defaultTextStyle()
  type Auto = Omit<TextOverlay, 'id'> & {
    autoSource?: { start: number; end: number; text: string }
  }
  const mk = (maxLineChars: number, withSource: boolean): Auto[] =>
    utteranceToTelopChunks(u, { maxLineChars }).map((c, i) => ({
      text: c.text,
      startTime: c.sourceStart,
      endTime: c.sourceEnd,
      style,
      source: 'auto' as const,
      utteranceId: 'u1',
      utteranceChunk: i,
      ...(withSource
        ? { autoSource: { start: c.sourceStart, end: c.sourceEnd, text: c.text } }
        : {})
    }))
  const shown = (xs: readonly { text: string }[]): string =>
    xs.map((m) => m.text.replace(/\s/g, '')).join('')
  const editLast = (xs: Auto[]): TextOverlay[] => {
    const out = xs.map((o, i) => ({ ...o, id: `o${i}` })) as TextOverlay[]
    const last = out.length - 1
    out[last] = { ...out[last], text: out[last].text.replace('楽しみ', 'たのしみ'), edited: true }
    return out
  }

  it('元の部分を覚えた修正は、直した言葉だけを置き換え、ほかの言葉は1回ずつ残す', () => {
    const existing = editLast(mk(14, true))
    const merged = mergeManualTelops(existing, mk(8, true), new Set())
    expect(shown(merged)).toBe(
      '今日はみんなでラーメンを食べに横浜まで来ましたすごく並んでますねたのしみです'
    )
    expect(merged.filter((m) => m.edited).length).toBe(1)
    // 時刻の順に並ぶ
    const starts = merged.map((m) => m.startTime)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    // 覚えておいた修正(タイムラインから外れた後)からも同じに当たる
    const remembered = rememberEditedTelops(existing, undefined)!
    const again = mergeManualTelops([], mk(8, true), new Set(), remembered)
    expect(shown(again)).toBe(shown(merged))
    // 当て直した結果をもう一度作り直しても、言葉は増えも減りもしない
    const third = mergeManualTelops(
      merged.map((m, i) => ({ ...m, id: `m${i}` })),
      mk(8, true),
      new Set(),
      rememberEditedTelops(
        merged.map((m, i) => ({ ...m, id: `m${i}` })),
        remembered
      )
    )
    expect(shown(third)).toBe(shown(merged))
  })

  it('前の版の修正(元の部分なし)も、言葉が2回出ない・消えない', () => {
    const merged = mergeManualTelops(editLast(mk(14, false)), mk(8, false), new Set())
    const text = shown(merged)
    expect(text.split('ラーメン').length - 1).toBe(1)
    expect(text.split('たのしみ').length - 1 + text.split('楽しみ').length - 1).toBe(1)
    expect(text).toContain('食べに横浜まで')
  })

  it('前の版の鍵(何枚目かだけ)は、枚の分け方が同じならこれまでどおり当たる', () => {
    const incoming = mk(14, true)
    const merged = mergeManualTelops([], incoming, new Set(['u:u1#0']), {
      'u:u1#1': { text: '直した', style }
    })
    expect(merged.map((m) => m.text)).toEqual(['直した'])
  })

  it('消した枚は、分け方が変わっても大半が重なる枚だけを足さない', () => {
    const first = mk(14, true)
    const key = autoTelopKey(first[1])!
    expect(key).toMatch(/^u:u1#1@/)
    const merged = mergeManualTelops([], mk(8, true), new Set([key]))
    const text = shown(merged)
    expect(text).toContain('ラーメン')
    expect(text).not.toContain('楽しみ')
  })
})

describe('頭・終わりをカットで落とした枚の文', () => {
  it('残った時刻で話している言葉だけにする', () => {
    const ws = ['きょうは', 'すごい', 'ボスを', 'たおしに', 'いきますよ']
    const u = { text: ws.join(''), words: timed(ws, 1), sourceStart: 0, sourceEnd: 5 }
    const [chunk] = utteranceToTelopChunks(u)
    expect(clipTelopChunkText(u, chunk, 3, 5)).toBe('たおしにいきますよ')
    expect(clipTelopChunkText(u, chunk, 0, 2)).toBe('きょうはすごい')
  })
})

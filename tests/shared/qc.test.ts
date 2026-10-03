import { describe, expect, it } from 'vitest'
import { defaultTextStyle } from '../../src/shared/textStyle'
import {
  QcLogParser,
  mediaIssues,
  mergeTouching,
  qcFilter,
  subtract
} from '../../src/shared/qc/media'
import { sortIssues, telopIssues } from '../../src/shared/qc/telop'
import type { TextOverlay } from '../../src/shared/types'

// ffmpeg 7 の実際のログ(抜粋)
const LOG = `[blackdetect @ 0x1] black_start:0 black_end:1.2 black_duration:1.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 0
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 1.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 1.2
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 58.666667
[freezedetect @ 0x2] lavfi.freezedetect.freeze_duration: 4.566667
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 63.233333
[freezedetect @ 0x2] lavfi.freezedetect.freeze_start: 63.233333
[freezedetect @ 0x2] lavfi.freezedetect.freeze_end: 66.4
[silencedetect @ 0x3] silence_start: 20.5
[silencedetect @ 0x3] silence_end: 24 | silence_duration: 3.5
[silencedetect @ 0x3] silence_start: 85
frame= 2665 fps=759 q=-0.0 Lsize=N/A time=00:01:28.83 bitrate=N/A speed=25.3x
[Parsed_ebur128_3 @ 0x4] Summary:

  Integrated loudness:
    I:         -16.2 LUFS
    Threshold: -24.7 LUFS

  Loudness range:
    LRA:         5.2 LU
    Threshold: -34.7 LUFS

  True peak:
    Peak:       -0.4 dBFS`

function parse(log: string, duration?: number): ReturnType<QcLogParser['result']> {
  const p = new QcLogParser()
  for (const line of log.split('\n')) p.push(line)
  return p.result(duration)
}

describe('QcLogParser', () => {
  it('黒味・フリーズ・無音・ラウドネスを拾い、つながったフリーズは1つにする', () => {
    const m = parse(LOG, 88.83)
    expect(m.black).toEqual([{ start: 0, end: 1.2 }])
    expect(m.freeze).toEqual([
      { start: 0, end: 1.2 },
      { start: 58.666667, end: 66.4 }
    ])
    // 最後まで続いた無音は、動画の終わりで閉じる
    expect(m.silence).toEqual([
      { start: 20.5, end: 24 },
      { start: 85, end: 88.83 }
    ])
    expect(m.loudness).toEqual({ integrated: -16.2, lra: 5.2, truePeak: -0.4 })
  })

  it('長さが分からなければ、読めた最後の時刻で閉じる', () => {
    expect(parse(LOG).duration).toBeCloseTo(88.83)
  })

  it('音声の無い動画ではラウドネスが無い', () => {
    expect(parse('[blackdetect @ 0x1] black_start:3 black_end:4 black_duration:1').loudness).toBe(
      null
    )
  })
})

describe('mergeTouching', () => {
  it('離れた区間はそのまま', () => {
    expect(
      mergeTouching([
        { start: 5, end: 6 },
        { start: 0, end: 1 }
      ])
    ).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 }
    ])
  })
})

describe('subtract', () => {
  it('黒味に続く静止画は、黒味のぶんを除いた残りだけになる', () => {
    expect(subtract({ start: 5, end: 11 }, [{ start: 5, end: 7 }])).toEqual([{ start: 7, end: 11 }])
    expect(subtract({ start: 0, end: 10 }, [{ start: 4, end: 6 }])).toEqual([
      { start: 0, end: 4 },
      { start: 6, end: 10 }
    ])
    expect(subtract({ start: 0, end: 2 }, [{ start: 0, end: 3 }])).toEqual([])
  })
})

describe('qcFilter', () => {
  it('映像・音声のある方だけ測る', () => {
    expect(qcFilter(true, false)).toContain('[qv]')
    expect(qcFilter(true, false)).not.toContain('[qa]')
    expect(qcFilter(false, true)).toContain('ebur128')
  })
})

describe('mediaIssues', () => {
  it('黒味は直すべき、黒味と重なるフリーズは重ねて知らせない', () => {
    const issues = mediaIssues(parse(LOG, 88.83), 'web')
    expect(issues.filter((i) => i.kind === 'black')).toHaveLength(1)
    const freezes = issues.filter((i) => i.kind === 'freeze')
    expect(freezes).toHaveLength(1)
    expect(freezes[0].start).toBeCloseTo(58.67, 1)
  })

  it('ラウドネスが基準から 1 LU を超えてずれ、ピークが上限を超えていれば知らせる', () => {
    const kinds = mediaIssues(parse(LOG, 88.83), 'web').map((i) => i.kind)
    expect(kinds).toContain('loudness')
    expect(kinds).toContain('truePeak')
  })

  it('基準の内側なら知らせない。音量を整えない書き出しはラウドネスを見ない', () => {
    const ok = parse(LOG.replace('-16.2 LUFS', '-14.4 LUFS').replace('-0.4 dBFS', '-1.6 dBFS'))
    expect(mediaIssues(ok, 'web').map((i) => i.kind)).not.toContain('loudness')
    expect(mediaIssues(ok, 'web').map((i) => i.kind)).not.toContain('truePeak')
    expect(mediaIssues(parse(LOG), 'off').map((i) => i.kind)).not.toContain('loudness')
  })

  it('放送向けは −24 LKFS で判定する', () => {
    const tv = parse(LOG.replace('-16.2 LUFS', '-24.3 LUFS').replace('-0.4 dBFS', '-3.0 dBFS'))
    expect(mediaIssues(tv, 'broadcast').map((i) => i.kind)).not.toContain('loudness')
    expect(mediaIssues(tv, 'web').map((i) => i.kind)).toContain('loudness')
  })
})

// 1文字 = 文字の大きさぶんの幅、として測る
const ctx = {
  font: '',
  measureText: () => ({ width: 60 }) as TextMetrics
}
const canvas = { w: 1920, h: 1080 }
const base = { ...defaultTextStyle(), fontSize: 60, outline: false, extraStrokes: [] }

function overlay(p: Partial<TextOverlay>): TextOverlay {
  return { id: p.id ?? 'o', text: 'テスト', startTime: 0, endTime: 2, style: base, ...p }
}

describe('telopIssues', () => {
  const opts = { bannedWords: [], dictionary: [] }

  it('ふつうの下のテロップは何も知らせない', () => {
    expect(telopIssues([overlay({})], ctx, canvas, opts)).toEqual([])
  })

  it('自由配置で画面の端に寄せたテロップは、タイトルセーフからのはみ出しを知らせる', () => {
    const o = overlay({ style: { ...base, customPosition: { x: 0.08, y: 0.5 } } })
    expect(telopIssues([o], ctx, canvas, opts).map((i) => i.kind)).toEqual(['telopSafe'])
  })

  it('行が多すぎて上下にはみ出すテロップも知らせる', () => {
    const o = overlay({ text: Array(14).fill('あ').join('\n'), endTime: 10 })
    expect(telopIssues([o], ctx, canvas, opts).map((i) => i.kind)).toContain('telopSafe')
  })

  it('文字数に対して表示が短いと知らせる(1秒10文字・最短0.5秒)', () => {
    const fast = overlay({ text: 'あいうえおかきくけこさしすせそ', endTime: 1 })
    const ok = overlay({ id: 'b', text: 'あいうえおかきくけこ', endTime: 1 })
    const blink = overlay({ id: 'c', text: 'え', endTime: 0.3 })
    const r = telopIssues([fast, ok, blink], ctx, canvas, opts)
    expect(r.filter((i) => i.kind === 'telopFast').map((i) => i.overlayId)).toEqual(['o', 'c'])
  })

  it('登録した言葉と、辞書の誤の表記が残っていれば知らせる。正しく書けていれば知らせない', () => {
    const r = telopIssues(
      [
        overlay({ id: 'a', text: 'じょうどがはまに着いた', endTime: 3 }),
        overlay({ id: 'b', text: '浄土ヶ浜に着いた', endTime: 3 }),
        overlay({ id: 'c', text: 'それはダメ言葉です', endTime: 3 })
      ],
      ctx,
      canvas,
      {
        bannedWords: ['ダメ言葉', ' '],
        dictionary: [
          { from: 'じょうどがはま', to: '浄土ヶ浜' },
          { from: '浄土', to: '浄土ヶ浜' }
        ]
      }
    )
    expect(r.map((i) => [i.overlayId, i.kind])).toEqual([
      ['a', 'telopDictionary'],
      ['c', 'telopWord']
    ])
  })
})

describe('sortIssues', () => {
  it('時刻の順、同じ時刻なら直すべきものを先に', () => {
    const mk = (id: string, start: number, severity: 'error' | 'warn') =>
      ({ id, kind: 'black', severity, start, end: start + 1, message: '' }) as const
    expect(
      sortIssues([mk('a', 5, 'warn'), mk('b', 1, 'warn'), mk('c', 5, 'error')]).map((i) => i.id)
    ).toEqual(['b', 'c', 'a'])
  })
})

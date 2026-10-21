import { describe, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  }
})
import { planRoughCut } from '../../src/renderer/src/lib/roughCutPlan'
import {
  autoTelopKey,
  mergeManualTelops,
  rememberEditedTelops,
  type WithAutoSource
} from '@shared/telop/manual'
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project, TextOverlay } from '@shared/types'

const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 100 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 100 }
  ]
}
type W = { text: string; start: number; end: number }
type Auto = Omit<TextOverlay, 'id'> & WithAutoSource
function plan(
  utterances: W[][],
  scenes: { start: number; end: number }[],
  lineChars: number,
  dictionary: { from: string; to: string }[] = []
): Auto[] {
  const transcript = utterances.map((words, k) => ({
    id: `u${k}`,
    assetId: 'MA',
    speaker: 'A',
    sourceStart: words[0].start,
    sourceEnd: words[words.length - 1].end,
    text: words.map((w) => w.text).join(''),
    words,
    overlap: false
  }))
  const project = {
    id: 'p',
    name: 'p',
    aspectRatio: '16:9',
    assets: [],
    clips: [],
    audioTracks: [],
    videoOverlayTracks: [],
    textOverlays: [],
    transcript,
    multicam: info
  } as unknown as Project
  const activity = new Uint8Array(100 * TURN_RATE).fill(1, 0, 10 * TURN_RATE)
  const sc = scenes.map((s, i) => ({ id: `s${i}`, ...s, lines: [], speech: 0 }))
  return planRoughCut(
    project,
    info,
    sc,
    sc.map((s) => ({ sceneId: s.id, score: 100, kind: 'highlight' as const, reason: '' })),
    activity,
    {
      targetSec: 0,
      keep: Object.fromEntries(sc.map((s) => [s.id, true])),
      styles: [],
      speechLook: { style: defaultTextStyle() },
      kind: 'game',
      policy: 'light',
      dictionary,
      style: { telopLineChars: lineChars } as never
    }
  ).telops as Auto[]
}
const ids = (ts: readonly Auto[]): TextOverlay[] =>
  ts.map((t, i) => ({ ...t, id: `t${i}` })) as TextOverlay[]
const flat = (t: { text: string }): string => t.text.replace(/\s/g, '')

const kanji = (s: string): string[] => [...s].filter((c) => /\p{Script=Han}/u.test(c))

/**
 * 第59回: 長さ 0 の言葉の文字を少しずつ並べた(第58回)ことで起きた退行。
 * Whisper の語の時刻は 0.02 秒刻みで、長さ 0 の言葉の次の言葉は同じ時刻か 0.02 秒後に続くことが多い
 */
describe('長さ 0 の言葉の文字の時刻', () => {
  it('次の言葉の頭を越えて並べない(越えると次の言葉の枚の範囲に入る)', () => {
    const words: W[] = [
      { text: '今日は', start: 1.0, end: 1.5 },
      { text: 'ですね', start: 1.6, end: 1.6 },
      { text: '配信', start: 1.62, end: 2.2 },
      { text: 'します', start: 2.2, end: 2.8 }
    ]
    const p = ids(plan([words], [{ start: 0, end: 4 }], 4))
    const target = p.find((t) => flat(t).startsWith('配信'))!
    expect(target).toBeDefined()
    // 直す前は「ですね」の「ね」が 1.62 秒を越えて並び、「配信」の枚を消すと一緒に消えていた
    const dismissed = mergeManualTelops(
      p.filter((t) => t !== target),
      plan([words], [{ start: 0, end: 4 }], 4),
      new Set([autoTelopKey(target)!])
    )
    expect(dismissed.map(flat).join('|')).toBe('今日はですね')
    const tl = p.map((t) => (t === target ? { ...t, text: '配信します!', edited: true } : t))
    const edited = mergeManualTelops(
      tl,
      plan([words], [{ start: 0, end: 4 }], 4),
      new Set(),
      rememberEditedTelops(tl, undefined)
    )
    expect(edited.map(flat).join('|')).toBe('今日はですね|配信します!')
  })

  it('前後に余地の無い長さ 0 の言葉も、文字ごとに違う時刻(0.006 秒以上の間隔)で、時刻は増える順', () => {
    // 「丒丕丘」は前の「丌丏」とも次の「丛丞両」とも同じ 6.272 秒。直す前はみな同じ時刻で、
    // 隣の枚を直した範囲に入って消えていた
    const words: W[] = [
      { text: '今日は', start: 5.0, end: 5.5 },
      { text: '丌丏', start: 6.272, end: 6.272 },
      { text: '丒丕丘', start: 6.272, end: 6.272 },
      { text: '丛丞両。', start: 6.272, end: 7.406 }
    ]
    const u = { id: 'u0', text: words.map((w) => w.text).join(''), words }
    const times = utteranceToTelopChunks(u as never, { maxLineChars: 40 }).flatMap(
      (c) => c.times ?? []
    )
    expect(times.length).toBe(11)
    for (let i = 1; i < times.length; i++)
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(0.006 - 1e-9)
    for (const lc of [3, 4, 5, 6]) {
      const p = ids(plan([words], [{ start: 4, end: 8 }], lc))
      for (const S of p) {
        const tl = p.map((t) => (t === S ? { ...t, text: 'X!', edited: true } : t))
        const merged = mergeManualTelops(
          tl,
          plan([words], [{ start: 4, end: 8 }], 14),
          new Set(),
          rememberEditedTelops(tl, undefined)
        )
        // 直した枚の文字だけが修正に替わる(隣の枚の言葉を取らない)
        const want = kanji(words.map((w) => w.text).join('')).filter(
          (c) => !kanji(S.text).includes(c)
        )
        expect(merged.filter((t) => !t.edited).flatMap((t) => kanji(t.text))).toEqual(want)
      }
    }
  })

  it('枚の境目で分かれた長さ 0 の言葉は、片方の枚を消しても残りの枚の文字は残る', () => {
    const words: W[] = [
      { text: '今日は', start: 1.0, end: 1.5 },
      { text: '一二三四五六七八', start: 2.0, end: 2.0 },
      { text: '配信', start: 2.5, end: 3.0 }
    ]
    const p = ids(plan([words], [{ start: 0, end: 4 }], 4))
    const t = p.find((x) => flat(x).includes('一'))!
    expect(flat(t)).not.toContain('八')
    const merged = mergeManualTelops(
      p.filter((x) => x !== t),
      plan([words], [{ start: 0, end: 4 }], 14),
      new Set([autoTelopKey(t)!])
    )
    // 長さ 0 の言葉の文字が同じ時刻だと、消した枚の範囲に言葉の残りまで入っていた
    expect(merged.map(flat).join('|')).toBe('五六七八配信')
  })
})

describe('狭い範囲', () => {
  it('狭い範囲(辞書で5文字に直した短い言葉の1文字の枚)を消しても、次の辞書の言葉は消えない', () => {
    // 範囲は文字の話している時刻だけで当てる(前の版の点の範囲とみなして辞書の言葉を丸ごと当てる規則が
    // あったときは、次の言葉「らた」→「太郎」まで消えていた)
    const words: W[] = [
      { text: '今日は', start: 1.0, end: 1.6 },
      { text: 'きむ', start: 2.0, end: 2.02 },
      { text: 'らた', start: 2.5, end: 2.9 }
    ]
    const dict = [
      { from: 'きむ', to: '木村一郎丸' },
      { from: 'らた', to: '太郎' }
    ]
    const a = plan([words], [{ start: 0, end: 4 }], 14, dict)
    const times = a[0].autoSource!.times!
    const k = [...flat(a[0])].indexOf('一')
    const key = `u:u0#0@${(times[k] - 0.002).toFixed(3)}-${(times[k] + 0.002).toFixed(3)}`
    const merged = mergeManualTelops([], a, new Set([key]))
    expect(merged.map(flat).join('|')).toBe('今日は木村|郎丸太郎')
  })
})

describe('切り分けた枚がみな 0.3 秒入らない元の枚', () => {
  it('入るいちばん長い長さでそろえる(声の時刻のままだと 0.02 秒の枚が残る)', () => {
    const mk = (text: string, a: number, b: number, chunk: number, times: number[]): Auto => ({
      text,
      startTime: a,
      endTime: b,
      style: defaultTextStyle(),
      source: 'auto',
      speaker: 'A',
      utteranceId: 'u0',
      utteranceChunk: chunk,
      autoSource: {
        start: a - 0.002,
        end: b + 0.002,
        text,
        times,
        offset: 0,
        durs: times.map(() => 0.02)
      }
    })
    const out = mergeManualTelops(
      [],
      [
        mk('今日は', 0, 1, 0, [0.2, 0.5, 0.8]),
        mk('一二三', 1, 1.5, 1, [1.01, 1.03, 1.46]),
        mk('配信', 1.5, 2.5, 2, [1.7, 2.2])
      ],
      new Set(),
      {
        'u:u0#1@1.020-1.040': {
          text: '二!',
          style: defaultTextStyle(),
          autoSource: { start: 1.02, end: 1.04, text: '二', times: [1.03], offset: 0 }
        } as never
      }
    )
    expect(out.map((t) => t.text)).toEqual(['今日は', '一', '二!', '三', '配信'])
    // 前後の枚に挟まれた 0.5 秒を3枚で等しく分ける
    for (const t of out.slice(1, 4)) expect(t.endTime - t.startTime).toBeCloseTo(0.5 / 3, 3)
  })
})

/** 長さ 0 の言葉を含む発話(同じ時刻の長さ 0 の言葉が続く・次の言葉が同じ時刻に始まる) */
const LAYOUTS: W[][] = [
  // 長さ 0 の言葉が前後の言葉の間に入りきらない(文字を 0.006 秒より詰める)
  [
    { text: '今日は', start: 1.0, end: 1.6 },
    { text: '一二三四五六', start: 1.6, end: 1.6 },
    { text: '七八九十', start: 1.6, end: 1.6 },
    { text: '配信', start: 1.6, end: 1.62 },
    { text: '丁丂', start: 1.62, end: 1.62 },
    { text: '书乩', start: 1.62, end: 1.64 },
    { text: 'します', start: 1.64, end: 2.2 }
  ],
  [
    { text: '今日は', start: 1.0, end: 1.5 },
    { text: '一二', start: 2.0, end: 2.0 },
    { text: '三四', start: 2.0, end: 2.0 },
    { text: '配信', start: 2.0, end: 2.6 },
    { text: 'します', start: 2.6, end: 3.0 }
  ],
  [
    { text: '今日は', start: 1.0, end: 1.6 },
    { text: '亐亓', start: 1.6, end: 1.6 },
    { text: '亖', start: 1.62, end: 1.62 },
    { text: '亙亜', start: 1.64, end: 2.2 },
    { text: 'ね', start: 2.2, end: 2.2 },
    { text: '习乣', start: 2.2, end: 2.2 },
    { text: 'まあ、', start: 2.2, end: 2.8 },
    { text: '書きます', start: 2.9, end: 3.5 }
  ],
  [
    { text: 'はい、', start: 0.8, end: 0.8 },
    { text: 'きむら', start: 0.8, end: 1.2 },
    { text: 'です', start: 1.2, end: 1.2 },
    { text: '丼丿', start: 1.22, end: 1.6 },
    { text: 'そう', start: 1.6, end: 1.6 },
    { text: '久么', start: 1.6, end: 1.6 },
    { text: '之乎', start: 1.6, end: 2.4 }
  ]
]

describe('長さ 0 の言葉を含む発話の枚を消した・直したまま、1行の長さを変えて作り直す', () => {
  for (const [li, words] of LAYOUTS.entries())
    for (const lc of [3, 4, 5, 6, 8])
      it(`発話${li}・1行${lc}文字`, () => {
        const dict = [{ from: 'きむら', to: '木村' }]
        const saved = ids(plan([words], [{ start: 0, end: 5 }], lc, dict))
        // 長さ 0 の言葉だけの短い枚(0.3 秒未満)は仮編集が出さない(仮編集の決まり)。比べるのは作り直した
        // 仮編集に出る言葉
        const bad: string[] = []
        for (const S of saved)
          for (const mode of ['dismiss', 'edit'] as const) {
            const tl =
              mode === 'dismiss'
                ? saved.filter((t) => t !== S)
                : saved.map((t) => (t === S ? { ...t, text: 'X!', edited: true } : t))
            const dis = new Set(mode === 'dismiss' ? [autoTelopKey(S)!] : [])
            for (const nlc of [3, 4, 14]) {
              const plain = plan([words], [{ start: 0, end: 5 }], nlc, dict)
              const merged = mergeManualTelops(tl, plain, dis, rememberEditedTelops(tl, undefined))
              // 消した・直した枚の漢字だけが消える・修正に替わる(隣の枚の言葉を取らない・2回出ない)。
              // 修正は1回だけ出る
              const shown = merged.filter((t) => !t.edited).flatMap((t) => kanji(t.text))
              const want = kanji(plain.map(flat).join('')).filter((c) => !kanji(S.text).includes(c))
              const edits = merged.filter((t) => t.edited).length
              const heard = kanji(S.text).some((c) => kanji(plain.map(flat).join('')).includes(c))
              if (shown.join('') !== want.join('') || edits !== (mode === 'edit' && heard ? 1 : 0))
                bad.push(
                  `${mode} [${flat(S)}] → ${nlc}: ${merged.map((t) => (t.edited ? '*' : '') + flat(t)).join('|')}`
                )
            }
          }
        expect(bad, saved.map(flat).join('|')).toEqual([])
      })
})

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
import { utteranceToTelopChunks } from '@shared/telop/fromTranscript'
import { TURN_RATE } from '@shared/diarize/micTurns'
import { defaultTextStyle } from '@shared/textStyle'
import type { MulticamInfo } from '@shared/sync/multicam'
import type { Project, TextOverlay } from '@shared/types'

/**
 * 仮編集の発言テロップの性質(人の修正なし。辞書・言いよどみ・句読点・ランダムなカット・1行の長さ)。
 * 言葉は1文字ずつどれも違う漢字(辞書で直した後の文字も違う字)にして、テロップの文字から元の言葉と
 * 話している時刻が分かるようにする。確かめること(除外なし):
 * - 聞こえる言葉(残した区間で話している言葉)の文字は、ちょうど1枚に1回出る。聞こえない言葉は出ない
 *   (仮編集の決まり: 残った長さが 0.3 秒未満の枚の切れ端は出さない — その枚の文字だけは問わない)
 * - 枚は、その文字を話し始めてから 0.15 秒より後に出ない・話し終わる 0.15 秒より前に消えない
 * 試す数は `TELOP_PLAN_SEEDS`(既定 300)
 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const info: MulticamInfo = {
  anchorSourceId: 'cam',
  sources: [
    { id: 'cam', name: '画面', kind: 'camera', cameraRole: 'screen' },
    { id: 'a', name: 'A', kind: 'mic' }
  ],
  files: [
    { assetId: 'C', sourceId: 'cam', start: 0, rate: 1, duration: 400 },
    { assetId: 'MA', sourceId: 'a', start: 0, rate: 1, duration: 400 }
  ]
}
const FILLERS = ['えー、', 'あのー、', 'えっと、', 'まあ、', 'えーと、']
/** 本当のかなの言葉(助詞・語尾など。言いよどみとして消さない) */
const PARTICLES = ['は', 'を', 'です', 'ね', 'から', 'そうですね', 'まま', 'あと']
const kanji = (s: string): string[] => [...s].filter((c) => /\p{Script=Han}/u.test(c))
/** 相づち・言いよどみに似た本当の言葉(言いよどみとして消さない) */
const REPLIES = ['そう', 'うん', 'ええ', 'あの', 'あと', 'まま', 'はい', 'えっ', 'そうそう']
/** テロップの言葉の印。漢字は1文字ずつどれも違う字。相づちだけの発話のテロップは「R:発話」 */
const toks = (t: { text: string; utteranceId?: string }): string[] => {
  const flat = t.text.replace(/[\s、。]/g, '')
  return [
    ...kanji(t.text),
    ...(t.utteranceId?.startsWith('r') && REPLIES.includes(flat) ? [`R:${t.utteranceId}`] : [])
  ]
}
type Word = { text: string; start: number; end: number }

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeProject(r: () => number) {
  let t = 1
  let code = 0x4e00
  let rep = 0x8a00
  const dict: { from: string; to: string }[] = []
  /** 文字 → 話している頭〜終わり(辞書で直した文字は、直す前の言葉を前から等分した分) */
  const voice = new Map<string, [number, number]>()
  /** 文字 → その文字の言葉(辞書で直した文字は直す前の言葉) */
  const wordOf = new Map<string, Word>()
  /** 相づちの発話 → その言葉 */
  const replyWord = new Map<string, Word>()
  const transcript: Project['transcript'] & object = []
  const replies = [...REPLIES].sort(() => r() - 0.5)
  for (let k = 0; k < 4; k++) {
    const n = 4 + Math.floor(r() * 10)
    const words: Word[] = []
    const push = (text: string, to = ''): void => {
      // 長さ 0 の言葉も混ぜる(Whisper の語の時刻は 0.02 秒刻みで、長さ 0 がよく出る)
      const d = r() < 0.08 ? 0 : (0.12 + r() * 0.2) * [...text].length * (r() < 0.2 ? 3 : 1)
      const word = { text, start: t, end: t + d }
      words.push(word)
      for (const c of [...text, ...to]) wordOf.set(c, word)
      const raw = kanji(text)
      const cs = [...text]
      cs.forEach((c, i) => voice.set(c, [t + (d * i) / cs.length, t + (d * (i + 1)) / cs.length]))
      if (to) {
        // 辞書の言葉は句読点の前の漢字だけ
        const ws = t
        const we = t + (d * raw.length) / cs.length
        ;[...to].forEach((c, i, all) =>
          voice.set(c, [ws + ((we - ws) * i) / all.length, ws + ((we - ws) * (i + 1)) / all.length])
        )
      }
      // 長さ 0 の言葉の次の言葉は、同じ時刻か 0.02 秒後に続くことが多い(文字を並べる余地が無い)
      t += d === 0 && r() < 0.6 ? (r() < 0.5 ? 0 : 0.02) : d + 0.02 + r() * (r() < 0.15 ? 1.2 : 0.2)
    }
    for (let i = 0; i < n; i++) {
      if (r() < 0.15) {
        const m = r() < 0.3 ? 3 : 1
        for (let q = 0; q < m; q++) push(FILLERS[Math.floor(r() * FILLERS.length)])
      }
      const len = 1 + Math.floor(r() * 3)
      let w = ''
      for (let c = 0; c < len; c++) {
        w += String.fromCodePoint(code)
        code += 3
      }
      let to = ''
      if (len >= 2 && r() < 0.3) {
        const L = 1 + Math.floor(r() * 9)
        for (let c = 0; c < L; c++) to += String.fromCodePoint(rep++)
        dict.push({ from: w, to })
      }
      if (r() < 0.25) w += r() < 0.5 ? '、' : '。'
      push(w, to)
      // 助詞・語尾(かな)と、その後の文の途中の言いよどみ
      if (r() < 0.15) {
        push(PARTICLES[Math.floor(r() * PARTICLES.length)])
        if (r() < 0.4) push(FILLERS[Math.floor(r() * FILLERS.length)])
      }
    }
    t += 1 + r() * 2
    transcript.push({
      id: `u${k}`,
      assetId: 'MA',
      speaker: 'A',
      sourceStart: words[0].start,
      sourceEnd: words[words.length - 1].end,
      text: words.map((w) => w.text).join(''),
      words,
      overlap: false
    })
    if (replies.length > 0 && r() < 0.4) {
      const text = replies.pop()! + (r() < 0.2 ? '、' : '')
      const d = r() < 0.3 ? 0 : 0.2 + r() * 0.5
      const word = { text, start: t, end: t + d }
      replyWord.set(`r${k}`, word)
      transcript.push({
        id: `r${k}`,
        assetId: 'MA',
        speaker: 'A',
        sourceStart: t,
        sourceEnd: t + d,
        text,
        words: [word],
        overlap: false
      })
      t += d + 1 + r() * 2
    }
  }
  const activity = new Uint8Array(400 * TURN_RATE)
  for (const u of transcript)
    activity.fill(1, Math.floor(u.sourceStart * TURN_RATE), Math.ceil(u.sourceEnd * TURN_RATE))
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
  return { project, total: t, activity, dict, voice, wordOf, replyWord }
}

describe('仮編集の発言テロップの性質(辞書・言いよどみ・ランダムなカット)', () => {
  it(
    '聞こえる言葉はちょうど1回、声に遅れず・声より早く消えない',
    async () => {
      const N = Number(process.env.TELOP_PLAN_SEEDS ?? 300)
      const fails: string[] = []
      let telopCount = 0
      // 既定の数より後で見つかった通り(いつも回す)。3729: 辞書で長くして分けた枚の言葉がカットに掛かり、
      // 落としていない側へ続く言葉の真ん中を残した区間の中とみなして、声が区間の外の文字まで出た
      const FIXED_SEEDS = [3729]
      for (const seed of [
        ...Array.from({ length: N }, (_, i) => i + 1),
        ...FIXED_SEEDS.filter((x) => x > N)
      ]) {
        // 長く続けて回すとテストの作業スレッドが応答できなくなるので、ときどき空ける
        if (seed % 100 === 0) await new Promise((r) => setTimeout(r, 0))
        const r = rng(seed * 104729)
        const p = makeProject(r)
        for (let step = 0; step < 4; step++) {
          const n = 1 + Math.floor(r() * 3)
          const cuts = Array.from({ length: n * 2 }, () => r() * p.total).sort((a, b) => a - b)
          const scenes = Array.from({ length: n }, (_, i) => ({
            id: `s${i}`,
            start: cuts[i * 2],
            end: Math.max(cuts[i * 2] + 0.5, cuts[i * 2 + 1]),
            lines: [],
            speech: 0
          }))
          const lineChars = 4 + Math.floor(r() * 12)
          const res = planRoughCut(
            p.project,
            info,
            scenes,
            scenes.map((s) => ({
              sceneId: s.id,
              score: 100,
              kind: 'highlight' as const,
              reason: ''
            })),
            p.activity,
            {
              targetSec: 0,
              keep: Object.fromEntries(scenes.map((s) => [s.id, true])),
              styles: [],
              speechLook: { style: defaultTextStyle() },
              kind: 'game',
              policy: 'light',
              dictionary: p.dict,
              style: { telopLineChars: lineChars } as never
            }
          )
          const tag = `seed${seed}/step${step}`
          const telops = res.telops as Omit<TextOverlay, 'id'>[]
          const spans = res.cut.spans
          telopCount += telops.length
          const show = (): string => telops.map((t) => t.text.replace(/\n/g, '')).join(' | ')
          // 出た回数
          const count = new Map<string, number>()
          for (const t of telops) for (const c of toks(t)) count.set(c, (count.get(c) ?? 0) + 1)
          for (const [c, k] of count) if (k > 1) fails.push(`${tag} 「${c}」x${k} :: ${show()}`)
          // 聞こえる文字(枚ごとに、0.3 秒以上残る区間で話している文字)
          const inSpan = (x: number): boolean =>
            spans.some((sp) => x >= sp.start - 1e-6 && x < sp.end)
          const expected = new Set<string>()
          const excused = new Set<string>()
          for (const u of p.project.transcript ?? []) {
            for (const ch of utteranceToTelopChunks(u, {
              dictionary: p.dict,
              maxLineChars: lineChars
            })) {
              const longEnough = spans.filter(
                (sp) => Math.min(ch.sourceEnd, sp.end) - Math.max(ch.sourceStart, sp.start) >= 0.3
              )
              for (const c of toks({ text: ch.text, utteranceId: u.id })) {
                // 言葉の真ん中が残した区間に入る言葉が聞こえる(辞書で直した文字は直す前の言葉で見る)
                const w = c.startsWith('R:') ? p.replyWord.get(u.id)! : p.wordOf.get(c)!
                const mid = (w.start + w.end) / 2
                if (!inSpan(mid)) {
                  // 言葉がカットに掛かり、言葉の途中で分けた枚(辞書で長くなって分けた枚・言葉の途中で区切った枚)が
                  // まるごと残った所: その枚の文字の声は残した区間で聞こえるので、出てもよい(出なくてもよい)
                  const v = p.voice.get(c) ?? [w.start, w.end]
                  if (spans.some((sp) => v[0] < sp.end && v[1] > sp.start)) excused.add(c)
                  continue
                }
                if (longEnough.some((sp) => mid >= sp.start - 1e-6 && mid < sp.end)) expected.add(c)
                else excused.add(c)
              }
            }
          }
          for (const c of expected)
            if ((count.get(c) ?? 0) !== 1) fails.push(`${tag} 「${c}」が出ない :: ${show()}`)
          for (const c of count.keys())
            if (!expected.has(c) && !excused.has(c))
              fails.push(`${tag} 聞こえない「${c}」が出た :: ${show()}`)
          // 時刻: 文字の声(その枚の区間の中)に対して
          for (const t of telops) {
            const mid = (t.startTime + t.endTime) / 2
            const sp = spans.find(
              (s) => mid >= s.timeline - 1e-6 && mid <= s.timeline + (s.end - s.start) + 1e-6
            )
            if (!sp) continue
            let lo = Infinity
            let hi = -Infinity
            for (const c of kanji(t.text)) {
              const v = p.voice.get(c)
              if (!v) continue
              const a = Math.max(v[0], sp.start)
              const b = Math.min(v[1], sp.end)
              if (b <= a) continue
              lo = Math.min(lo, sp.timeline + a - sp.start)
              hi = Math.max(hi, sp.timeline + b - sp.start)
            }
            if (!(lo < hi)) continue
            if (t.startTime - lo > 0.15)
              fails.push(
                `${tag} ${t.text.replace(/\n/g, '')} 遅れ ${(t.startTime - lo).toFixed(3)}s`
              )
            if (hi - t.endTime > 0.15)
              fails.push(
                `${tag} ${t.text.replace(/\n/g, '')} 早く消える ${(hi - t.endTime).toFixed(3)}s`
              )
          }
        }
      }
      if (fails.length > 0) console.log(`${fails.length} fails\n${fails.slice(0, 12).join('\n')}`)
      expect(fails).toEqual([])
      expect(telopCount).toBeGreaterThan(N * 4)
    },
    Math.max(120000, Number(process.env.TELOP_PLAN_SEEDS ?? 300) * 100)
  )
})

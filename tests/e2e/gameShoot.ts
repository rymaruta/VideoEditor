import { writeFileSync } from 'fs'

/**
 * ゲーム実況の受け入れテストの素材づくり(正解の分かる台本と音)。
 * 声: 普段の話し声の中に、時刻を決めて叫び(普段より 12dB 大きい)を入れる。
 * ゲーム音: ずっと鳴っている環境音と、時刻を決めた爆発音(大きい)。
 */

export const FS = 48000
export const DURATION = 480

export function hashNoise(i: number, seed: number): number {
  let x = (Math.imul(i | 0, 374761393) + Math.imul(seed, 668265263)) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  x ^= x >>> 16
  return ((x >>> 0) / 4294967296) * 2 - 1
}
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

export interface Line {
  text: string
  start: number
  end: number
  /** 叫び(普段より大きい声) */
  shout: boolean
}

const CALM = [
  'ここは右に行こうかな',
  'アイテムを拾っておきます',
  'この敵は弱いですね',
  'ちょっと回復しよう',
  '次のステージですね',
  '地図を見てみます'
]
const SHOUTS = ['うわああ!', 'やばいやばい!', '死んだ!', 'まじか!', 'きたー!', 'ちょっと待って!']
const FRIEND = ['それ取って', 'こっち来て', 'いいね', 'なるほど', '後ろにいるよ']

/** 黙々とプレイする所(声の無い区間) */
export const QUIET: [number, number][] = [
  [100, 140],
  [250, 290],
  [380, 420]
]
/** 叫びを入れる時刻(山) */
export const HYPE_AT = [30, 62, 175, 205, 230, 320, 350, 450]
/** 声の無い所で鳴る、ゲームの爆発音 */
export const EXPLOSIONS = [110, 125, 265, 400]
/**
 * 落ち着いた解説の最中に続けて鳴る大きなゲーム音(1本の音では声の盛り上がりと見分けにくい。トラック別なら数えない)。
 * 叫びの無い発話のうち、目安の時刻に一番近いものの頭から 0.3 秒後に鳴らす
 */
export function explosionsDuringTalk(lines: readonly Line[]): number[] {
  return [15, 85, 300, 440].map((target) => {
    const calm = lines
      .filter((l) => !l.shout && !lines.some((x) => x.shout && Math.abs(x.start - l.start) < 20))
      .sort((a, b) => Math.abs(a.start - target) - Math.abs(b.start - target))[0]
    return Math.round((calm.start + 0.3) * 100) / 100
  })
}
/** 笑い(音声イベントの決まった答え) */
export const LAUGH_AT = [205]

export function makeScript(): Line[] {
  const r = rng(20261007)
  const lines: Line[] = []
  let t = 3
  while (t < DURATION - 6) {
    const quiet = QUIET.find(([a, b]) => t >= a - 1 && t < b)
    if (quiet) {
      t = quiet[1] + 1
      continue
    }
    const hype = HYPE_AT.find(
      (h) => Math.abs(h - t) < 2.5 && !lines.some((l) => l.shout && Math.abs(l.start - h) < 3)
    )
    if (hype !== undefined) {
      const len = 1.2 + r() * 0.6
      lines.push({
        text: SHOUTS[lines.length % SHOUTS.length],
        start: hype,
        end: hype + len,
        shout: true
      })
      t = hype + len + 0.6 + r() * 0.6
      continue
    }
    const len = 1.6 + r() * 1.8
    const end = Math.min(t + len, ...QUIET.map(([a]) => (a > t ? a - 0.5 : Infinity)))
    if (end - t >= 0.8)
      lines.push({ text: CALM[lines.length % CALM.length], start: t, end, shout: false })
    t = end + 0.5 + r() * 1.2
  }
  return lines.sort((a, b) => a.start - b.start)
}

/** コラボ相手(Discord)の発話: 実況者の発話の合間に、落ち着いた声で */
export function makeFriendScript(main: readonly Line[]): Line[] {
  const out: Line[] = []
  for (let i = 0; i + 1 < main.length; i++) {
    const gapStart = main[i].end + 0.1
    const gapEnd = main[i + 1].start - 0.1
    if (gapEnd - gapStart < 0.6 || QUIET.some(([a, b]) => gapStart < b && gapEnd > a)) continue
    out.push({
      text: FRIEND[out.length % FRIEND.length],
      start: gapStart,
      end: gapStart + Math.min(1.4, gapEnd - gapStart),
      shout: false
    })
  }
  return out
}

/** 声(f0 の倍音 + 母音らしいフォルマント)。`offset` 秒だけ後ろへずらして書く */
export function renderVoice(lines: readonly Line[], f0Calm: number, offset = 0): Float32Array {
  const out = new Float32Array((DURATION + Math.max(0, offset)) * FS)
  for (const l of lines) {
    const a = Math.floor((l.start + offset) * FS)
    const b = Math.ceil((l.end + offset) * FS)
    if (a < 0 || b > out.length) continue
    const len = l.end - l.start
    const gain = l.shout ? 0.32 : 0.08 // 叫びは普段の 4 倍(+12dB)
    const f0 = l.shout ? f0Calm * 1.85 : f0Calm
    const formant = 600 + (hashNoise(a, 9) + 1) * 300
    for (let i = a; i < b; i++) {
      const tau = (i - a) / FS
      const env =
        Math.min(1, tau / 0.03, (len - tau) / 0.05) *
        (0.65 + 0.35 * Math.cos(2 * Math.PI * 5 * tau))
      if (env <= 0) continue
      const ph = 2 * Math.PI * f0 * tau
      let v = 0
      for (let k = 1; k <= 10; k++)
        v += (1 / (1 + ((f0 * k - formant) / 400) ** 2) + 0.3 / k) * Math.sin(k * ph)
      out[i] += gain * env * v
    }
  }
  return out
}

/** ゲーム音: 環境音 + 爆発音 */
export function renderGame(
  explosions: readonly number[],
  /** 続けて鳴る大きな音(銃撃・ボス戦の音楽。2 秒) */
  barrages: readonly number[] = []
): Float32Array {
  const n = DURATION * FS
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++)
    out[i] = 0.02 * hashNoise(i, 11) + 0.01 * Math.sin((2 * Math.PI * 110 * i) / FS)
  // ゲームの爆発音は低い音が多い(白色雑音のままだと、8kHz で読む音の大きさにほとんど入らない)。
  // 1次のローパス(約 800Hz)を掛け、大きさを戻す
  const low = (a: number, len: number, seed: number, amp: (i: number) => number): void => {
    let y = 0
    for (let i = 0; i < len; i++) {
      y += 0.1 * (hashNoise(a + i, seed) - y)
      out[a + i] += 4 * y * amp(i)
    }
  }
  for (const at of explosions) low(at * FS, 1.5 * FS, 13, (i) => 0.6 * Math.exp(-i / (0.4 * FS)))
  for (const at of barrages)
    low(
      Math.round(at * FS),
      2 * FS,
      17,
      (i) => 0.9 * (0.6 + 0.4 * Math.sin((2 * Math.PI * 12 * i) / FS))
    )
  return out
}

/** 足し合わせて -1〜1 に収める(長さは最初のものに合わせる) */
export function mix(...tracks: Float32Array[]): Float32Array {
  const out = new Float32Array(tracks[0].length)
  for (const t of tracks) for (let i = 0; i < out.length && i < t.length; i++) out[i] += t[i]
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i]))
  return out
}

export function writeWav(path: string, samples: Float32Array): void {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(FS, 24)
  buf.writeUInt32LE(FS * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  writeFileSync(path, buf)
}

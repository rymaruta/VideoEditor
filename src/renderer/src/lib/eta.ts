/**
 * 残り時間の目安(ミリ秒)。ここまでの進み方がこのまま続くとして見積もる。
 * 始まった直後・進み具合が小さいうちは当てにならないので出さない(null)。
 *
 * `basePercent` は数え始めた時点の進み具合。工程の途中で段階が変わって進み具合が
 * 0 に戻る(読み込み → 解析など)ので、「startedAt から 0→100」とは限らない。
 */
export function remainingMs(
  startedAt: number | undefined,
  percent: number,
  now: number,
  basePercent = 0
): number | null {
  if (startedAt === undefined || !Number.isFinite(percent) || !Number.isFinite(basePercent))
    return null
  const elapsed = now - startedAt
  const progressed = percent - basePercent
  if (elapsed < 5000 || progressed < 10 || percent >= 100) return null
  return (elapsed * (100 - percent)) / progressed
}

/** 段階の見分けに使う、メモから数字・区切りを除いたもの(「3/10 枚」と「4/10 枚」は同じ段階) */
export function noteStage(note: string | undefined): string {
  return (note ?? '').replace(/[\d.,/%:・·()()\s]+/g, '')
}

/** 見積もりの起点。段階が変わる・進み具合が戻るたびに取り直す */
export interface EtaBaseline {
  startedAt: number | undefined
  stage: string
  basePercent: number
  baseTime: number
  lastPercent: number
}

export interface EtaInput {
  startedAt?: number
  percent: number
  note?: string
}

/** 起点を更新する。新しい回(startedAt が変わった)・段階が変わった・進み具合が戻ったら取り直す */
export function nextEtaBaseline(
  prev: EtaBaseline | undefined,
  input: EtaInput,
  now: number
): EtaBaseline {
  const stage = noteStage(input.note)
  const percent = Number.isFinite(input.percent) ? input.percent : 0
  if (
    !prev ||
    prev.startedAt !== input.startedAt ||
    prev.stage !== stage ||
    percent < prev.lastPercent
  ) {
    return {
      startedAt: input.startedAt,
      stage,
      basePercent: percent,
      baseTime: now,
      lastPercent: percent
    }
  }
  return { ...prev, lastPercent: percent }
}

/**
 * 工程ごとに起点を覚えて残り時間を見積もる。描画のたびに呼んでよい。
 * メモがすでに「残り約…」を出している工程(文字起こしなど、自前で見積もれる所)は二重に出さない。
 */
export function createEtaTracker(): {
  estimate: (key: string, input: EtaInput, now: number) => number | null
  reset: (key: string) => void
} {
  const baselines = new Map<string, EtaBaseline>()
  return {
    estimate(key, input, now) {
      const base = nextEtaBaseline(baselines.get(key), input, now)
      baselines.set(key, base)
      if (input.startedAt === undefined) return null
      if (input.note?.includes('残り')) return null
      return remainingMs(base.baseTime, input.percent, now, base.basePercent)
    },
    reset(key) {
      baselines.delete(key)
    }
  }
}

/** 「残り約3分」などの表示(1分未満は「まもなく」) */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return 'まもなく'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `残り約${min}分`
  const h = Math.floor(min / 60)
  const m = min % 60
  return `残り約${h}時間${m > 0 ? `${m}分` : ''}`
}

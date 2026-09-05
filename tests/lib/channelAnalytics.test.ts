import { describe, expect, it } from 'vitest'
import {
  JST_OFFSET_HOURS,
  MATURITY_DAYS,
  MIN_SAMPLE,
  TREND_WINDOW_DAYS,
  analyzeChannelVideos,
  viewsPerSubscriber
} from '@renderer/lib/channelAnalytics'
import type { SourceVideo } from '@renderer/lib/videoMetrics'
import { NASTY_VALUES, fuzzNumber, seeded } from '../helpers/boundary'

const NOW = Date.parse('2026-09-05T12:00:00Z')
/** 経過日数から公開日時を作る。日付にできない値は「読めない日付」として渡す */
const daysAgo = (d: number): string =>
  Number.isFinite(d) ? new Date(NOW - d * 86_400_000).toISOString() : '読めない日付'

let serial = 0
function v(over: Partial<SourceVideo> & { ageDays?: number } = {}): SourceVideo {
  serial += 1
  return {
    id: over.id ?? `v${serial}`,
    title: over.title ?? `動画${serial}`,
    channelTitle: over.channelTitle ?? 'ch',
    viewCount: over.viewCount ?? 1000,
    publishedAt: over.publishedAt ?? daysAgo(over.ageDays ?? 30),
    durationSeconds: over.durationSeconds ?? 600
  }
}

/** 成熟した長尺を n 本。再生数は与えた配列のとおり */
function matureLong(views: number[]): SourceVideo[] {
  return views.map((viewCount, i) => v({ viewCount, ageDays: MATURITY_DAYS + 1 + i }))
}

describe('analyzeChannelVideos — 平常運転の基準', () => {
  it('基準は「公開から14日以上経った動画」の中央値', () => {
    const a = analyzeChannelVideos(matureLong([100, 200, 300, 400, 500]), NOW)
    expect(a.long.baselineViews).toBe(300)
    expect(a.long.matureCount).toBe(5)
  })

  it('【この回の主題】まだ伸びている途中の動画は基準に入れない', () => {
    // 出したばかりの動画を基準に混ぜると平常運転が低く出て、
    // 過去の動画が軒並み「平常より回った」ことになる
    const videos = [...matureLong([1000, 1000, 1000, 1000]), v({ viewCount: 10, ageDays: 1 })]
    const a = analyzeChannelVideos(videos, NOW)
    expect(a.long.baselineViews).toBe(1000)
    expect(a.long.matureCount).toBe(4)
    expect(a.long.count).toBe(5)
  })

  it('標本が足りなければ基準を作らない(0ではなく null)', () => {
    const a = analyzeChannelVideos(matureLong([100, 200, 300]), NOW)
    expect(MIN_SAMPLE).toBe(4)
    expect(a.long.baselineViews).toBeNull()
    // 基準が無ければ平常比も出さない
    expect(a.rated.every((r) => r.performanceRatio === null)).toBe(true)
  })

  it('平常比は「再生数 ÷ 同じ形式の平常運転」', () => {
    const a = analyzeChannelVideos(matureLong([100, 100, 100, 100, 400]), NOW)
    expect(a.long.baselineViews).toBe(100)
    const four = a.rated.find((r) => r.video.viewCount === 400)
    expect(four?.performanceRatio).toBe(4)
  })

  it('未成熟な動画には平常比を出さない', () => {
    const videos = [...matureLong([100, 100, 100, 100]), v({ viewCount: 500, ageDays: 3 })]
    const a = analyzeChannelVideos(videos, NOW)
    const fresh = a.rated.find((r) => r.video.viewCount === 500)
    expect(fresh?.performanceRatio).toBeNull()
    expect(fresh?.mature).toBe(false)
    // 代わりに「直近」として速度順に出る
    expect(a.recent.map((r) => r.video.viewCount)).toContain(500)
  })

  it('【この回の主題】ショートと長尺は別の基準で測る', () => {
    // ショートは桁が違う。混ぜて1つの基準にすると、長尺が全部「不振」になる
    const videos = [
      ...matureLong([1000, 1000, 1000, 1000]),
      ...[50000, 50000, 50000, 50000].map((viewCount, i) =>
        v({ viewCount, durationSeconds: 30, ageDays: MATURITY_DAYS + 1 + i })
      )
    ]
    const a = analyzeChannelVideos(videos, NOW)
    expect(a.long.baselineViews).toBe(1000)
    expect(a.shorts.baselineViews).toBe(50000)
    expect(a.rated.every((r) => r.performanceRatio === 1)).toBe(true)
  })

  it('新しい順に並ぶ', () => {
    const a = analyzeChannelVideos(
      [v({ id: 'old', ageDays: 100 }), v({ id: 'new', ageDays: 1 }), v({ id: 'mid', ageDays: 50 })],
      NOW
    )
    expect(a.rated.map((r) => r.video.id)).toEqual(['new', 'mid', 'old'])
  })

  it('当たり動画は平常比の高い順、不振は低い順', () => {
    const a = analyzeChannelVideos(
      matureLong([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]),
      NOW
    )
    expect(a.hits[0].video.viewCount).toBe(1000)
    expect(a.misses[0].video.viewCount).toBe(100)
  })

  it('【この回の主題】上位と下位に同じ動画を出さない', () => {
    // 成熟が5本しかないのに「上位5本」「下位5本」を出すと、全部が両方に載る
    const a = analyzeChannelVideos(matureLong([100, 200, 300, 400, 500]), NOW)
    const hitIds = new Set(a.hits.map((r) => r.video.id))
    expect(a.hits.length).toBe(2)
    expect(a.misses.length).toBe(2)
    expect(a.misses.some((r) => hitIds.has(r.video.id))).toBe(false)
  })

  it('成熟が少なすぎれば、当たりも不振も出さない', () => {
    const a = analyzeChannelVideos(matureLong([100, 200, 300]), NOW)
    expect(a.hits).toEqual([])
    expect(a.misses).toEqual([])
  })
})

describe('analyzeChannelVideos — 期間と頻度', () => {
  it('投稿頻度は直近90日で測る', () => {
    // 90日で30本 → 週2.33本
    const videos = Array.from({ length: 30 }, (_, i) => v({ ageDays: i * 3 }))
    const a = analyzeChannelVideos(videos, NOW)
    expect(a.uploadsPerWeek).not.toBeNull()
    expect(a.uploadsPerWeek as number).toBeCloseTo((30 / 87) * 7, 5)
  })

  it('【この回の主題】投稿が止まったチャンネルを「週3本出している」と言わない', () => {
    // 100〜200日前に毎日投稿、直近90日は0本。全期間の平均なら週7本近くになるが、
    // いまの投稿頻度は0本。頻度は必ず直近の窓で測る
    const videos = Array.from({ length: 100 }, (_, i) => v({ ageDays: 100 + i }))
    const a = analyzeChannelVideos(videos, NOW)
    expect(a.uploadsPerWeek).toBe(0)
  })

  it('期間が1週間に満たなければ頻度は測らない', () => {
    const a = analyzeChannelVideos([v({ ageDays: 0 }), v({ ageDays: 2 })], NOW)
    expect(a.uploadsPerWeek).toBeNull()
  })

  it('1本だけなら期間も出せない', () => {
    const a = analyzeChannelVideos([v({ ageDays: 5 })], NOW)
    expect(a.windowDays).toBeNull()
    expect(a.newestHoursAgo).toBeCloseTo(120, 5)
  })
})

describe('analyzeChannelVideos — 日本時間での集計', () => {
  it('【この回の主題】月と曜日は日本時間で数える', () => {
    // UTC 3月31日 23:00 は日本時間で 4月1日 8:00。UTCのまま数えると
    // 「3月の投稿」に化け、深夜投稿が前日に寄る
    expect(JST_OFFSET_HOURS).toBe(9)
    const a = analyzeChannelVideos(
      [v({ publishedAt: '2026-03-31T23:00:00Z', viewCount: 100 })],
      Date.parse('2026-09-05T12:00:00Z')
    )
    expect(a.monthly.map((m) => m.month)).toEqual(['2026-04'])
  })

  it('曜日は本数が3本に満たなければ数字を出さない(1本の当たりで「金曜が強い」を作らない)', () => {
    // 7の倍数の日数だけずらすと同じ曜日に揃う。4本の曜日と2本の曜日を作る
    const four = [21, 28, 35, 42].map((ageDays) => v({ viewCount: 1000, ageDays }))
    const two = [20, 27].map((ageDays) => v({ viewCount: 1000, ageDays }))
    const a = analyzeChannelVideos([...four, ...two], NOW)
    const busy = a.weekdays.find((w) => w.count === 4)
    const thin = a.weekdays.find((w) => w.count === 2)
    expect(busy?.medianRatio).not.toBeNull()
    expect(thin?.medianRatio).toBeNull()
  })

  it('曜日は7つ全部が返る(欠けた曜日も「データなし」として並ぶ)', () => {
    const a = analyzeChannelVideos(matureLong([100, 100, 100, 100]), NOW)
    expect(a.weekdays.map((w) => w.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

describe('analyzeChannelVideos — タイトルの型', () => {
  it('両側4本以上そろった型だけを出す', () => {
    const withNumber = [1, 2, 3, 4].map((i) =>
      v({ title: `検証${i}回やってみた`, viewCount: 2000, ageDays: MATURITY_DAYS + i })
    )
    const withoutNumber = [1, 2, 3, 4].map((i) =>
      v({ title: 'ふつうの動画', viewCount: 1000, ageDays: MATURITY_DAYS + 10 + i })
    )
    const a = analyzeChannelVideos([...withNumber, ...withoutNumber], NOW)
    const numberPattern = a.titlePatterns.find((p) => p.key === 'number')
    expect(numberPattern).toBeDefined()
    expect(numberPattern?.withCount).toBe(4)
    expect(numberPattern?.medianRatioWith).toBeGreaterThan(
      numberPattern?.medianRatioWithout as number
    )
  })

  it('片側の本数が足りない型は出さない(1本の当たりで「法則」を作らない)', () => {
    const videos = [
      v({ title: '【企画】たったひとつ', viewCount: 9000, ageDays: 20 }),
      ...matureLong([1000, 1000, 1000, 1000])
    ]
    const a = analyzeChannelVideos(videos, NOW)
    expect(a.titlePatterns.find((p) => p.key === 'bracket')).toBeUndefined()
  })
})

describe('analyzeChannelVideos — 伸びの推移', () => {
  it('成熟した動画どうしを、同じ長さの2つの窓で比べる', () => {
    const recent = [1, 2, 3, 4].map((i) => v({ viewCount: 2000, ageDays: MATURITY_DAYS + i }))
    const previous = [1, 2, 3, 4].map((i) =>
      v({ viewCount: 1000, ageDays: MATURITY_DAYS + TREND_WINDOW_DAYS + i })
    )
    const a = analyzeChannelVideos([...recent, ...previous], NOW)
    expect(a.trend.recentMedianViews).toBe(2000)
    expect(a.trend.previousMedianViews).toBe(1000)
    expect(a.trend.changeRatio).toBe(2)
  })

  it('どちらかの窓の本数が足りなければ比べない', () => {
    const a = analyzeChannelVideos(matureLong([1000, 1000, 1000, 1000]), NOW)
    expect(a.trend.changeRatio).toBeNull()
  })
})

describe('viewsPerSubscriber — 規模が違っても比べられる数字', () => {
  it('平常運転 ÷ 登録者数', () => {
    const a = analyzeChannelVideos(matureLong([1000, 1000, 1000, 1000]), NOW)
    expect(viewsPerSubscriber(a, 10000, false)).toBeCloseTo(0.1, 9)
  })

  it('登録者を非公開にしているチャンネルでは出さない', () => {
    const a = analyzeChannelVideos(matureLong([1000, 1000, 1000, 1000]), NOW)
    expect(viewsPerSubscriber(a, 10000, true)).toBeNull()
    expect(viewsPerSubscriber(a, 0, false)).toBeNull()
  })

  it('【この回の主題】基準にするのは本数の多い形式', () => {
    // ショート中心のチャンネルで、たまたま出した長尺の基準を使うと実態とずれる
    const shorts = Array.from({ length: 10 }, (_, i) =>
      v({ viewCount: 5000, durationSeconds: 30, ageDays: MATURITY_DAYS + i })
    )
    const longs = Array.from({ length: 4 }, (_, i) =>
      v({ viewCount: 100000, ageDays: MATURITY_DAYS + 40 + i })
    )
    const a = analyzeChannelVideos([...shorts, ...longs], NOW)
    expect(viewsPerSubscriber(a, 50000, false)).toBeCloseTo(0.1, 9)
  })

  it('長尺が無ければショートの基準を使う', () => {
    const shorts = [1, 2, 3, 4].map((i) =>
      v({ viewCount: 5000, durationSeconds: 30, ageDays: MATURITY_DAYS + i })
    )
    const a = analyzeChannelVideos(shorts, NOW)
    expect(viewsPerSubscriber(a, 50000, false)).toBeCloseTo(0.1, 9)
  })
})

describe('analyzeChannelVideos — 壊れた入力', () => {
  it('空でも落ちない', () => {
    const a = analyzeChannelVideos([], NOW)
    expect(a.analyzedCount).toBe(0)
    expect(a.long.baselineViews).toBeNull()
    expect(a.monthly).toEqual([])
  })

  it('null・欠けた欄・読めない日付が混ざっても落ちない', () => {
    const dirty = [
      null,
      undefined,
      {},
      { id: 'x' },
      v({ publishedAt: 'きのう' }),
      v({ viewCount: NaN }),
      v({ durationSeconds: Infinity })
    ] as unknown as SourceVideo[]
    expect(() => analyzeChannelVideos(dirty, NOW)).not.toThrow()
    const a = analyzeChannelVideos(dirty, NOW)
    for (const r of a.rated) {
      expect(Number.isFinite(r.video.viewCount)).toBe(true)
      expect(r.performanceRatio === null || Number.isFinite(r.performanceRatio)).toBe(true)
    }
  })

  it('何を渡しても落ちない', () => {
    for (const value of NASTY_VALUES) {
      expect(() => analyzeChannelVideos(value as SourceVideo[], NOW)).not.toThrow()
    }
  })

  it('【不変条件】どんな入力でも、出る数はすべて有限', () => {
    const rnd = seeded(20260905)
    for (let round = 0; round < 200; round++) {
      const videos = Array.from({ length: Math.floor(rnd() * 30) }, () =>
        v({
          viewCount: fuzzNumber(rnd, -100, 5_000_000),
          ageDays: fuzzNumber(rnd, -10, 900),
          durationSeconds: fuzzNumber(rnd, -10, 4000)
        })
      )
      const a = analyzeChannelVideos(videos, NOW)
      expect(Number.isFinite(a.shorts.medianViews)).toBe(true)
      expect(Number.isFinite(a.long.medianViews)).toBe(true)
      expect(a.uploadsPerWeek === null || Number.isFinite(a.uploadsPerWeek)).toBe(true)
      expect(a.windowDays === null || Number.isFinite(a.windowDays)).toBe(true)
      for (const r of a.rated) {
        expect(r.performanceRatio === null || Number.isFinite(r.performanceRatio)).toBe(true)
      }
    }
  })

  it('同じ入力からは必ず同じ結果(順位も並びも)', () => {
    const videos = matureLong([100, 500, 500, 900, 200])
    const a = analyzeChannelVideos(videos, NOW)
    const b = analyzeChannelVideos(videos, NOW)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

import { describe, expect, it } from 'vitest'
import {
  MIN_VELOCITY_HOURS,
  hoursSincePublished,
  measureVideo,
  median,
  viewsPerHour,
  SHORTS_MAX_SECONDS
} from '@renderer/lib/videoMetrics'
import { NASTY_NUMBERS, NASTY_VALUES, seeded } from '../helpers/boundary'

const NOW = Date.parse('2026-09-05T12:00:00Z')
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString()

describe('median — 平均ではなく中央値で測る', () => {
  it('空なら0', () => {
    expect(median([])).toBe(0)
  })

  it('奇数個は真ん中', () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it('偶数個は真ん中2つの平均', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })

  it('1本だけ跳ねた値に引きずられない(平均との違い)', () => {
    // 平均なら 250250 になる。中央値は 500 のまま
    expect(median([400, 500, 600, 1000000])).toBe(550)
  })

  it('有限でない値は数える前に捨てる', () => {
    expect(median([NaN, Infinity, -Infinity, 2, 4])).toBe(3)
  })

  it('渡した配列を並べ替えない(呼び出し側の順序を壊さない)', () => {
    const values = [3, 1, 2]
    median(values)
    expect(values).toEqual([3, 1, 2])
  })

  it('境界値だけを渡しても落ちない', () => {
    expect(() => median([...NASTY_NUMBERS])).not.toThrow()
    expect(Number.isFinite(median([...NASTY_NUMBERS]))).toBe(true)
  })
})

describe('hoursSincePublished — 公開からの経過時間', () => {
  it('素直な差を時間で返す', () => {
    expect(hoursSincePublished(hoursAgo(5), NOW)).toBeCloseTo(5, 9)
  })

  it('読めない日付は null(0時間ではない——0にすると「たった今」として満点になる)', () => {
    expect(hoursSincePublished('', NOW)).toBeNull()
    expect(hoursSincePublished('きのう', NOW)).toBeNull()
    expect(hoursSincePublished(undefined as unknown as string, NOW)).toBeNull()
  })

  it('現在時刻が数でなければ null', () => {
    expect(hoursSincePublished(hoursAgo(5), NaN)).toBeNull()
    expect(hoursSincePublished(hoursAgo(5), Infinity)).toBeNull()
  })

  it('端末の時計が進んでいて未来の公開日でも、負を返さず0に丸める', () => {
    expect(hoursSincePublished(hoursAgo(-10), NOW)).toBe(0)
  })

  it('何を渡しても落ちない', () => {
    for (const v of NASTY_VALUES) {
      for (const n of NASTY_NUMBERS) {
        expect(() => hoursSincePublished(v as string, n)).not.toThrow()
      }
    }
  })
})

describe('viewsPerHour — 「今」伸びているかの尺度', () => {
  it('経過時間で割る', () => {
    expect(viewsPerHour(24000, hoursAgo(24), NOW)).toBe(1000)
  })

  it('公開直後は分母に下限を置く(投稿10分で1000回が6000回/時に化けない)', () => {
    expect(viewsPerHour(1000, hoursAgo(1 / 6), NOW)).toBe(1000 / MIN_VELOCITY_HOURS)
  })

  it('再生数が非公開・欠測なら0(速度不明ではなく伸びていない扱い)', () => {
    expect(viewsPerHour(0, hoursAgo(10), NOW)).toBe(0)
    expect(viewsPerHour(NaN, hoursAgo(10), NOW)).toBe(0)
    expect(viewsPerHour(-5, hoursAgo(10), NOW)).toBe(0)
  })

  it('公開日時が読めないときだけ null', () => {
    expect(viewsPerHour(1000, 'x', NOW)).toBeNull()
  })

  it('古い動画より新しい動画が速い、が常に成り立つ(同じ再生数なら)', () => {
    const rnd = seeded(20260904)
    for (let i = 0; i < 2000; i++) {
      const views = Math.floor(rnd() * 5_000_000) + 1
      const younger = rnd() * 500
      const older = younger + rnd() * 500 + 0.01
      const a = viewsPerHour(views, hoursAgo(younger), NOW)
      const b = viewsPerHour(views, hoursAgo(older), NOW)
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      expect((a as number) >= (b as number)).toBe(true)
    }
  })

  it('境界値を通しても、返るのは有限か null', () => {
    for (const n of NASTY_NUMBERS) {
      const v = viewsPerHour(n, hoursAgo(3), NOW)
      expect(v === null || Number.isFinite(v)).toBe(true)
    }
  })
})

describe('measureVideo — 欠けた欄があっても必ず数として返す', () => {
  it('揃った1本をそのまま測る', () => {
    const m = measureVideo(
      {
        id: 'v',
        title: 't',
        channelTitle: 'c',
        viewCount: 12000,
        publishedAt: hoursAgo(12),
        durationSeconds: 45
      },
      NOW
    )
    expect(m.hoursAgo).toBeCloseTo(12, 9)
    expect(m.viewsPerHour).toBe(1000)
    expect(m.isShort).toBe(true)
  })

  it('尺の境界: 上限ちょうどはショート、1秒超えたら長尺', () => {
    const at = (d: number): boolean =>
      measureVideo(
        { id: 'v', title: '', channelTitle: '', viewCount: 0, publishedAt: '', durationSeconds: d },
        NOW
      ).isShort
    expect(at(SHORTS_MAX_SECONDS)).toBe(true)
    expect(at(SHORTS_MAX_SECONDS + 1)).toBe(false)
    // 尺が取れなかった動画をショート扱いすると、ショート比率が水増しされる
    expect(at(0)).toBe(false)
  })

  it('壊れた1本でも落ちず、数の欄は必ず有限', () => {
    for (const v of NASTY_VALUES) {
      const m = measureVideo(v as never, NOW)
      expect(Number.isFinite(m.viewCount)).toBe(true)
      expect(Number.isFinite(m.durationSeconds)).toBe(true)
      expect(typeof m.id).toBe('string')
    }
  })
})

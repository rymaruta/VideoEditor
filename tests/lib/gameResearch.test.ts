import { describe, expect, it } from 'vitest'
import {
  FRESHNESS_FULL_HOURS,
  FRESHNESS_ZERO_HOURS,
  SCORE_WEIGHTS,
  SHORTS_MAX_SECONDS,
  aggregateGames,
  attributedVideoCount,
  normalizeGameKey,
  rankGames,
  scoreGame,
  summarizeShorts,
  type GameAttribution,
  type GameStats,
  type ResearchVideo,
  type ShortsVerification
} from '@renderer/lib/gameResearch'
import { NASTY_VALUES, fuzzNumber, seeded } from '../helpers/boundary'

const NOW = Date.parse('2026-09-04T12:00:00Z')
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString()

function video(over: Partial<ResearchVideo> = {}): ResearchVideo {
  return {
    id: over.id ?? 'v1',
    title: over.title ?? 'タイトル',
    channelTitle: over.channelTitle ?? 'ch1',
    viewCount: over.viewCount ?? 1000,
    publishedAt: over.publishedAt ?? hoursAgo(24),
    durationSeconds: over.durationSeconds ?? 600
  }
}

function high(index: number, gameName: string): GameAttribution {
  return { index, gameName, confidence: 'high' }
}

describe('normalizeGameKey — 表記ゆれで同じゲームが割れないようにする', () => {
  it('全角/半角・大小・空白・囲み記号を均す', () => {
    expect(normalizeGameKey('【APEX】')).toBe(normalizeGameKey('Apex'))
    expect(normalizeGameKey('Apex Legends')).toBe(normalizeGameKey('ＡＰＥＸ　ＬＥＧＥＮＤＳ'))
  })

  it('末尾の句読点・感嘆符を落とす', () => {
    expect(normalizeGameKey('マリオカート！')).toBe(normalizeGameKey('マリオカート'))
  })

  it('長音符は残す(「ホラー」を「ホラ」にしない)', () => {
    expect(normalizeGameKey('ホラーゲーム')).toBe('ホラーゲーム')
  })

  it('【既知の限界】略称と正式名称は別のゲームとして数える', () => {
    // 「APEX」と「Apex Legends」は辞書が無いと繋げられない。ここは割り切って
    // 分けたままにし、代わりに判定を頼む依頼文で「同じゲームには同じ表記を使う」と
    // 指示している(gameTrendAnalysis の buildAttributionPrompt)。
    // 直したくなったらこのテストが落ちるので、直し忘れにも気付ける。
    expect(normalizeGameKey('APEX')).not.toBe(normalizeGameKey('Apex Legends'))
  })

  it('別のゲームを勝手に同一視しない', () => {
    expect(normalizeGameKey('スプラトゥーン3')).not.toBe(normalizeGameKey('スプラトゥーン2'))
    // 読みが同じでも綴りが違えば別扱い(辞書なしで混ぜる方が危ない)
    expect(normalizeGameKey('エーペックス')).not.toBe(normalizeGameKey('apex'))
  })

  it('文字列以外・空文字は空の鍵', () => {
    expect(normalizeGameKey('')).toBe('')
    expect(normalizeGameKey('   ')).toBe('')
    for (const v of NASTY_VALUES) {
      expect(() => normalizeGameKey(v as string)).not.toThrow()
    }
  })
})

describe('aggregateGames — AIの判定を、渡した動画に突き合わせて数える', () => {
  const videos = [
    video({ id: 'a', title: 'A', channelTitle: 'ch1', viewCount: 60000, publishedAt: hoursAgo(6) }),
    video({ id: 'b', title: 'B', channelTitle: 'ch2', viewCount: 30000, publishedAt: hoursAgo(6) }),
    video({ id: 'c', title: 'C', channelTitle: 'ch3', viewCount: 10000, publishedAt: hoursAgo(48) })
  ]

  it('表記ゆれをまとめて1つのゲームとして数える', () => {
    const stats = aggregateGames(
      videos,
      [high(1, 'Apex Legends'), high(2, '【ａｐｅｘ　legends】')],
      NOW
    )
    expect(stats).toHaveLength(1)
    expect(stats[0].videoCount).toBe(2)
    expect(stats[0].channelCount).toBe(2)
    expect(stats[0].totalViews).toBe(90000)
  })

  it('表示名は一番多く使われた綴り', () => {
    const stats = aggregateGames(
      videos,
      [high(1, 'APEX'), high(2, 'APEX'), high(3, 'Apex Legends')],
      NOW
    )
    expect(stats[0].displayName).toBe('APEX')
  })

  it('自信の無い判定(low)は数に入れない', () => {
    const stats = aggregateGames(
      videos,
      [high(1, 'ゲームA'), { index: 2, gameName: 'ゲームA', confidence: 'low' }],
      NOW
    )
    expect(stats[0].videoCount).toBe(1)
  })

  it('範囲外・非整数の番号は捨てる(AIが番号を作っても混ざらない)', () => {
    const stats = aggregateGames(
      videos,
      [high(0, 'X'), high(4, 'X'), high(1.5, 'X'), high(-1, 'X'), high(NaN, 'X')],
      NOW
    )
    expect(stats).toEqual([])
  })

  it('同じ動画に同じゲームが二重に付いても1本として数える', () => {
    const stats = aggregateGames(videos, [high(1, 'ゲームA'), high(1, 'ゲームA')], NOW)
    expect(stats[0].videoCount).toBe(1)
  })

  it('根拠として持つのは、こちらが渡した原文そのもの', () => {
    const stats = aggregateGames(videos, [high(1, 'ゲームA')], NOW)
    expect(stats[0].videos.map((v) => v.title)).toEqual(['A'])
  })

  it('ショートは尺で判定する', () => {
    const mixed = [
      video({ id: 's', durationSeconds: SHORTS_MAX_SECONDS }),
      video({ id: 'l', durationSeconds: SHORTS_MAX_SECONDS + 1 }),
      video({ id: 'z', durationSeconds: 0 })
    ]
    const stats = aggregateGames(mixed, [high(1, 'G'), high(2, 'G'), high(3, 'G')], NOW)
    expect(stats[0].shortsCount).toBe(1)
    expect(stats[0].shortsRatio).toBeCloseTo(1 / 3, 9)
  })

  it('最新の1本の経過時間を持つ', () => {
    const stats = aggregateGames(videos, [high(1, 'G'), high(3, 'G')], NOW)
    expect(stats[0].newestHoursAgo).toBeCloseTo(6, 9)
  })

  it('公開日時が全部読めなければ、経過時間は不明(0ではない)', () => {
    const broken = [video({ id: 'x', publishedAt: '' })]
    const stats = aggregateGames(broken, [high(1, 'G')], NOW)
    expect(stats[0].newestHoursAgo).toBeNull()
    expect(stats[0].medianViewsPerHour).toBe(0)
  })

  it('壊れた入力(null要素・欠けた欄)でも落ちない', () => {
    const dirty = [null, undefined, {}, video({ id: 'ok' })] as unknown as ResearchVideo[]
    expect(() =>
      aggregateGames(dirty, [high(1, 'G'), high(2, 'G'), high(3, 'G'), high(4, 'G')], NOW)
    ).not.toThrow()
    for (const v of NASTY_VALUES) {
      expect(() => aggregateGames(v as ResearchVideo[], v as GameAttribution[], NOW)).not.toThrow()
    }
  })

  it('集計に使えた動画の本数を数えられる(判定できなかった本数を出すため)', () => {
    const stats = aggregateGames(videos, [high(1, 'G'), high(2, 'H')], NOW)
    expect(attributedVideoCount(stats)).toBe(2)
  })
})

function stats(over: Partial<GameStats> = {}): GameStats {
  return {
    key: over.key ?? 'g',
    displayName: over.displayName ?? 'G',
    videoCount: over.videoCount ?? 1,
    channelCount: over.channelCount ?? 1,
    totalViews: over.totalViews ?? 0,
    medianViewsPerHour: over.medianViewsPerHour ?? 0,
    topViewsPerHour: over.topViewsPerHour ?? 0,
    newestHoursAgo: over.newestHoursAgo === undefined ? 24 : over.newestHoursAgo,
    shortsCount: over.shortsCount ?? 0,
    shortsRatio: over.shortsRatio ?? 0,
    videos: over.videos ?? []
  }
}

function verification(over: Partial<ShortsVerification> = {}): ShortsVerification {
  return {
    key: over.key ?? 'g',
    query: over.query ?? 'G',
    windowDays: over.windowDays ?? 14,
    shortsFound: over.shortsFound ?? 0,
    medianViewsPerHour: over.medianViewsPerHour ?? 0,
    topVideo: over.topVideo ?? null
  }
}

describe('scoreGame — 順位の根拠になる100点', () => {
  it('内訳の満点の合計は100', () => {
    const sum =
      SCORE_WEIGHTS.momentum +
      SCORE_WEIGHTS.freshness +
      SCORE_WEIGHTS.spread +
      SCORE_WEIGHTS.shortsFit
    expect(sum).toBe(100)
  })

  it('画面に出す内訳を足すと合計になる(利用者から計算間違いに見えないように)', () => {
    const rnd = seeded(4242)
    for (let i = 0; i < 2000; i++) {
      const score = scoreGame(
        stats({
          medianViewsPerHour: fuzzNumber(rnd, 0, 200000),
          newestHoursAgo: fuzzNumber(rnd, 0, 400),
          channelCount: Math.floor(rnd() * 8),
          videoCount: Math.floor(rnd() * 10),
          shortsRatio: rnd()
        }),
        rnd() < 0.5
          ? verification({
              shortsFound: Math.floor(rnd() * 12),
              medianViewsPerHour: fuzzNumber(rnd, 0, 50000)
            })
          : null
      )
      const parts = score.momentum + score.freshness + score.spread + score.shortsFit
      expect(score.total).toBe(Math.min(100, Math.max(0, Math.round(parts))))
    }
  })

  it('どんな入力でも0〜100の有限値', () => {
    const rnd = seeded(777)
    for (let i = 0; i < 3000; i++) {
      const score = scoreGame(
        stats({
          medianViewsPerHour: fuzzNumber(rnd, -1000, 1e9),
          newestHoursAgo: rnd() < 0.1 ? null : fuzzNumber(rnd, -100, 1e6),
          channelCount: fuzzNumber(rnd, -5, 50),
          videoCount: fuzzNumber(rnd, -5, 50),
          shortsRatio: fuzzNumber(rnd, -2, 3)
        }),
        rnd() < 0.5
          ? verification({
              shortsFound: fuzzNumber(rnd, -5, 100),
              medianViewsPerHour: fuzzNumber(rnd, -100, 1e8)
            })
          : null
      )
      for (const part of [score.momentum, score.freshness, score.spread, score.shortsFit]) {
        expect(Number.isFinite(part)).toBe(true)
        expect(part).toBeGreaterThanOrEqual(0)
      }
      expect(score.total).toBeGreaterThanOrEqual(0)
      expect(score.total).toBeLessThanOrEqual(100)
    }
  })

  it('新しさは6時間以内で満点、7日で0点', () => {
    expect(scoreGame(stats({ newestHoursAgo: 0 }), null).freshness).toBe(SCORE_WEIGHTS.freshness)
    expect(scoreGame(stats({ newestHoursAgo: FRESHNESS_FULL_HOURS }), null).freshness).toBe(
      SCORE_WEIGHTS.freshness
    )
    expect(scoreGame(stats({ newestHoursAgo: FRESHNESS_ZERO_HOURS }), null).freshness).toBe(0)
    expect(scoreGame(stats({ newestHoursAgo: 1000 }), null).freshness).toBe(0)
  })

  it('公開日時が読めなければ新しさは0点(推測で加点しない)', () => {
    expect(scoreGame(stats({ newestHoursAgo: null }), null).freshness).toBe(0)
  })

  it('速いほど勢いが高い(単調)', () => {
    const rnd = seeded(31337)
    for (let i = 0; i < 1000; i++) {
      const slow = rnd() * 50000
      const fast = slow + rnd() * 50000 + 1
      expect(scoreGame(stats({ medianViewsPerHour: fast }), null).momentum).toBeGreaterThanOrEqual(
        scoreGame(stats({ medianViewsPerHour: slow }), null).momentum
      )
    }
  })

  it('1つのチャンネルが5本出しただけでは「広がり」を認めない', () => {
    const single = scoreGame(stats({ channelCount: 1, videoCount: 5 }), null).spread
    const spread = scoreGame(stats({ channelCount: 5, videoCount: 6 }), null).spread
    expect(single).toBeLessThan(spread)
    expect(spread).toBe(SCORE_WEIGHTS.spread)
  })

  it('裏取りでショートが0本なら、ショート適性は0点', () => {
    const score = scoreGame(
      stats({ shortsRatio: 1 }),
      verification({ shortsFound: 0, medianViewsPerHour: 99999 })
    )
    expect(score.shortsFit).toBe(0)
    expect(score.verified).toBe(true)
  })

  it('裏取りをしていない場合は、ショート適性を控えめ(6割まで)に見積もる', () => {
    const score = scoreGame(stats({ shortsRatio: 1 }), null)
    expect(score.shortsFit).toBeCloseTo(SCORE_WEIGHTS.shortsFit * 0.6, 5)
    expect(score.verified).toBe(false)
  })

  it('【この回の主題】同じ実測値なら、判定に使った値が同じ限り点も同じ(再現する)', () => {
    const s = stats({
      medianViewsPerHour: 12345,
      newestHoursAgo: 7,
      channelCount: 3,
      videoCount: 4
    })
    expect(scoreGame(s, null)).toEqual(scoreGame(s, null))
  })
})

describe('summarizeShorts — 裏取りの数え方', () => {
  it('ショートでない尺は落とす', () => {
    const results = [
      video({ id: '1', durationSeconds: 45, viewCount: 90000, publishedAt: hoursAgo(9) }),
      video({ id: '2', durationSeconds: 900, viewCount: 900000, publishedAt: hoursAgo(9) })
    ]
    const v = summarizeShorts('g', 'G', 14, results, NOW)
    expect(v.shortsFound).toBe(1)
    expect(v.topVideo?.id).toBe('1')
    expect(v.medianViewsPerHour).toBe(10000)
  })

  it('1本も無ければ0本・速度0・代表なし', () => {
    const v = summarizeShorts('g', 'G', 14, [], NOW)
    expect(v).toEqual({
      key: 'g',
      query: 'G',
      windowDays: 14,
      shortsFound: 0,
      medianViewsPerHour: 0,
      topVideo: null
    })
  })

  it('壊れた検索結果でも落ちない', () => {
    const dirty = [null, {}, video({ id: 'ok', durationSeconds: 30 })] as unknown as ResearchVideo[]
    expect(() => summarizeShorts('g', 'G', 14, dirty, NOW)).not.toThrow()
  })
})

describe('rankGames — 並び', () => {
  it('スコアの高い順', () => {
    const ranked = rankGames([
      stats({ key: 'low', medianViewsPerHour: 10, newestHoursAgo: 160 }),
      stats({
        key: 'high',
        medianViewsPerHour: 50000,
        newestHoursAgo: 2,
        channelCount: 5,
        videoCount: 6
      })
    ])
    expect(ranked.map((r) => r.stats.key)).toEqual(['high', 'low'])
  })

  it('同点でも並びが決まっている(同じ入力から毎回同じ順位)', () => {
    const a = stats({ key: 'aaa' })
    const b = stats({ key: 'bbb' })
    expect(rankGames([a, b]).map((r) => r.stats.key)).toEqual(['aaa', 'bbb'])
    expect(rankGames([b, a]).map((r) => r.stats.key)).toEqual(['aaa', 'bbb'])
  })

  it('裏取りの結果は鍵で引き当てる', () => {
    const ranked = rankGames(
      [stats({ key: 'g' })],
      new Map([['g', verification({ shortsFound: 8, medianViewsPerHour: 5000 })]])
    )
    expect(ranked[0].verification?.shortsFound).toBe(8)
    expect(ranked[0].score.verified).toBe(true)
  })

  it('【この回の主題】ショートが1本も無い候補は、裏取り後に順位が下がる', () => {
    // 実測値は互角。違うのは「そのゲームのショートが直近にあるか」だけ
    const noShorts = stats({
      key: 'noshorts',
      medianViewsPerHour: 20000,
      newestHoursAgo: 5,
      channelCount: 3,
      videoCount: 3
    })
    const hasShorts = stats({
      key: 'hasshorts',
      medianViewsPerHour: 20000,
      newestHoursAgo: 5,
      channelCount: 3,
      videoCount: 3
    })
    const before = rankGames([noShorts, hasShorts])
    expect(before.map((r) => r.stats.key)).toEqual(['hasshorts', 'noshorts'])

    const after = rankGames(
      [noShorts, hasShorts],
      new Map([
        ['noshorts', verification({ key: 'noshorts', shortsFound: 0 })],
        ['hasshorts', verification({ key: 'hasshorts', shortsFound: 10, medianViewsPerHour: 8000 })]
      ])
    )
    expect(after.map((r) => r.stats.key)).toEqual(['hasshorts', 'noshorts'])
    expect(after[0].score.total).toBeGreaterThan(after[1].score.total)
  })

  it('空でも壊れた入力でも落ちない', () => {
    expect(rankGames([])).toEqual([])
    for (const v of NASTY_VALUES) {
      expect(() => rankGames(v as GameStats[])).not.toThrow()
    }
  })
})

describe('【計器の確認】変わるはずのものが変わる', () => {
  it('再生数を増やせば勢いの点は上がる', () => {
    const before = scoreGame(stats({ medianViewsPerHour: 100 }), null).momentum
    const after = scoreGame(stats({ medianViewsPerHour: 100000 }), null).momentum
    expect(after).toBeGreaterThan(before)
  })

  it('公開が新しいほど新しさの点は上がる', () => {
    const old = scoreGame(stats({ newestHoursAgo: 100 }), null).freshness
    const fresh = scoreGame(stats({ newestHoursAgo: 10 }), null).freshness
    expect(fresh).toBeGreaterThan(old)
  })
})

import { describe, expect, it } from 'vitest'
import { joinTelopLines, telopIssues } from '../../src/shared/qc/telop'
import { buildReviewItems } from '../../src/renderer/src/lib/reviewItems'
import { defaultTextStyle } from '../../src/shared/textStyle'
import type { TextOverlay } from '../../src/shared/types'

/**
 * 要確認の文に引くテロップの文。2行のテロップの改行が半角スペースになり、
 * 「いっそ川へでも身を 投げて死んで」と日本語の途中に空白が入っていた
 */
describe('要確認の文: 2行のテロップの改行', () => {
  it('日本語どうしの改行は詰め、英数字どうしの改行だけ空白にする', () => {
    expect(joinTelopLines('いっそ川へでも身を\n投げて死んで')).toBe(
      'いっそ川へでも身を投げて死んで'
    )
    expect(joinTelopLines('Good\nmorning')).toBe('Good morning')
    expect(joinTelopLines('今日は\nMinecraft')).toBe('今日はMinecraft')
    expect(joinTelopLines('Level 5\r\nクリア')).toBe('Level 5クリア')
    // 行の中の空白はそのまま
    expect(joinTelopLines('はい そうです\nね')).toBe('はい そうですね')
  })

  it('空行をはさんだ英語の行も空白でつなぎ、英語の文末記号の後ろは詰めない', () => {
    // 空行(改行が2つ続く)の両側を見ずに、1つ目の改行の後ろ(2つ目の改行)だけを見ていた
    expect(joinTelopLines('Good\n\nmorning')).toBe('Good morning')
    expect(joinTelopLines('Good \n \n morning')).toBe('Good morning')
    expect(joinTelopLines('Nice!\nGood job')).toBe('Nice! Good job')
    expect(joinTelopLines('Wait.\r\nWhat?')).toBe('Wait. What?')
    expect(joinTelopLines('Yes,\nsir')).toBe('Yes, sir')
    // 日本語どうし・日本語の前後は今までどおり詰める
    expect(joinTelopLines('すごい!\nこれ')).toBe('すごい!これ')
    expect(joinTelopLines('Nice!\nすごい')).toBe('Nice!すごい')
    expect(joinTelopLines('いっそ\n\n投げて')).toBe('いっそ投げて')
  })

  it('書き出しの確認(確認する言葉)の文に、改行の空白を入れない', () => {
    const ctx = {
      font: '',
      measureText(ch: string) {
        const s = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 40)
        return { width: s * [...ch].length } as TextMetrics
      }
    }
    const o: TextOverlay = {
      id: 'a',
      text: 'いっそ川へでも身を\n投げて死んで',
      startTime: 0,
      endTime: 4,
      style: defaultTextStyle()
    }
    const issues = telopIssues(
      [o],
      ctx,
      { w: 1920, h: 1080 },
      {
        bannedWords: ['身を投げ'],
        dictionary: []
      }
    )
    const word = issues.find((i) => i.kind === 'telopWord')
    expect(word?.message).toContain('いっそ川へでも身を投げて死んで')
    expect(word?.message).not.toContain('身を 投げ')
  })

  it('顔に掛かるテロップの要確認の文にも、改行の空白を入れない', () => {
    const items = buildReviewItems({
      project: {
        id: 'p',
        name: 'p',
        aspectRatio: '16:9',
        assets: [],
        clips: [],
        audioTracks: [],
        videoOverlayTracks: [],
        textOverlays: []
      },
      syncIssues: [],
      fileLabel: (id) => id,
      placedStart: () => undefined,
      telopReviews: [{ startTime: 1, text: 'いっそ川へでも身を\n投げて死んで', key: null }],
      colorIssues: [],
      denoiseFailures: [],
      effects: [],
      effectChosen: [],
      qc: null
    })
    const face = items.find((i) => i.kind === 'テロップと顔')
    expect(face?.text).toContain('「いっそ川へでも身を投げて死んで」')
  })
})

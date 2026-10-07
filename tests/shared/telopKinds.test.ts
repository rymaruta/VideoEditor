import { describe, expect, it } from 'vitest'
import { CATEGORY_LABEL, TELOP_KINDS } from '@shared/telop/kinds'
import { normalizeTextStyle } from '@shared/textStyle'
import { stripTelopMarkup } from '@shared/telop/render'

describe('テロップの種類の一覧', () => {
  it('100 種類以上あり、ID は重ならず、どれも分類・用途・見本の文を持つ', () => {
    expect(TELOP_KINDS.length).toBeGreaterThanOrEqual(100)
    expect(new Set(TELOP_KINDS.map((k) => k.id)).size).toBe(TELOP_KINDS.length)
    expect(new Set(TELOP_KINDS.map((k) => k.label)).size).toBe(TELOP_KINDS.length)
    for (const k of TELOP_KINDS) {
      expect(CATEGORY_LABEL[k.category]).toBeTruthy()
      expect(k.use.length).toBeGreaterThan(0)
      expect(stripTelopMarkup(k.sample).trim().length).toBeGreaterThan(0)
      expect(k.seconds).toBeGreaterThan(0)
    }
  })

  it('どの見た目も、保存して読み直しても変わらない(書き出しで落ちる値を持たない)', () => {
    for (const k of TELOP_KINDS) {
      const style = k.style()
      const reread = normalizeTextStyle(JSON.parse(JSON.stringify(style)))
      expect(JSON.parse(JSON.stringify(reread)), k.id).toEqual(JSON.parse(JSON.stringify(style)))
    }
  })

  it('ゲーム実況の種類がそろっている(叫び・やられた・クリア・ボス戦・デス数・コラボの色分けなど)', () => {
    const play = TELOP_KINDS.filter((k) => k.category === 'play')
    expect(play.length).toBeGreaterThanOrEqual(25)
    expect(CATEGORY_LABEL.play).toBe('ゲーム実況')
    for (const id of [
      'tpl-play-scream',
      'tpl-play-died',
      'tpl-play-clear',
      'tpl-play-boss',
      'tpl-play-deaths'
    ])
      expect(
        play.some((k) => k.id === id),
        id
      ).toBe(true)
    // コラボで5人まで話者の色を分けられる
    expect(
      TELOP_KINDS.filter(
        (k) =>
          k.category === 'speech' && /発言\((黄|青縁|ピンク縁|緑縁|オレンジ縁|紫縁)\)/.test(k.label)
      ).length
    ).toBe(6)
  })

  it('絵文字を使わない(PC によって字形が無く、書き出しで豆腐になる)', () => {
    for (const k of TELOP_KINDS) expect(k.sample, k.id).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

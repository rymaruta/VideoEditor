import { describe, expect, it } from 'vitest'
import { defaultTextStyle, TEXT_ANIMATION_MS } from '../../src/shared/textStyle'
import { SECTION_KEYS } from '../../src/renderer/src/lib/appearancePresets'
import {
  filterFonts,
  isSectionDefault,
  lookKey,
  lookPatch,
  matchesLookQuery,
  placePopover,
  readableBackground,
  scaleLook,
  scrubValue,
  sectionDefaultPatch,
  sectionMatches,
  sectionPatch,
  SECTION_IDS,
  settledTelopTime,
  stillTelopStyle,
  telopTargetGroups
} from '../../src/renderer/src/lib/appearanceEdit'
import { drawTelop } from '../../src/shared/telop/render'

describe('項目ごとのマイ設定を当てる', () => {
  it('その項目のキーをすべて持ち、無いものは消す(必ず要るキーは既定値)', () => {
    const p = sectionPatch('stroke', { outlineColor: '#ff0000', outlineWidth: 9 })
    expect(Object.keys(p).sort()).toEqual([...SECTION_KEYS.stroke].sort())
    expect(p.outlineColor).toBe('#ff0000')
    expect(p.outlineGradient).toBeUndefined()
    expect(p.extraStrokes).toBeUndefined()
    // JSON で落ちた必須の値は既定で埋める
    expect(p.outline).toBe(true)
  })
  it('ほかの項目には触らない', () => {
    const p = sectionPatch('shadow', { shadow: true })
    expect('color' in p).toBe(false)
    expect('fontSize' in p).toBe(false)
  })
  it('既定に戻す・既定かどうか', () => {
    const s = defaultTextStyle()
    expect(isSectionDefault(s, 'glow')).toBe(true)
    const glowing = { ...s, glow: { color: '#fff', size: 3, opacity: 1 } }
    expect(isSectionDefault(glowing, 'glow')).toBe(false)
    expect({ ...glowing, ...sectionDefaultPatch('glow') }.glow).toBeUndefined()
  })
  it('保存した値と同じか(undefined のキーは無いのと同じ)', () => {
    const s = { ...defaultTextStyle(), shadow: true, shadowBlur: 4 }
    const saved = JSON.parse(JSON.stringify(lookPatch(s, ['shadow'])))
    expect(sectionMatches(s, 'shadow', saved)).toBe(true)
    expect(sectionMatches({ ...s, shadowBlur: 5 }, 'shadow', saved)).toBe(false)
  })
})

describe('見た目のコピーと当てる先', () => {
  const base = defaultTextStyle()
  const ov = (id: string, extra: object = {}): never => ({ id, style: base, ...extra }) as never
  it('選んだ項目だけを抜き出し、置き場所・回転は含めない', () => {
    const s = { ...base, color: '#123456', rotation: 30, customPosition: { x: 0.1, y: 0.2 } }
    const p = lookPatch(s, SECTION_IDS)
    expect(p.color).toBe('#123456')
    expect('rotation' in p).toBe(false)
    expect('customPosition' in p).toBe(false)
    expect('position' in p).toBe(false)
    expect(Object.keys(lookPatch(s, ['fill'])).sort()).toEqual([...SECTION_KEYS.fill].sort())
  })
  it('同じ見た目は置き場所が違っても同じ指紋', () => {
    expect(lookKey({ ...base, rotation: 5 })).toBe(lookKey(base))
    expect(lookKey({ ...base, color: '#000000' })).not.toBe(lookKey(base))
  })
  it('当てる先の組(1本だけの組は出さない)', () => {
    const red = { ...base, color: '#ff0000' }
    const list = [
      ov('a', { speaker: '田中', utteranceId: 'u1' }),
      ov('b', { speaker: '田中', utteranceId: 'u2' }),
      ov('c', { style: red, speaker: '佐藤' })
    ]
    const g = telopTargetGroups(list, list[0])
    expect(g.map((x) => x.id)).toEqual(['same-look', 'same-speaker', 'speech', 'all'])
    expect(g.find((x) => x.id === 'same-look')!.ids).toEqual(['a', 'b'])
    expect(g.find((x) => x.id === 'all')!.ids).toHaveLength(3)
    expect(telopTargetGroups(list, list[2]).map((x) => x.id)).toEqual(['all'])
  })
})

describe('背景を付けたときの色', () => {
  it('白い文字に白い背景なら黒にし、薄すぎる背景は濃くする', () => {
    const s = {
      ...defaultTextStyle(),
      color: '#ffffff',
      backgroundColor: '#ffffff',
      backgroundOpacity: 0.1
    }
    expect(readableBackground(s)).toEqual({ backgroundColor: '#000000', backgroundOpacity: 0.6 })
  })
  it('暗い文字なら白、読める組み合わせはそのまま', () => {
    const dark = { ...defaultTextStyle(), color: '#111111', backgroundColor: '#222222' }
    expect(readableBackground(dark).backgroundColor).toBe('#ffffff')
    const ok = { ...defaultTextStyle(), color: '#ffffff', backgroundColor: '#3355aa' }
    expect(readableBackground(ok).backgroundColor).toBe('#3355aa')
  })
})

describe('止め絵に描く時刻', () => {
  it('登場の動きの後、消える動きの前', () => {
    const s = {
      ...defaultTextStyle(),
      animation: 'popIn' as const,
      exitAnimation: 'fadeOut' as const
    }
    const { time, endTime } = settledTelopTime(s, 'こんにちは')
    expect(time).toBeGreaterThan(TEXT_ANIMATION_MS.popIn / 1000)
    expect(endTime - time).toBeGreaterThan(0.35)
  })
  it('1文字ずつ・タイプライターは文字数と速さに合わせる', () => {
    const s = { ...defaultTextStyle(), charAnimation: 'drop' as const, animationSpeed: 0.5 }
    const short = settledTelopTime(s, 'あ').time
    const long = settledTelopTime(s, 'あいうえおかきくけこ').time
    expect(long).toBeGreaterThan(short)
    expect(
      settledTelopTime({ ...defaultTextStyle(), animation: 'typewriter' }, 'あいうえお').time
    ).toBeGreaterThan(0.2)
  })
  it('その時刻で描くと全部の文字が出ていて、ループは外れる', () => {
    const s = {
      ...defaultTextStyle(),
      animation: 'typewriter' as const,
      loopAnimation: 'blink' as const
    }
    const still = stillTelopStyle(s)
    expect(still.loopAnimation).toBeUndefined()
    const { time, endTime } = settledTelopTime(still, 'あいう')
    const calls: string[] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) =>
        k in t
          ? t[k]
          : k === 'measureText'
            ? () => ({ width: 10 })
            : (...a: unknown[]) => {
                if (k === 'fillText') calls.push(String(a[0]))
              },
      set: (t, k: string, v) => {
        t[k] = v
        return true
      }
    })
    drawTelop(
      ctx as never,
      { text: 'あいう', startTime: 0, endTime, style: still },
      time,
      { width: 1920, height: 1080 },
      { w: 1920, h: 1080 }
    )
    expect(calls.join('')).toContain('う')
  })
})

describe('吹き出しの位置', () => {
  const vp = { width: 1000, height: 800 }
  it('下に入れば下、入らなければ上', () => {
    expect(
      placePopover({ top: 100, bottom: 120, left: 50, right: 70 }, { width: 200, height: 300 }, vp)
    ).toEqual({ top: 126, left: 50 })
    expect(
      placePopover({ top: 700, bottom: 720, left: 50, right: 70 }, { width: 200, height: 300 }, vp)
        .top
    ).toBe(394)
  })
  it('右にはみ出すなら右端を揃え、画面より大きければ端に寄せる', () => {
    expect(
      placePopover(
        { top: 100, bottom: 120, left: 950, right: 990 },
        { width: 200, height: 100 },
        vp
      ).left
    ).toBe(790)
    expect(
      placePopover({ top: 400, bottom: 420, left: 0, right: 10 }, { width: 200, height: 2000 }, vp)
        .top
    ).toBe(8)
  })
})

describe('数値のドラッグ', () => {
  it('2px で1目盛り、範囲に収め、目盛りの桁に丸める', () => {
    expect(scrubValue(40, 20, 1, 1, 8, 300)).toBe(50)
    expect(scrubValue(40, 20, 1, 10, 8, 300)).toBe(140)
    expect(scrubValue(40, -1000, 1, 1, 8, 300)).toBe(8)
    expect(scrubValue(1.2, 6, 0.05, 1, 0.6, 3)).toBe(1.35)
    expect(scrubValue(1, 4, 0.05, 0.1, 0, 3)).toBe(1.01)
  })
})

describe('探す', () => {
  it('書体を名前・分類で絞る(全角半角を区別しない)', () => {
    const opts = [
      { value: 'A', label: 'M PLUS Rounded(丸ゴシック)', group: '基本' },
      { value: 'B', label: 'しっぽり明朝', group: '明朝' }
    ]
    expect(filterFonts(opts, '丸').map((o) => o.value)).toEqual(['A'])
    expect(filterFonts(opts, 'ｍ ｐｌｕｓ').map((o) => o.value)).toEqual(['A'])
    expect(filterFonts(opts, '')).toHaveLength(2)
  })
  it('見た目を言葉すべてで探す', () => {
    const it = { name: '店名・価格', text: '¥980', group: '情報', keywords: '値段を出す' }
    expect(matchesLookQuery(it, '値段')).toBe(true)
    expect(matchesLookQuery(it, '情報 価格')).toBe(true)
    expect(matchesLookQuery(it, '情報 ツッコミ')).toBe(false)
  })
})

describe('見た目の拡大', () => {
  it('文字と一緒に縁・余白・影も同じ割合で', () => {
    const s = {
      ...defaultTextStyle(),
      fontSize: 40,
      outlineWidth: 4,
      extraStrokes: [{ color: '#fff', width: 2 }],
      shadowDistance: 3,
      backgroundPadding: { x: 10, y: 4 }
    }
    const b = scaleLook(s, 3)
    expect(b.fontSize).toBe(120)
    expect(b.outlineWidth).toBe(12)
    expect(b.extraStrokes?.[0].width).toBe(6)
    expect(b.shadowDistance).toBe(9)
    expect(b.backgroundPadding).toEqual({ x: 30, y: 12 })
    expect(scaleLook(s, 1)).toBe(s)
  })
})

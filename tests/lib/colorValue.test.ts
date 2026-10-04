import { describe, expect, it } from 'vitest'
import {
  addFavoriteColor,
  MAX_FAVORITE_COLORS,
  normalizeFavoriteColors,
  normalizeHex,
  parseColor,
  rgbToHex
} from '../../src/renderer/src/lib/colorValue'

describe('色の値', () => {
  it('よくある書き方を読み、#rrggbb に揃える', () => {
    expect(normalizeHex('#FF8800')).toBe('#ff8800')
    expect(normalizeHex('ff8800')).toBe('#ff8800')
    expect(normalizeHex('#f80')).toBe('#ff8800')
    expect(normalizeHex('rgb(255, 136, 0)')).toBe('#ff8800')
    expect(normalizeHex('255,136,0')).toBe('#ff8800')
    expect(normalizeHex(' 255 136 0 ')).toBe('#ff8800')
  })

  it('読めない値・範囲外は null', () => {
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex('#ff88')).toBeNull()
    expect(normalizeHex('red')).toBeNull()
    expect(parseColor('256,0,0')).toBeNull()
  })

  it('RGB は 0〜255 に収めて 16進にする', () => {
    expect(rgbToHex({ r: 300, g: -5, b: 127.6 })).toBe('#ff0080')
  })
})

describe('お気に入りの色', () => {
  it('足した色が先頭。同じ色は前へ移し、上限を超えたら古いものから落とす', () => {
    let list = addFavoriteColor([], '#ff0000')
    list = addFavoriteColor(list, '00FF00')
    list = addFavoriteColor(list, '#f00')
    expect(list).toEqual(['#ff0000', '#00ff00'])
    for (let i = 0; i < 30; i++) list = addFavoriteColor(list, rgbToHex({ r: i, g: 0, b: 0 }))
    expect(list.length).toBe(MAX_FAVORITE_COLORS)
    expect(list[0]).toBe('#1d0000')
    expect(addFavoriteColor(list, 'nope')).toEqual(list)
  })

  it('保存していた値の壊れた所は捨てる', () => {
    expect(normalizeFavoriteColors(['#ABC', 3, 'x', '#aabbcc', null])).toEqual(['#aabbcc'])
    expect(normalizeFavoriteColors('oops')).toEqual([])
  })
})

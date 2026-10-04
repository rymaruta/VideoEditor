import { describe, expect, it } from 'vitest'
import {
  buildSrt,
  parseSrt,
  parseSrtTime,
  replaceInTelop,
  srtTime,
  telopMatches
} from '@shared/telop/srt'

describe('SRT', () => {
  it('時刻の書き方', () => {
    expect(srtTime(62.345)).toBe('00:01:02,345')
    expect(srtTime(3600 + 0.0004)).toBe('01:00:00,000')
    expect(parseSrtTime('00:01:02,345')).toBeCloseTo(62.345, 9)
    expect(parseSrtTime('01:02.5')).toBeCloseTo(62.5, 9)
    expect(parseSrtTime('x')).toBeNaN()
  })

  it('書き出しは時刻の順・装飾の印とルビを外す・空のテロップは出さない', () => {
    const srt = buildSrt([
      { text: 'うに丼 **2,800円**', startTime: 5, endTime: 7 },
      { text: '雲丹《うに》を\n食べる', startTime: 1, endTime: 3 },
      { text: '  ', startTime: 8, endTime: 9 }
    ])
    expect(srt).toBe(
      '1\r\n00:00:01,000 --> 00:00:03,000\r\n雲丹を\r\n食べる\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,000\r\nうに丼 2,800円\r\n'
    )
  })

  it('読み込み: BOM・CRLF・書式タグ・位置指定・壊れたまとまりに耐える', () => {
    const cues = parseSrt(
      '﻿1\r\n00:00:01,000 --> 00:00:02,500 X1:10\r\n<i>こんにちは</i>\r\n世界\r\n\r\n2\r\nこわれた\r\n\r\n3\r\n00:00:04,000 --> 00:00:03,000\r\n逆\r\n\r\n4\r\n00:00:05,000 --> 00:00:06,000\r\n{\\an8}上に\r\n'
    )
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'こんにちは\n世界' },
      { start: 5, end: 6, text: '上に' }
    ])
  })

  it('書き出して読み直すと同じ', () => {
    const telops = [
      { text: '一', startTime: 0.5, endTime: 1.25 },
      { text: '二\n三', startTime: 2, endTime: 4 }
    ]
    expect(parseSrt(buildSrt(telops))).toEqual([
      { start: 0.5, end: 1.25, text: '一' },
      { start: 2, end: 4, text: '二\n三' }
    ])
  })
})

describe('検索と置換', () => {
  it('区別しないときは全角・半角、大小を無視する', () => {
    expect(telopMatches('ＯＫです', 'ok', { loose: true })).toBe(true)
    expect(telopMatches('ＯＫです', 'ok')).toBe(false)
    expect(replaceInTelop('ＯＫです、okだよ', 'ok', 'オッケー', { loose: true })).toBe(
      'オッケーです、オッケーだよ'
    )
    expect(replaceInTelop('ok OK', 'ok', 'x')).toBe('x OK')
    expect(replaceInTelop('abc', '', 'x')).toBe('abc')
  })
})

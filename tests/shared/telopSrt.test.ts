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

describe('SRT と検索・置換の境目', () => {
  it('空行の抜けた SRT でも字幕を分けて読む', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nHello\n2\n00:00:03,000 --> 00:00:04,000\nWorld'
    )
    expect(cues).toEqual([
      { start: 1, end: 2, text: 'Hello' },
      { start: 3, end: 4, text: 'World' }
    ])
  })

  it('本文の空行は詰めて書き、読み戻しても後ろが消えない', () => {
    const srt = buildSrt([{ text: 'a\n\nb', startTime: 0, endTime: 1 }])
    expect(parseSrt(srt)).toEqual([{ start: 0, end: 1, text: 'a\nb' }])
  })

  it('ミリ秒に丸めて長さが無くなる字幕は書かない', () => {
    expect(buildSrt([{ text: 'x', startTime: 1.0001, endTime: 1.0004 }])).toBe('')
  })

  it('区別しない置換は、検索で見つかる所を置き換える(半角カナの濁点・㍿)', () => {
    expect(telopMatches('ｶﾞｲﾄﾞ', 'ガ', { loose: true })).toBe(true)
    expect(replaceInTelop('ｶﾞｲﾄﾞ', 'ガ', 'X', { loose: true })).toBe('Xｲﾄﾞ')
    expect(replaceInTelop('ｶﾞｲﾄﾞ', 'ガイド', '案内', { loose: true })).toBe('案内')
    expect(replaceInTelop('㍿テスト', '株式会社', 'K', { loose: true })).toBe('Kテスト')
    expect(replaceInTelop('ｶﾞ', 'カ', 'X', { loose: true })).toBe('ｶﾞ')
    expect(replaceInTelop('ABCabc', 'b', '-', { loose: true })).toBe('A-Ca-c')
  })
})

describe('検索・置換は見えている文字で', () => {
  it('強調の印をはさんだ文字も、一覧に見えているとおりに探せる。印の「*」では見つからない', () => {
    expect(telopMatches('完食まで**3皿**', '完食まで3皿')).toBe(true)
    expect(telopMatches('完食まで**3皿**', 'まで3')).toBe(true)
    expect(telopMatches('完食まで**3皿**', '*')).toBe(false)
    expect(telopMatches('雲丹《うに》', 'うに')).toBe(false)
  })

  it('置き換えても、装飾の印・ルビの読みは残す', () => {
    expect(replaceInTelop('完食まで**3皿**', 'まで3', 'まで5')).toBe('完食まで5**皿**')
    expect(replaceInTelop('完食まで**3皿**', '*', '')).toBe('完食まで**3皿**')
    expect(replaceInTelop('雲丹《うに》を食べる', '食べる', 'いただく')).toBe(
      '雲丹《うに》をいただく'
    )
    expect(replaceInTelop('__小__と**大**', '小と大', '中')).toBe('__中__')
  })
})

describe('置き換えで見えている文字・印を壊さない', () => {
  it('強調の中の「____」・小さい文字の中の「****」は見えている文字なので残す', () => {
    expect(replaceInTelop('**名前:____**', '名前', '氏名')).toBe('**氏名:____**')
    expect(replaceInTelop('__a****b__', 'a', 'c')).toBe('__c****b__')
  })

  it('置き換えた結果が新しい印になって見えている文字が変わるなら、置き換えない', () => {
    expect(replaceInTelop('か_a_ｶか', 'a', '')).toBe('か_a_ｶか')
  })

  it('近くの文字の「*」「_」の装飾(強調・小さく)が変わる置き換えはしない', () => {
    expect(replaceInTelop('XX*X**か', 'X', '')).toBe('XX*X**か')
    expect(replaceInTelop('か_X__\n', 'X', '')).toBe('か_X__\n')
  })

  it('100 時間をまたぐ字幕も書き出す', () => {
    expect(buildSrt([{ text: 'x', startTime: 359999.5, endTime: 360000.5 }])).toContain(
      '99:59:59,500 --> 100:00:00,500'
    )
  })
})

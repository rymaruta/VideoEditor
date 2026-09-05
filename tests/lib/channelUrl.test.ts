import { describe, expect, it } from 'vitest'
import { describeChannelRef, parseChannelInput, type ChannelRef } from '@renderer/lib/channelUrl'
import { NASTY_VALUES } from '../helpers/boundary'

const parse = (input: string): ChannelRef | null => parseChannelInput(input)

describe('parseChannelInput — 貼られた「なにか」を手がかりに変える', () => {
  it('ハンドルのURL', () => {
    expect(parse('https://www.youtube.com/@HikakinTV')).toEqual({
      kind: 'handle',
      value: '@HikakinTV'
    })
  })

  it('ハンドルURLの後ろにタブが付いていても先頭だけ見る', () => {
    expect(parse('https://www.youtube.com/@HikakinTV/shorts')).toEqual({
      kind: 'handle',
      value: '@HikakinTV'
    })
    expect(parse('https://www.youtube.com/@HikakinTV/videos?view=0')).toEqual({
      kind: 'handle',
      value: '@HikakinTV'
    })
  })

  it('ハンドルだけを貼っても通る', () => {
    expect(parse('@HikakinTV')).toEqual({ kind: 'handle', value: '@HikakinTV' })
  })

  it('チャンネルIDのURLと、IDだけ', () => {
    const id = 'UCZf__ehlCEBPop-_sldpBUQ'
    expect(parse(`https://www.youtube.com/channel/${id}`)).toEqual({ kind: 'channelId', value: id })
    expect(parse(id)).toEqual({ kind: 'channelId', value: id })
  })

  it('旧 /user/ と 旧 /c/', () => {
    expect(parse('https://www.youtube.com/user/PewDiePie')).toEqual({
      kind: 'legacyUser',
      value: 'PewDiePie'
    })
    expect(parse('https://www.youtube.com/c/SomeName')).toEqual({
      kind: 'customName',
      value: 'SomeName'
    })
  })

  it('動画のURLは、その投稿チャンネルへの手がかりになる', () => {
    expect(parse('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      kind: 'videoId',
      value: 'dQw4w9WgXcQ'
    })
    expect(parse('https://youtu.be/dQw4w9WgXcQ?t=42')).toEqual({
      kind: 'videoId',
      value: 'dQw4w9WgXcQ'
    })
    expect(parse('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({
      kind: 'videoId',
      value: 'dQw4w9WgXcQ'
    })
    expect(parse('https://www.youtube.com/live/dQw4w9WgXcQ')).toEqual({
      kind: 'videoId',
      value: 'dQw4w9WgXcQ'
    })
  })

  it('共有リンクに付く ?si= を無視する', () => {
    expect(parse('https://youtu.be/dQw4w9WgXcQ?si=abcdEFGH1234')).toEqual({
      kind: 'videoId',
      value: 'dQw4w9WgXcQ'
    })
  })

  it('スキームが無い貼り方・m. や music. でも通る', () => {
    expect(parse('youtube.com/@abc')).toEqual({ kind: 'handle', value: '@abc' })
    expect(parse('m.youtube.com/@abc')).toEqual({ kind: 'handle', value: '@abc' })
    expect(parse('https://music.youtube.com/channel/UCZf__ehlCEBPop-_sldpBUQ')).toEqual({
      kind: 'channelId',
      value: 'UCZf__ehlCEBPop-_sldpBUQ'
    })
  })

  it('前後の空白は落とす', () => {
    expect(parse('  https://www.youtube.com/@abc  ')).toEqual({ kind: 'handle', value: '@abc' })
  })

  it('%40 で貼られたハンドルも読む', () => {
    expect(parse('https://www.youtube.com/%40abc')).toEqual({ kind: 'handle', value: '@abc' })
  })

  it('【この回の主題】チャンネル名をそのまま貼ったら検索語として受ける', () => {
    // ここで「URLが不正です」と突き返すのはこちらの都合。名前を貼る人は多い
    expect(parse('ゲーム実況チャンネル')).toEqual({ kind: 'query', value: 'ゲーム実況チャンネル' })
  })

  it('YouTube以外のURLは手がかりにならない(検索語にもしない)', () => {
    expect(parse('https://example.com/@abc')).toBeNull()
    expect(parse('https://twitter.com/someone')).toBeNull()
  })

  it('YouTubeでも、チャンネルを指していないURLは null', () => {
    expect(parse('https://www.youtube.com/')).toBeNull()
    expect(parse('https://www.youtube.com/feed/subscriptions')).toBeNull()
    expect(parse('https://www.youtube.com/watch?v=short')).toBeNull()
    expect(parse('https://www.youtube.com/channel/NOTACHANNELID')).toBeNull()
  })

  it('空・空白だけは null', () => {
    expect(parse('')).toBeNull()
    expect(parse('   ')).toBeNull()
  })

  it('何を渡しても落ちない', () => {
    for (const v of NASTY_VALUES) {
      expect(() => parseChannelInput(v as string)).not.toThrow()
    }
  })
})

describe('describeChannelRef — 何として解釈したかを利用者に見せる', () => {
  it('すべての種類に言い方がある', () => {
    const refs: ChannelRef[] = [
      { kind: 'channelId', value: 'UC1' },
      { kind: 'handle', value: '@a' },
      { kind: 'legacyUser', value: 'u' },
      { kind: 'customName', value: 'c' },
      { kind: 'videoId', value: 'v' },
      { kind: 'query', value: 'q' }
    ]
    for (const ref of refs) {
      expect(describeChannelRef(ref).length).toBeGreaterThan(0)
    }
  })
})

/**
 * 貼り付けられた「なにか」から、YouTube のチャンネルを指す手がかりを取り出す。
 *
 * 利用者が持ってくる文字列は一定しない。ブラウザのURL欄、共有メニュー、動画の
 * リンク、アプリからのコピー(`?si=` が付く)、ハンドルだけ、チャンネル名だけ——
 * **どれで来ても同じ結果に着く**のがこの画面の入口の役目で、ここで受け付けられない
 * 形が1つあると、利用者にとっては「動かないアプリ」になる。
 *
 * ここでは**判別だけ**を行い、APIは呼ばない(呼ぶのは `youtube.ts`)。
 * 判別を純粋な関数に切り出してあるので、対応する形はテストで一覧にできる。
 */

export type ChannelRef =
  /** UC から始まるチャンネルID。そのまま `channels.list?id=` で引ける */
  | { kind: 'channelId'; value: string }
  /** @ で始まるハンドル。`channels.list?forHandle=` で引ける */
  | { kind: 'handle'; value: string }
  /** 旧 /user/ 形式。`channels.list?forUsername=` で引ける */
  | { kind: 'legacyUser'; value: string }
  /** 旧 /c/ 形式。専用の引き方が無いので検索に回す */
  | { kind: 'customName'; value: string }
  /** 動画のURL。動画からチャンネルを引き当てる */
  | { kind: 'videoId'; value: string }
  /** ただの語。検索に回す */
  | { kind: 'query'; value: string }

const CHANNEL_ID = /^UC[\w-]{22}$/
const VIDEO_ID = /^[\w-]{11}$/

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'gaming.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com'
])
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be'])

/** `%40name` のような形で貼られることがある。壊れた並びは触らずそのまま返す */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function fromPath(segments: string[], searchParams: URLSearchParams): ChannelRef | null {
  const [first, second] = segments
  if (!first) return null

  // /watch?v=ID —— 動画から辿る
  if (first === 'watch') {
    const v = searchParams.get('v') ?? ''
    return VIDEO_ID.test(v) ? { kind: 'videoId', value: v } : null
  }
  // /shorts/ID, /live/ID, /embed/ID, /v/ID
  if (['shorts', 'live', 'embed', 'v'].includes(first)) {
    return second && VIDEO_ID.test(second) ? { kind: 'videoId', value: second } : null
  }
  if (first === 'channel') {
    return second && CHANNEL_ID.test(second) ? { kind: 'channelId', value: second } : null
  }
  if (first === 'user') {
    return second ? { kind: 'legacyUser', value: second } : null
  }
  if (first === 'c') {
    return second ? { kind: 'customName', value: second } : null
  }
  // /@handle(/videos や /shorts が続いても先頭だけ見る)
  if (first.startsWith('@') && first.length > 1) {
    return { kind: 'handle', value: first }
  }
  return null
}

/**
 * 入力を1つの手がかりに変換する。空なら `null`。
 *
 * URLとして読めないものは**捨てずに検索語として返す**。チャンネル名をそのまま
 * 貼る人は多く、そこで「URLが不正です」と突き返すのは、こちらの都合でしかない。
 */
export function parseChannelInput(input: string): ChannelRef | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed === '') return null

  // URL でない書き方を先に拾う
  if (CHANNEL_ID.test(trimmed)) return { kind: 'channelId', value: trimmed }
  if (trimmed.startsWith('@') && trimmed.length > 1 && !/\s/.test(trimmed)) {
    return { kind: 'handle', value: decode(trimmed) }
  }

  // 「youtube.com/@x」のようにスキームが無い貼り方が多いので補う
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL | null = null
  try {
    url = new URL(withScheme)
  } catch {
    url = null
  }

  if (url) {
    const host = url.hostname.toLowerCase()
    const segments = url.pathname
      .split('/')
      .filter((s) => s !== '')
      .map(decode)
    if (SHORT_HOSTS.has(host)) {
      const id = segments[0] ?? ''
      return VIDEO_ID.test(id) ? { kind: 'videoId', value: id } : null
    }
    if (YOUTUBE_HOSTS.has(host)) {
      return fromPath(segments, url.searchParams)
    }
    // YouTube 以外のURLは、チャンネルの手がかりにならない
    if (host.includes('.')) return null
  }

  return { kind: 'query', value: trimmed }
}

/** 画面に出すときの短い言い方(何として解釈したかを利用者に見せる) */
export function describeChannelRef(ref: ChannelRef): string {
  switch (ref.kind) {
    case 'channelId':
      return `チャンネルID ${ref.value}`
    case 'handle':
      return `ハンドル ${ref.value}`
    case 'legacyUser':
      return `旧ユーザー名 ${ref.value}`
    case 'customName':
      return `カスタムURL ${ref.value}(検索で特定します)`
    case 'videoId':
      return `動画 ${ref.value} の投稿チャンネル`
    case 'query':
      return `「${ref.value}」で検索`
  }
}

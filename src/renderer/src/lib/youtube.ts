import { asArray, fetchJson } from './httpJson'
import type { ChannelRef } from './channelUrl'
export interface YouTubeVideoInfo {
  id: string
  title: string
  channelTitle: string
  thumbnailUrl: string
  durationSeconds: number
  viewCount: number
  publishedAt: string
}

interface ApiThumbnails {
  default?: { url: string }
  medium?: { url: string }
}

interface ApiSnippet {
  title: string
  channelTitle: string
  publishedAt?: string
  thumbnails?: ApiThumbnails
}

interface VideosListItem {
  id: string
  // snippet / contentDetails are only present when the API actually returned that
  // part for this video; typing them as required hid the crash below from tsc.
  snippet?: ApiSnippet
  contentDetails?: { duration: string }
  statistics?: { viewCount?: string }
}

interface SearchListItem {
  id?: { videoId?: string }
  snippet?: ApiSnippet
}

interface ApiError {
  error?: { message?: string }
}

function parseIsoDuration(iso: string): number {
  const match = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso)
  if (!match) return 0
  const h = Number(match[1] ?? 0)
  const m = Number(match[2] ?? 0)
  const s = Number(match[3] ?? 0)
  return h * 3600 + m * 60 + s
}

function pickThumbnail(thumbnails: ApiThumbnails | undefined): string {
  return thumbnails?.medium?.url ?? thumbnails?.default?.url ?? ''
}

// The API omits parts for videos that went private or were deleted between the chart
// query and the response, and `items` can carry nulls. Reading `item.snippet.title`
// straight off such an entry threw "Cannot read properties of undefined", and because
// it happened inside `.map()` it took the **whole list** down — the trend panel showed
// a raw JS error instead of the other 14 videos. Skip the unusable entry instead.
// (`statistics` was already treated as optional: YouTube hides view counts on request.)
function toVideoInfo(
  item: VideosListItem | null | undefined,
  details?: { duration: number; views: number }
): YouTubeVideoInfo | null {
  if (!item?.id || !item.snippet) return null
  return {
    id: item.id,
    title: item.snippet.title ?? '',
    channelTitle: item.snippet.channelTitle ?? '',
    thumbnailUrl: pickThumbnail(item.snippet.thumbnails),
    durationSeconds: details?.duration ?? parseIsoDuration(item.contentDetails?.duration ?? ''),
    viewCount: details?.views ?? Number(item.statistics?.viewCount ?? 0),
    publishedAt: item.snippet.publishedAt ?? ''
  }
}

function isPresent<T>(value: T | null): value is T {
  return value !== null
}

async function fetchVideoDetails(
  apiKey: string,
  ids: string[]
): Promise<Map<string, { duration: number; views: number }>> {
  if (ids.length === 0) return new Map()
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids.join(',')}&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  const map = new Map<string, { duration: number; views: number }>()
  for (const item of asArray(data.items) as VideosListItem[]) {
    if (!item?.id) continue
    map.set(item.id, {
      duration: parseIsoDuration(item.contentDetails?.duration ?? ''),
      views: Number(item.statistics?.viewCount ?? 0)
    })
  }
  return map
}

export async function fetchTrendingVideos(apiKey: string): Promise<YouTubeVideoInfo[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=JP&maxResults=15&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  return (asArray(data.items) as VideosListItem[])
    .map((item) => toVideoInfo(item))
    .filter(isPresent)
}

const GAMING_CATEGORY_ID = '20'

/**
 * 候補を探す元になる一覧。**上限いっぱいの50件**を取る。
 *
 * `chart=mostPopular` の1回は25件でも50件でも**消費は同じ1ユニット**なのに、
 * 25件だと1ゲームあたり2〜3本しか集まらず、「何チャンネルが出しているか」で
 * 見分けようとしても差が付かない(件数が少ないほど、たまたま並んだ1本で
 * 順位が入れ替わる)。母数を広げるのがいちばん安い精度の上げ方。
 */
export async function fetchTrendingGamingVideos(apiKey: string): Promise<YouTubeVideoInfo[]> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&chart=mostPopular&regionCode=JP&videoCategoryId=${GAMING_CATEGORY_ID}&maxResults=50&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
    url,
    undefined,
    'YouTube API'
  )
  return (asArray(data.items) as VideosListItem[])
    .map((item) => toVideoInfo(item))
    .filter(isPresent)
}

/**
 * `search.list` に載せられる絞り込み。
 *
 * **`publishedAfter` が要点。** 「いま伸びているか」を測るのに、期間を切らない検索は
 * 使えない——`order=viewCount` は**何年前の動画でも**再生数が多ければ上に出すので、
 * 5年前の名作がそのまま「今のトレンド」として返ってくる。
 */
export interface VideoSearchOptions {
  /** この時刻より後に公開された動画だけ(RFC3339)。`Date` を渡してもよい */
  publishedAfter?: Date | string
  /** YouTube 側の粗い尺の区分。`short` は「4分未満」なので、正確な尺は呼び出し側で見直す */
  videoDuration?: 'any' | 'short' | 'medium' | 'long'
  order?: 'relevance' | 'viewCount' | 'date' | 'rating'
  maxResults?: number
  regionCode?: string
  relevanceLanguage?: string
}

function toRfc3339(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value
}

function buildSearchParams(query: string, apiKey: string, options: VideoSearchOptions): string {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    order: options.order ?? 'viewCount',
    maxResults: String(options.maxResults ?? 15),
    q: query,
    key: apiKey
  })
  if (options.publishedAfter) params.set('publishedAfter', toRfc3339(options.publishedAfter))
  if (options.videoDuration && options.videoDuration !== 'any') {
    params.set('videoDuration', options.videoDuration)
  }
  if (options.regionCode) params.set('regionCode', options.regionCode)
  if (options.relevanceLanguage) params.set('relevanceLanguage', options.relevanceLanguage)
  return params.toString()
}

export async function searchVideos(
  apiKey: string,
  query: string,
  options: VideoSearchOptions = {}
): Promise<YouTubeVideoInfo[]> {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?${buildSearchParams(query, apiKey, options)}`
  const data = await fetchJson<ApiError & { items?: SearchListItem[] }>(
    searchUrl,
    undefined,
    'YouTube API'
  )
  const items = asArray(data.items) as SearchListItem[]
  const ids = items.map((i) => i?.id?.videoId).filter((id): id is string => Boolean(id))
  const details = await fetchVideoDetails(apiKey, ids)
  return items
    .map((item) => {
      const videoId = item?.id?.videoId
      if (!videoId) return null
      return toVideoInfo(
        { id: videoId, snippet: item.snippet },
        details.get(videoId) ?? { duration: 0, views: 0 }
      )
    })
    .filter(isPresent)
}

/**
 * 1つのゲームについて、**直近に公開されたショート**を取りに行く(裏取り用)。
 *
 * 急上昇のゲームカテゴリはほぼ長尺で、そこに名前が出たからといって
 * **ショートでも回っている**とは限らない。「今日ショートを1本撮るなら」の答えを
 * 出すには、そのゲームのショートが実際に何本あって、どれくらいの速さで回っているかを
 * 別途数える必要がある。
 *
 * `search.list` は再生数を返さないので、`videos.list` で実数を取り直す
 * (この2段構えは `searchVideos` と同じ)。尺の絞り込みは YouTube 側が「4分未満」と
 * 粗いため、本当にショートかどうかは戻り値の `durationSeconds` で判断すること。
 */
export async function searchRecentShorts(
  apiKey: string,
  gameName: string,
  windowDays: number,
  maxResults = 10
): Promise<YouTubeVideoInfo[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  return searchVideos(apiKey, gameName, {
    publishedAfter: since,
    videoDuration: 'short',
    order: 'viewCount',
    maxResults,
    regionCode: 'JP',
    relevanceLanguage: 'ja'
  })
}

// ── チャンネル ─────────────────────────────────────────────────────────────

export interface YouTubeChannelInfo {
  id: string
  title: string
  /** `@handle`。設定していないチャンネルでは空 */
  handle: string
  description: string
  thumbnailUrl: string
  publishedAt: string
  /** 非公開にしているチャンネルがある。0 と「非公開」は別物なので旗を分ける */
  subscriberCount: number
  subscriberCountHidden: boolean
  viewCount: number
  videoCount: number
  country: string
  /** 投稿動画がすべて入る再生リスト。ここから過去作を辿る */
  uploadsPlaylistId: string
  /** チャンネルの題材(Wikipedia のカテゴリURL)。外部調査の手がかりに使う */
  topicCategories: string[]
  keywords: string
}

interface ChannelListItem {
  id?: string
  snippet?: {
    title?: string
    description?: string
    customUrl?: string
    publishedAt?: string
    country?: string
    thumbnails?: ApiThumbnails
  }
  statistics?: {
    viewCount?: string
    subscriberCount?: string
    hiddenSubscriberCount?: boolean
    videoCount?: string
  }
  contentDetails?: { relatedPlaylists?: { uploads?: string } }
  topicDetails?: { topicCategories?: string[] }
  brandingSettings?: { channel?: { keywords?: string } }
}

const CHANNEL_PARTS = 'snippet,statistics,contentDetails,topicDetails,brandingSettings'

function toChannelInfo(item: ChannelListItem | null | undefined): YouTubeChannelInfo | null {
  if (!item?.id || !item.snippet) return null
  const customUrl = typeof item.snippet.customUrl === 'string' ? item.snippet.customUrl : ''
  return {
    id: item.id,
    title: item.snippet.title ?? '',
    handle: customUrl.startsWith('@') ? customUrl : customUrl ? `@${customUrl}` : '',
    description: item.snippet.description ?? '',
    thumbnailUrl: pickThumbnail(item.snippet.thumbnails),
    publishedAt: item.snippet.publishedAt ?? '',
    subscriberCount: Number(item.statistics?.subscriberCount ?? 0),
    subscriberCountHidden: item.statistics?.hiddenSubscriberCount === true,
    viewCount: Number(item.statistics?.viewCount ?? 0),
    videoCount: Number(item.statistics?.videoCount ?? 0),
    country: item.snippet.country ?? '',
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? '',
    topicCategories: Array.isArray(item.topicDetails?.topicCategories)
      ? item.topicDetails.topicCategories.filter((c): c is string => typeof c === 'string')
      : [],
    keywords: item.brandingSettings?.channel?.keywords ?? ''
  }
}

async function fetchChannelsBy(
  apiKey: string,
  param: string,
  value: string
): Promise<YouTubeChannelInfo[]> {
  const params = new URLSearchParams({ part: CHANNEL_PARTS, key: apiKey })
  params.set(param, value)
  const data = await fetchJson<ApiError & { items?: ChannelListItem[] }>(
    `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`,
    undefined,
    'YouTube API'
  )
  return (asArray(data.items) as ChannelListItem[]).map(toChannelInfo).filter(isPresent)
}

/** 複数のチャンネルをまとめて引く(比較用。IDは50件までを1回で) */
export async function fetchChannelsByIds(
  apiKey: string,
  ids: readonly string[]
): Promise<YouTubeChannelInfo[]> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))]
  if (unique.length === 0) return []
  const found: YouTubeChannelInfo[] = []
  for (let i = 0; i < unique.length; i += 50) {
    found.push(...(await fetchChannelsBy(apiKey, 'id', unique.slice(i, i + 50).join(','))))
  }
  return found
}

/** 動画IDからその投稿チャンネルのIDを引く */
async function fetchChannelIdOfVideo(apiKey: string, videoId: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`
  const data = await fetchJson<ApiError & { items?: { snippet?: { channelId?: string } }[] }>(
    url,
    undefined,
    'YouTube API'
  )
  const items = asArray(data.items) as { snippet?: { channelId?: string } }[]
  return items[0]?.snippet?.channelId ?? ''
}

async function searchChannelId(apiKey: string, query: string): Promise<string> {
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'channel',
    maxResults: '1',
    q: query,
    key: apiKey
  })
  const data = await fetchJson<
    ApiError & { items?: { id?: { channelId?: string }; snippet?: { channelId?: string } }[] }
  >(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`, undefined, 'YouTube API')
  const items = asArray(data.items) as {
    id?: { channelId?: string }
    snippet?: { channelId?: string }
  }[]
  return items[0]?.id?.channelId ?? items[0]?.snippet?.channelId ?? ''
}

/**
 * 貼られた手がかりから実際のチャンネルへ辿り着く。
 *
 * **ハンドルは `forHandle` で1ユニットで引ける**が、旧 `/c/` 形式とただの語には
 * 専用の引き方が無いので検索(100ユニット)に落ちる。落ちる経路をこの1箇所に
 * まとめてあるので、消費が増える条件が読める。
 * 見つからなければ、**何として解釈したかを添えて**日本語で投げる(「見つかりません」
 * だけだと、URLの写し間違いなのか非公開なのか区別が付かない)。
 */
export async function resolveChannel(apiKey: string, ref: ChannelRef): Promise<YouTubeChannelInfo> {
  let channels: YouTubeChannelInfo[] = []
  switch (ref.kind) {
    case 'channelId':
      channels = await fetchChannelsBy(apiKey, 'id', ref.value)
      break
    case 'handle':
      channels = await fetchChannelsBy(apiKey, 'forHandle', ref.value)
      break
    case 'legacyUser':
      channels = await fetchChannelsBy(apiKey, 'forUsername', ref.value)
      break
    case 'videoId': {
      const channelId = await fetchChannelIdOfVideo(apiKey, ref.value)
      if (channelId) channels = await fetchChannelsBy(apiKey, 'id', channelId)
      break
    }
    case 'customName':
    case 'query': {
      const channelId = await searchChannelId(apiKey, ref.value)
      if (channelId) channels = await fetchChannelsBy(apiKey, 'id', channelId)
      break
    }
  }
  // ハンドルは表記が変わっていることがある。最後の手段として検索に回す
  if (channels.length === 0 && (ref.kind === 'handle' || ref.kind === 'legacyUser')) {
    const channelId = await searchChannelId(apiKey, ref.value.replace(/^@/, ''))
    if (channelId) channels = await fetchChannelsBy(apiKey, 'id', channelId)
  }
  if (channels.length === 0) {
    throw new Error(
      `チャンネルが見つかりませんでした(${ref.kind === 'query' ? `検索語「${ref.value}」` : ref.value})。URLを貼り直すか、チャンネル名で検索してみてください。`
    )
  }
  return channels[0]
}

interface PlaylistItemsResponse {
  items?: { contentDetails?: { videoId?: string } }[]
  nextPageToken?: string
}

/** 投稿動画のIDを新しい順に集める(1ページ50件・1ユニット) */
async function fetchUploadVideoIds(
  apiKey: string,
  uploadsPlaylistId: string,
  max: number
): Promise<string[]> {
  const ids: string[] = []
  let pageToken = ''
  while (ids.length < max) {
    const params = new URLSearchParams({
      part: 'contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, max - ids.length)),
      key: apiKey
    })
    if (pageToken) params.set('pageToken', pageToken)
    const data = await fetchJson<ApiError & PlaylistItemsResponse>(
      `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`,
      undefined,
      'YouTube API'
    )
    const page = (asArray(data.items) as { contentDetails?: { videoId?: string } }[])
      .map((i) => i?.contentDetails?.videoId)
      .filter((id): id is string => typeof id === 'string' && id !== '')
    ids.push(...page)
    pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : ''
    if (!pageToken || page.length === 0) break
  }
  return ids.slice(0, max)
}

/** IDの一覧から実数(再生数・尺・公開日時)を取り直す。50件ずつ・1回1ユニット */
export async function fetchVideosByIds(
  apiKey: string,
  ids: readonly string[]
): Promise<YouTubeVideoInfo[]> {
  const videos: YouTubeVideoInfo[] = []
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${chunk.join(',')}&maxResults=50&key=${encodeURIComponent(apiKey)}`
    const data = await fetchJson<ApiError & { items?: VideosListItem[] }>(
      url,
      undefined,
      'YouTube API'
    )
    videos.push(
      ...(asArray(data.items) as VideosListItem[])
        .map((item) => toVideoInfo(item))
        .filter(isPresent)
    )
  }
  return videos
}

/**
 * チャンネルの投稿動画を、実数付きで新しい順に取る。
 *
 * 消費は**動画100本でも4ユニット**(再生リスト2回 + 実数2回)。検索(1回100)と
 * 違って桁違いに安いので、母数はけちらず取る——本数が少ないと「当たり動画」の
 * 基準になる中央値そのものが揺れて、分析が回ごとに違うことを言い出す。
 */
export async function fetchChannelVideos(
  apiKey: string,
  channel: YouTubeChannelInfo,
  max = 100
): Promise<YouTubeVideoInfo[]> {
  if (!channel.uploadsPlaylistId) return []
  const ids = await fetchUploadVideoIds(apiKey, channel.uploadsPlaylistId, max)
  return fetchVideosByIds(apiKey, ids)
}
